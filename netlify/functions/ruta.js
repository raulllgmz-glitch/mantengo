'use strict';
// Ruta del día para un cliente: sus servicios programados ese día, en orden de hora.
// Solo lectura. Cada cliente (tabla Marca) tiene su liga /r/<Código ruta>.
//
// POST /api/ruta   { code, d: 'hoy' | 'manana' | 'AAAA-MM-DD' }

const ACC = require('../lib/acceso');
const AT_BASE = process.env.AIRTABLE_BASE_ID || 'appqjYUAGBRIh6RHX';
const AT_TABLE = process.env.AIRTABLE_TABLE_ID || 'tbl77Z2y9GVqC30H0';
const AT_MARCA = process.env.AIRTABLE_MARCA_TABLE_ID || 'tbllwN1wnWuWbN5cY';
const CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const TZ = 'America/Mexico_City';

const M = { codigo: 'Código ruta', activo: 'Acceso ruta', nombre: 'Cliente Marca' };
const S = {
  fecha: 'Fecha Programada',
  fecha2: 'Fecha programada',
  lugar: 'Establecimiento',
  dir: 'Dirección',
  coords: 'Coordenadas',
  etapa: 'Etapa',
  cierre: 'Fecha de Cierre',
  tecnico: 'Técnico',
  cliente: 'Cliente',
  token: 'Token Público',
  active: 'Link activo',
  folio: 'Folio'
};

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
};
const reply = (statusCode, obj) => ({ statusCode, headers: HEADERS, body: JSON.stringify(obj) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const key = () => process.env.AIRTABLE_TOKEN || process.env.AIRTABLE_WRITE_TOKEN || '';

const clean = (v, max) =>
  String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

const mxDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Día pedido: hoy, mañana o una fecha dentro de un rango razonable.
function resolveDay(d, now) {
  const hoy = mxDate(now);
  const v = String(d || 'hoy');
  if (v === 'hoy') return hoy;
  if (v === 'manana') return addDays(hoy, 1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v) && v >= addDays(hoy, -30) && v <= addDays(hoy, 90) && !Number.isNaN(Date.parse(v))) return v;
  return hoy;
}

// Devuelve { dia: 'AAAA-MM-DD', min: minutos desde la medianoche o null si solo hay fecha }
function parseWhen(v) {
  const s = String(v || '');
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { dia: s, min: null };
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const dia = mxDate(t);
  const hm = new Date(t).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  const [h, m] = hm.split(':').map(Number);
  return { dia, min: (h % 24) * 60 + m };
}

function horaTexto(min) {
  if (min == null) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'a.m.' : 'p.m.'}`;
}

function parseCoords(v) {
  const m = String(v || '').match(/(-?\d{1,3}(?:\.\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (!m) return null;
  const lat = +m[1];
  const lon = +m[2];
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

function etapaNombre(f) {
  if (f[S.cierre]) return 'Terminado';
  const raw = f[S.etapa] && typeof f[S.etapa] === 'object' ? f[S.etapa].name : f[S.etapa];
  const n = norm(raw);
  if (n.includes('termin') || n.includes('cerrad')) return 'Terminado';
  if (n.includes('proceso')) return 'En proceso';
  if (n.includes('camino')) return 'En camino';
  if (n.includes('program')) return 'Programado';
  return 'Recibido';
}

async function atList(table, params, fields) {
  const url = new URL(`https://api.airtable.com/v0/${AT_BASE}/${table}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  fields.forEach((f) => url.searchParams.append('fields[]', f));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key()}` } });
  if (!res.ok) {
    const e = new Error(`Airtable respondió ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return (await res.json()).records || [];
}

async function listarServicios(prev, next) {
  const formula = `AND(IS_AFTER({${S.fecha}},'${prev}'),IS_BEFORE({${S.fecha}},'${next}'))`;
  let fields = [S.fecha, S.lugar, S.dir, S.coords, S.etapa, S.cierre, S.tecnico, S.cliente, S.token, S.active];
  for (let i = 0; i < 6; i++) {
    try {
      return await atList(AT_TABLE, { filterByFormula: formula, maxRecords: '100' }, fields);
    } catch (e) {
      // Un campo opcional que aún no existe se quita y se reintenta.
      if (e.status !== 422) throw e;
      const quitar = [S.tecnico, S.cierre, S.dir, S.coords].find((x) => fields.includes(x));
      if (!quitar) throw e;
      fields = fields.filter((x) => x !== quitar);
    }
  }
  throw new Error('Demasiados campos faltantes');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'metodo' });
  const h = event.headers || {};
  const host = h.host || h.Host || '';
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
  if (!key()) return reply(503, { error: 'config' });
  if (String(event.body || '').length > 2000) return reply(413, { error: 'tamano' });
  let b;
  try {
    b = JSON.parse(event.body || '{}');
  } catch (e) {
    return reply(400, { error: 'json' });
  }
  const code = String(b.code || '');
  const usaSesion = !!b.sesion;
  if (!usaSesion && (process.env.ALLOW_CODE_LINKS === 'false' || !CODE_RE.test(code))) {
    await wait(400);
    return reply(404, { error: 'codigo' });
  }

  try {
    let marca;
    if (usaSesion) {
      const r = await ACC.resolver(key(), b.sesion, [M.nombre], AT_MARCA);
      if (!r) return reply(401, { error: 'sesion' });
      marca = r.marca;
    } else {
      const marcas = await atList(
        AT_MARCA,
        { filterByFormula: `AND({${M.codigo}}='${code}',{${M.activo}})`, maxRecords: '1' },
        [M.nombre]
      );
      marca = marcas[0];
    }
    if (!marca) {
      await wait(400);
      return reply(404, { error: 'codigo' });
    }

    const dia = resolveDay(b.d, Date.now());
    const recs = await listarServicios(addDays(dia, -1), addDays(dia, 1));
    const paradas = [];
    for (const r of recs) {
      const f = r.fields || {};
      if (!(f[S.cliente] || []).includes(marca.id)) continue;
      const w = parseWhen(f[S.fecha] || f[S.fecha2]);
      if (!w || w.dia !== dia) continue;
      const tk = String(f[S.token] || '');
      const c = parseCoords(f[S.coords]);
      paradas.push({
        lat: c ? c.lat : null,
        lon: c ? c.lon : null,
        min: w.min,
        hora: horaTexto(w.min),
        lugar: clean(f[S.lugar], 120),
        dir: clean(f[S.dir], 200),
        etapa: etapaNombre(f),
        tecnico: clean(f[S.tecnico], 60),
        token: f[S.active] && TOKEN_RE.test(tk) ? tk : ''
      });
    }
    // Orden: por hora (las que solo traen fecha, al final). Con varias camionetas se agrupa por técnico
    // y cada una lleva su propia numeración.
    const porHora = (a, c) => (a.min == null ? 1e9 : a.min) - (c.min == null ? 1e9 : c.min) || a.lugar.localeCompare(c.lugar);
    const tecnicos = [...new Set(paradas.map((p) => p.tecnico).filter(Boolean))].sort();
    const varios = tecnicos.length > 1;
    if (varios) {
      paradas.sort((a, c) => (a.tecnico || '￿').localeCompare(c.tecnico || '￿') || porHora(a, c));
    } else {
      paradas.sort(porHora);
    }
    const cuenta = {};
    const out = paradas.map((p) => {
      const g = varios ? p.tecnico || '' : '';
      cuenta[g] = (cuenta[g] || 0) + 1;
      return {
        n: cuenta[g],
        g: varios ? Math.max(0, tecnicos.indexOf(p.tecnico)) : 0,
        hora: p.hora,
        lugar: p.lugar,
        dir: p.dir,
        etapa: p.etapa,
        tecnico: p.tecnico,
        lat: p.lat,
        lon: p.lon,
        token: p.token
      };
    });
    return reply(200, {
      ok: true,
      nombre: clean(marca.fields[M.nombre], 80),
      dia,
      hoy: mxDate(Date.now()),
      tecnicos,
      varios,
      paradas: out
    });
  } catch (e) {
    console.error('ruta', e && e.status, e && e.message);
    return reply(502, { error: 'airtable' });
  }
};

exports._test = { parseWhen, horaTexto, resolveDay, etapaNombre, addDays };
