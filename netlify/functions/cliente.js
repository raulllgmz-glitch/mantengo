'use strict';
// Portal del cliente: resumen de sus servicios y equipos. Solo con sesión (teléfono + PIN). Solo lectura.
//
// POST /api/cliente  { sesion }  →  { ok, usuario, marca, servicios: [...] }

const ACC = require('../lib/acceso');

const AT_BASE = process.env.AIRTABLE_BASE_ID || 'appqjYUAGBRIh6RHX';
const AT_TABLE = process.env.AIRTABLE_TABLE_ID || 'tbl77Z2y9GVqC30H0';
const AT_MARCA = process.env.AIRTABLE_MARCA_TABLE_ID || 'tbllwN1wnWuWbN5cY';
const REC_RE = /^rec[A-Za-z0-9]{14}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX = 100;

const S = {
  folio: 'Folio', tipo: 'Tipo de Servicio', lugar: 'Establecimiento', dir: 'Dirección', etapa: 'Etapa',
  prog: 'Fecha Programada', sol: 'Fecha Solicitada', cierre: 'Fecha de Cierre', serie: 'Serie',
  token: 'Token Público', active: 'Link activo'
};
const OPCIONALES = [S.sol, S.serie, S.prog, S.cierre, S.dir, S.tipo];

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff'
};
const reply = (statusCode, obj) => ({ statusCode, headers: HEADERS, body: JSON.stringify(obj) });
const key = () => process.env.AIRTABLE_TOKEN || process.env.AIRTABLE_WRITE_TOKEN || '';
const clean = (v, max) =>
  String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

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

async function listar(ids) {
  const formula = `OR(${ids.map((i) => `RECORD_ID()='${i}'`).join(',')})`;
  let fields = Object.values(S);
  for (let i = 0; i < 8; i++) {
    const url = new URL(`https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}`);
    url.searchParams.set('filterByFormula', formula);
    url.searchParams.set('maxRecords', String(MAX));
    fields.forEach((f) => url.searchParams.append('fields[]', f));
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key()}` } });
    if (res.ok) return (await res.json()).records || [];
    if (res.status === 422) {
      const quitar = OPCIONALES.find((x) => fields.includes(x));
      if (quitar) { fields = fields.filter((x) => x !== quitar); continue; }
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
    try { oh = new URL(origin).host; } catch (e) { /* origen inválido */ }
    if (oh !== host) return reply(403, { error: 'origen' });
  }
  if (!key()) return reply(503, { error: 'config' });
  if (String(event.body || '').length > 3000) return reply(413, { error: 'tamano' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'json' }); }

  try {
    const r = await ACC.resolver(key(), b.sesion, ['Cliente Marca', 'Servicios'], AT_MARCA);
    if (!r) return reply(401, { error: 'sesion' });
    const ids = ((r.marca.fields.Servicios) || []).filter((i) => REC_RE.test(i)).slice(-MAX);
    const recs = ids.length ? await listar(ids) : [];
    recs.sort((a, c) => String(c.createdTime).localeCompare(String(a.createdTime)));
    const servicios = recs.map((x) => {
      const f = x.fields || {};
      const tk = String(f[S.token] || '');
      return {
        folio: clean(f[S.folio], 40), tipo: clean(f[S.tipo], 60), lugar: clean(f[S.lugar], 120), dir: clean(f[S.dir], 200),
        etapa: etapaNombre(f), prog: clean(f[S.prog], 40), sol: clean(f[S.sol], 40), cierre: clean(f[S.cierre], 40),
        serie: clean(f[S.serie], 60), creado: clean(x.createdTime, 40), token: f[S.active] && TOKEN_RE.test(tk) ? tk : ''
      };
    });
    return reply(200, { ok: true, usuario: r.contacto.nombre, marca: clean(r.marca.fields['Cliente Marca'], 80), servicios });
  } catch (e) {
    console.error('cliente', e && e.status, e && e.message);
    return reply(502, { error: 'airtable' });
  }
};

exports._test = { etapaNombre };
