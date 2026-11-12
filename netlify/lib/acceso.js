'use strict';
// Sesiones por teléfono: el contacto recibe un PIN, y de ahí sabemos quién es y a qué marca pertenece.
// La sesión es un token firmado (HMAC) sin estado; en cada petición se vuelve a comprobar que el contacto siga activo.

const crypto = require('crypto');

const AT_BASE = process.env.AIRTABLE_BASE_ID || 'appqjYUAGBRIh6RHX';
const AT_CONTACTOS = process.env.AIRTABLE_CONTACTOS_TABLE || 'tblhCXgQRYrfjvDRN';
const C = { nombre: 'Nombre', tel: 'Teléfono', marca: 'Marca', activo: 'Activo', rol: 'Roll' };
const REC_RE = /^rec[A-Za-z0-9]{14}$/;
const DIAS = Number(process.env.SESION_DIAS) || 30;

const secret = () => process.env.SESSION_SECRET || '';
const b64 = (s) => Buffer.from(s).toString('base64url');
const mac = (s) => crypto.createHmac('sha256', secret()).update(s).digest('base64url');

function firmar(p) {
  const cuerpo = b64(JSON.stringify({ ...p, e: Math.floor(Date.now() / 1000) + DIAS * 86400 }));
  return `${cuerpo}.${mac(cuerpo)}`;
}

function leer(token) {
  if (!secret() || secret().length < 24) return null;
  const [cuerpo, firma] = String(token || '').split('.');
  if (!cuerpo || !firma) return null;
  const a = Buffer.from(mac(cuerpo));
  const b = Buffer.from(firma);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(cuerpo, 'base64url').toString());
    if (!p.e || p.e < Date.now() / 1000 || !REC_RE.test(p.c || '') || !REC_RE.test(p.m || '')) return null;
    return p;
  } catch (e) {
    return null;
  }
}

// Solo los 10 dígitos de México (acepta +52, espacios, guiones, 044/045).
function telDiez(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

async function at(key, path, params) {
  const url = new URL(`https://api.airtable.com/v0/${AT_BASE}/${path}`);
  Object.entries(params || {}).forEach(([k, v]) => (Array.isArray(v) ? v.forEach((x) => url.searchParams.append(k, x)) : url.searchParams.set(k, v)));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (res.status === 404) return null;
  if (!res.ok) {
    const e = new Error(`Airtable respondió ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

// Contacto registrado por teléfono (activo y con marca). null si no existe.
async function contactoPorTel(key, tel10) {
  const formula = `AND({${C.activo}},RIGHT(REGEX_REPLACE({${C.tel}}&'','[^0-9]',''),10)='${tel10}')`;
  const d = await at(key, encodeURIComponent(AT_CONTACTOS), {
    filterByFormula: formula,
    maxRecords: '1',
    'fields[]': [C.nombre, C.tel, C.marca, C.activo, C.rol]
  });
  const r = d && d.records && d.records[0];
  const m = r && (r.fields[C.marca] || [])[0];
  return r && REC_RE.test(m || '') ? { id: r.id, nombre: String(r.fields[C.nombre] || '').slice(0, 80), marca: m, rol: String(r.fields[C.rol] || '') } : null;
}

// Sesión → { contacto, marca (registro con los campos pedidos) } o null si ya no vale.
async function resolver(key, token, camposMarca, tablaMarca) {
  const p = leer(token);
  if (!p) return null;
  const c = await at(key, `${encodeURIComponent(AT_CONTACTOS)}/${p.c}`, { 'fields[]': [C.nombre, C.tel, C.marca, C.activo, C.rol] });
  if (!c || !c.fields[C.activo] || (c.fields[C.marca] || [])[0] !== p.m) return null;
  const m = await at(key, `${tablaMarca}/${p.m}`, { 'fields[]': camposMarca });
  if (!m) return null;
  return {
    contacto: { id: c.id, rol: String(c.fields[C.rol] || ''), nombre: String(c.fields[C.nombre] || '').slice(0, 80), tel: telDiez(c.fields[C.tel]) },
    marca: m
  };
}

module.exports = { firmar, leer, telDiez, contactoPorTel, resolver, REC_RE };
