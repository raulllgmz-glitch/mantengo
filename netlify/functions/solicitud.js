'use strict';
// App de solicitud de servicios. Cada cliente (tabla Marca) tiene una liga personal /n/<código>.
//
// POST /api/solicitud
//   { code, action: 'info' }                         → nombre del cliente, tipos y tiendas recientes
//   { code, action: 'crear', tipo, lugar, ... }      → crea el servicio (Etapa "Recibido")
//   { code, action: 'foto', token, data }            → agrega una foto (JPEG base64) al servicio recién creado
//
// Necesita AIRTABLE_WRITE_TOKEN (o AIRTABLE_TOKEN si ya puede escribir).

const crypto = require('crypto');

const AT_BASE = process.env.AIRTABLE_BASE_ID || 'appqjYUAGBRIh6RHX';
const AT_TABLE = process.env.AIRTABLE_TABLE_ID || 'tbl77Z2y9GVqC30H0';
const AT_MARCA = process.env.AIRTABLE_MARCA_TABLE_ID || 'tbllwN1wnWuWbN5cY';
const CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const REC_RE = /^rec[A-Za-z0-9]{14}$/;

const M = { codigo: 'Código solicitud', activo: 'Acceso activo', nombre: 'Cliente Marca', servicios: 'Servicios' };
const S = {
  token: 'Token Público',
  active: 'Link activo',
  folio: 'Folio',
  etapa: 'Etapa',
  cliente: 'Cliente',
  falla: 'Solicitud Falla',
  tipo: 'Tipo de Servicio',
  lugar: 'Establecimiento',
  dir: 'Dirección',
  coords: 'Coordenadas',
  contacto: 'Contacto',
  tel: 'Telefono',
  serie: 'Serie',
  fecha: 'Fecha solicitada',
  fotos: 'Fotos solicitud',
  evid: 'Evidencias'
};
// Si alguno de estos no existe en Airtable, se omite y se sigue (el resto es obligatorio).
const OPCIONALES = [S.tipo, S.dir, S.coords, S.contacto, S.tel, S.serie, S.fecha];

const TIPOS = [
  'Instalación',
  'Retiro o reubicación',
  'Reparación o mantenimiento',
  'Rehabilitación',
  'Logística y distribución'
];
const MAX_FOTOS = 5;
const MAX_POR_HORA = 8;

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
};
const reply = (statusCode, obj) => ({ statusCode, headers: HEADERS, body: JSON.stringify(obj) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const clean = (v, max) =>
  String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);

function apiKey() {
  return process.env.AIRTABLE_WRITE_TOKEN || process.env.AIRTABLE_TOKEN || '';
}
const auth = () => ({ Authorization: `Bearer ${apiKey()}` });

async function atList(table, params, fields) {
  const url = new URL(`https://api.airtable.com/v0/${AT_BASE}/${table}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  fields.forEach((f) => url.searchParams.append('fields[]', f));
  const res = await fetch(url, { headers: auth() });
  if (!res.ok) {
    const e = new Error(`Airtable respondió ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const data = await res.json();
  return data.records || [];
}

async function findMarca(code) {
  const recs = await atList(
    AT_MARCA,
    { filterByFormula: `AND({${M.codigo}}='${code}',{${M.activo}})`, maxRecords: '1' },
    [M.nombre, M.servicios]
  );
  return recs[0] || null;
}

// Últimos servicios del cliente (por los vínculos de la tabla Marca, sin armar fórmulas con texto libre).
async function serviciosDe(marca) {
  const ids = ((marca.fields && marca.fields[M.servicios]) || []).filter((i) => REC_RE.test(i)).slice(-40);
  if (!ids.length) return [];
  const formula = `OR(${ids.map((i) => `RECORD_ID()='${i}'`).join(',')})`;
  const recs = await atList(AT_TABLE, { filterByFormula: formula, maxRecords: '40' }, [
    S.lugar, S.dir, S.coords, S.contacto, S.tel, S.serie
  ]);
  return recs.sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)));
}

function parseCoords(s) {
  const m = String(s || '').match(/(-?\d{1,3}(?:\.\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (!m) return null;
  const lat = +m[1];
  const lon = +m[2];
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

function recientes(recs) {
  const seen = new Set();
  const out = [];
  for (const r of recs) {
    const f = r.fields || {};
    const lugar = clean(f[S.lugar], 120);
    if (!lugar) continue;
    const key = `${lugar}|${clean(f[S.dir], 200)}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const c = parseCoords(f[S.coords]);
    out.push({
      lugar,
      dir: clean(f[S.dir], 200),
      lat: c ? c.lat : null,
      lon: c ? c.lon : null,
      contacto: clean(f[S.contacto], 80),
      tel: clean(f[S.tel], 30),
      serie: clean(f[S.serie], 60)
    });
    if (out.length >= 8) break;
  }
  return out;
}

const mxDate = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * 86400e3);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
};

function fechaSolicitada(v) {
  const s = String(v || '');
  if (s === 'hoy') return mxDate(0);
  if (s === 'manana') return mxDate(1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const hoy = mxDate(0);
    const tope = mxDate(120);
    if (s >= hoy && s <= tope) return s;
  }
  return '';
}

async function crearRegistro(fields) {
  let campos = { ...fields };
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: campos })
    });
    if (res.ok) return res.json();
    if (res.status === 422) {
      let b = {};
      try {
        b = await res.json();
      } catch (e) {
        /* sin detalle */
      }
      const err = b.error || {};
      const m = String(err.message || '').match(/"([^"]+)"/);
      if (err.type === 'UNKNOWN_FIELD_NAME' && m && OPCIONALES.includes(m[1]) && m[1] in campos) {
        delete campos[m[1]];
        continue;
      }
    }
    const e = new Error(`Airtable respondió ${res.status}`);
    e.status = res.status;
    throw e;
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
  if (!apiKey()) return reply(503, { error: 'config' });
  if (String(event.body || '').length > 4600000) return reply(413, { error: 'tamano' });

  let b;
  try {
    b = JSON.parse(event.body || '{}');
  } catch (e) {
    return reply(400, { error: 'json' });
  }
  const action = String(b.action || '');
  if (!['info', 'crear', 'foto'].includes(action)) return reply(400, { error: 'accion' });
  if (action !== 'foto' && String(event.body || '').length > 6000) return reply(413, { error: 'tamano' });
  const code = String(b.code || '');
  if (!CODE_RE.test(code)) {
    await wait(400);
    return reply(404, { error: 'codigo' });
  }

  try {
    const marca = await findMarca(code);
    if (!marca) {
      await wait(400);
      return reply(404, { error: 'codigo' });
    }
    const nombre = clean(marca.fields[M.nombre], 80);

    if (action === 'info') {
      const recs = await serviciosDe(marca);
      return reply(200, { ok: true, nombre, tipos: TIPOS, recientes: recientes(recs) });
    }

    if (action === 'crear') {
      if (b.hp) return reply(200, { ok: true, folio: 'MTGO0', token: 'x'.repeat(32) }); // trampa para bots
      const tipo = TIPOS.includes(b.tipo) ? b.tipo : '';
      const lugar = clean(b.lugar, 120);
      const falla = clean(b.falla, 500);
      const dir = clean(b.dir, 200);
      const contacto = clean(b.contacto, 80);
      const tel = clean(b.tel, 30);
      const serie = clean(b.serie, 60);
      const telDigitos = tel.replace(/\D/g, '');
      if (!tipo) return reply(400, { error: 'tipo' });
      if (lugar.length < 2) return reply(400, { error: 'lugar' });
      if (falla.length < 3) return reply(400, { error: 'falla' });
      if (telDigitos && (telDigitos.length < 8 || telDigitos.length > 15)) return reply(400, { error: 'telefono' });
      let coords = '';
      if (b.lat != null && b.lon != null && b.lat !== '' && b.lon !== '') {
        const lat = Number(b.lat);
        const lon = Number(b.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
          return reply(400, { error: 'coordenadas' });
        }
        coords = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
      }

      // Límite por hora para que nadie llene tu tabla de solicitudes.
      const prev = await serviciosDe(marca);
      const hace1h = Date.now() - 3600e3;
      if (prev.filter((r) => Date.parse(r.createdTime) > hace1h).length >= MAX_POR_HORA) {
        return reply(429, { error: 'limite' });
      }

      const token = crypto.randomBytes(24).toString('base64url');
      const fields = {
        [S.token]: token,
        [S.active]: true,
        [S.etapa]: 'Recibido',
        [S.cliente]: [marca.id],
        [S.falla]: falla,
        [S.tipo]: tipo,
        [S.lugar]: lugar
      };
      if (dir) fields[S.dir] = dir;
      if (coords) fields[S.coords] = coords;
      if (contacto) fields[S.contacto] = contacto;
      if (tel) fields[S.tel] = tel;
      if (serie) fields[S.serie] = serie;
      const f = fechaSolicitada(b.fecha);
      if (f) fields[S.fecha] = f;

      const rec = await crearRegistro(fields);
      const folio = clean((rec.fields && rec.fields[S.folio]) || '', 40);
      return reply(200, { ok: true, folio, token });
    }

    // foto
    const token = String(b.token || '');
    const data = String(b.data || '');
    if (!CODE_RE.test(token)) return reply(400, { error: 'token' });
    if (data.length < 200 || data.length > 4400000 || !/^[A-Za-z0-9+/]+=*$/.test(data) || !data.startsWith('/9j/')) {
      return reply(400, { error: 'foto' });
    }
    const fq = { filterByFormula: `AND({${S.token}}='${token}',{${S.active}})`, maxRecords: '1' };
    let recs;
    try {
      recs = await atList(AT_TABLE, fq, [S.folio, S.etapa, S.cliente, S.fotos]);
    } catch (e) {
      if (e.status !== 422) throw e; // aún no existe el campo "Fotos solicitud"
      recs = await atList(AT_TABLE, fq, [S.folio, S.etapa, S.cliente]);
    }
    const rec = recs[0];
    const etapa = rec && rec.fields[S.etapa] ? String(rec.fields[S.etapa].name || rec.fields[S.etapa]) : '';
    if (!rec || !(rec.fields[S.cliente] || []).includes(marca.id) || etapa.toLowerCase() !== 'recibido') {
      await wait(400);
      return reply(404, { error: 'servicio' });
    }
    if (((rec.fields[S.fotos] || []).length) >= MAX_FOTOS) return reply(409, { error: 'maximo' });
    const nombreArchivo = `solicitud-${clean(rec.fields[S.folio] || 'servicio', 20).replace(/[^A-Za-z0-9_-]/g, '')}-${Date.now()}.jpg`;
    const subir = (campo) =>
      fetch(`https://content.airtable.com/v0/${AT_BASE}/${rec.id}/${encodeURIComponent(campo)}/uploadAttachment`, {
        method: 'POST',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: 'image/jpeg', file: data, filename: nombreArchivo })
      });
    let r = await subir(S.fotos);
    if (!r.ok && (r.status === 404 || r.status === 422)) r = await subir(S.evid);
    if (!r.ok) {
      console.error('solicitud foto', r.status);
      return reply(502, { error: 'airtable' });
    }
    return reply(200, { ok: true });
  } catch (e) {
    console.error('solicitud', e && e.status, e && e.message);
    return reply(502, { error: 'airtable' });
  }
};

exports._test = { parseCoords, recientes, fechaSolicitada, TIPOS };
