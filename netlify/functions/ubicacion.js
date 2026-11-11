'use strict';
// Recibe la posición del técnico y la guarda en Airtable.
// Es la ÚNICA función con permiso de escritura. Exige la clave del equipo (TRACK_KEY).
//
// POST /api/ubicacion   { token, key, action: 'info' | 'update' | 'stop', lat, lon }

const crypto = require('crypto');

const AT_BASE = process.env.AIRTABLE_BASE_ID || 'appqjYUAGBRIh6RHX';
const AT_TABLE = process.env.AIRTABLE_TABLE_ID || 'tbl77Z2y9GVqC30H0';
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

const F = {
  token: 'Token Público',
  active: 'Link activo',
  folio: 'Folio',
  lugar: 'Establecimiento',
  etapa: 'Etapa',
  camino: 'Hora en camino',
  cierre: 'Fecha de Cierre',
  lat: 'Lat técnico',
  lon: 'Lon técnico',
  upd: 'Ubicación actualizada',
  // Ficha del punto de venta (solo se devuelve con la clave del equipo). Nunca montos ni facturas.
  dir: 'Dirección',
  coords: 'Coordenadas',
  contacto: 'Contacto',
  tel: 'Telefono',
  falla: 'Solicitud Falla',
  serie: 'Serie',
  tipo: 'Tipo de Servicio',
  fachada: 'Fachada'
};
const PDV = [F.dir, F.coords, F.contacto, F.tel, F.falla, F.serie, F.tipo, F.fachada];

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
};
const reply = (statusCode, obj) => ({ statusCode, headers: HEADERS, body: JSON.stringify(obj) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

function sameKey(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Busca el servicio por su token. Los campos que aún no existen se quitan y se reintenta.
async function findRecord(token, apiKey, full) {
  let fields = [F.lugar, F.etapa, F.camino, F.cierre, ...(full ? PDV : [])];
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = new URL(`https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}`);
    // El token ya pasó TOKEN_RE: solo letras, números, - y _.
    url.searchParams.set('filterByFormula', `AND({${F.token}}='${token}',{${F.active}})`);
    url.searchParams.set('maxRecords', '1');
    [F.folio, ...fields].forEach((f) => url.searchParams.append('fields[]', f));
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (res.ok) {
      const data = await res.json();
      return (data.records && data.records[0]) || null;
    }
    if (res.status === 422) {
      let body = {};
      try {
        body = await res.json();
      } catch (e) {
        /* sin detalle */
      }
      const err = body.error || {};
      const m = String(err.message || '').match(/"([^"]+)"/);
      if (err.type === 'UNKNOWN_FIELD_NAME' && m && fields.includes(m[1])) {
        fields = fields.filter((x) => x !== m[1]);
        continue;
      }
    }
    const e = new Error(`Airtable respondió ${res.status}`);
    e.status = res.status;
    throw e;
  }
  throw new Error('Demasiados campos faltantes');
}

async function patchRecord(id, fields, apiKey) {
  return fetch(`https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}/${id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
}

async function errorType(res) {
  try {
    const b = await res.json();
    return (b.error && b.error.type) || '';
  } catch (e) {
    return '';
  }
}

function pdvInfo(f) {
  const t = (v) => (v == null ? '' : String(v).trim().slice(0, 300));
  let lat = null;
  let lon = null;
  const m = String(f[F.coords] || '').match(/(-?\d{1,3}(?:\.\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180) {
    lat = +m[1];
    lon = +m[2];
  }
  const att = Array.isArray(f[F.fachada]) ? f[F.fachada][0] : null;
  let foto = '';
  if (att) {
    const big = att.thumbnails && att.thumbnails.large && att.thumbnails.large.url;
    foto = big || att.url || '';
    if (!/^https:\/\//.test(foto)) foto = '';
  }
  return {
    direccion: t(f[F.dir]),
    lat,
    lon,
    contacto: t(f[F.contacto]),
    telefono: t(f[F.tel]),
    falla: t(f[F.falla]),
    serie: t(f[F.serie]),
    tipo: t(f[F.tipo]),
    foto
  };
}

const round5 = (n) => Math.round(n * 1e5) / 1e5;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'metodo' });

  // Solo desde la propia página: si el navegador manda Origin, debe coincidir con el sitio.
  const h = event.headers || {};
  const host = h['x-forwarded-host'] || h.host || '';
  const origin = h.origin || h.Origin || '';
  if (origin && host) {
    let oh = '';
    try {
      oh = new URL(origin).host;
    } catch (e) {
      /* origen inválido */
    }
    if (oh !== host) return reply(403, { error: 'origen' });
  }

  const trackKey = process.env.TRACK_KEY;
  const apiKey = process.env.AIRTABLE_WRITE_TOKEN;
  if (!trackKey || !apiKey) return reply(503, { error: 'no_configurado' });

  if (String(event.body || '').length > 2000) return reply(413, { error: 'tamano' });
  let b = {};
  try {
    b = JSON.parse(event.body || '{}');
  } catch (e) {
    return reply(400, { error: 'json' });
  }

  if (!sameKey(b.key || '', trackKey)) {
    await wait(400); // frena adivinar la clave a ráfagas
    return reply(401, { error: 'clave' });
  }

  const token = String(b.token || '');
  if (!TOKEN_RE.test(token)) return reply(404, { error: 'servicio' });
  const action = String(b.action || 'update');
  if (!['info', 'update', 'stop'].includes(action)) return reply(400, { error: 'accion' });

  try {
    const rec = await findRecord(token, apiKey, action === 'info');
    if (!rec) return reply(404, { error: 'servicio' });
    const f = rec.fields || {};
    const etapaRaw = f[F.etapa];
    const etapa = etapaRaw && typeof etapaRaw === 'object' ? etapaRaw.name : etapaRaw || '';
    const e = norm(etapa);
    const info = { folio: f[F.folio] || '', lugar: f[F.lugar] || '', etapa };

    if (f[F.cierre] || e === 'terminado' || e === 'cerrado') return reply(409, { error: 'terminado', ...info });
    if (action === 'info') return reply(200, { ok: true, ...info, pdv: pdvInfo(f) });

    if (action === 'stop') {
      const r = await patchRecord(rec.id, { [F.lat]: null, [F.lon]: null, [F.upd]: null }, apiKey);
      if (!r.ok) return fail(r);
      return reply(200, { ok: true, detenido: true, ...info });
    }

    // El técnico ya llegó (en proceso): se deja de compartir la posición.
    if (e === 'en proceso') return reply(200, { ok: true, llego: true, ...info });

    const lat = Number(b.lat);
    const lon = Number(b.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return reply(400, { error: 'coordenadas' });
    }

    const base = { [F.lat]: round5(lat), [F.lon]: round5(lon), [F.upd]: new Date().toISOString() };
    // El primer aviso marca el servicio "En camino" y guarda la hora de salida.
    const withStage = { ...base };
    if (e !== 'en camino') withStage[F.etapa] = 'En camino';
    if (!f[F.camino]) withStage[F.camino] = new Date().toISOString();

    // Se intenta lo más completo y, si Airtable rechaza algún campo (422), se va quitando lo opcional:
    // 1) posición + etapa + hora, 2) posición + etapa, 3) solo posición.
    const attempts = [withStage];
    if (F.camino in withStage && F.etapa in withStage) attempts.push({ ...base, [F.etapa]: withStage[F.etapa] });
    if (Object.keys(withStage).length > Object.keys(base).length) attempts.push(base);
    let r;
    let used = 0;
    for (let i = 0; i < attempts.length; i++) {
      used = i;
      r = await patchRecord(rec.id, attempts[i], apiKey);
      if (r.ok || r.status !== 422) break;
    }
    // sinEtapa: debía cambiar a "En camino" y no se pudo.
    const sinEtapa = r.ok && e !== 'en camino' && !(F.etapa in attempts[used]);
    if (!r.ok) return fail(r);
    return reply(200, { ok: true, ...info, etapa: sinEtapa ? etapa : 'En camino', sinEtapa });
  } catch (err) {
    console.error('ubicacion:', err.message);
    return reply(502, { error: 'airtable' });
  }

  async function fail(res) {
    const type = await errorType(res);
    console.error('ubicacion PATCH', res.status, type);
    if (res.status === 422) return reply(422, { error: 'campos' });
    if (res.status === 401 || res.status === 403) return reply(502, { error: 'permiso' });
    return reply(502, { error: 'airtable' });
  }
};
