'use strict';
// Carga masiva de servicios desde una plantilla de Excel. Solo con sesión (teléfono + PIN).
//
// POST /api/masiva
//   { sesion, action: 'plantilla' }                → { ok, nombre, data (xlsx en base64) }
//   { sesion, action: 'validar', archivo }          → revisa el archivo, no crea nada
//   { sesion, action: 'crear', filas: [datos...] } → crea los servicios (se vuelve a validar todo)
//
// La marca y quién carga salen siempre de la sesión, nunca del archivo.

const crypto = require('crypto');
const ExcelJS = require('exceljs');
const ACC = require('../lib/acceso');
const { TIPOS, parseCoords } = require('./solicitud.js')._test;

const AT_BASE = process.env.AIRTABLE_BASE_ID || 'appqjYUAGBRIh6RHX';
const AT_TABLE = process.env.AIRTABLE_TABLE_ID || 'tbl77Z2y9GVqC30H0';
const AT_MARCA = process.env.AIRTABLE_MARCA_TABLE_ID || 'tbllwN1wnWuWbN5cY';
const MAX_FILAS = 200;
const MAX_ARCHIVO_B64 = 1500000;
const PRIMERA = 6; // primera fila de datos en la plantilla

const S = {
  token: 'Token Público', active: 'Link activo', etapa: 'Etapa', cliente: 'Cliente', falla: 'Solicitud Falla',
  tipo: 'Tipo de Servicio', lugar: 'Establecimiento', dir: 'Dirección', coords: 'Coordenadas', contacto: 'Contacto',
  tel: 'Telefono', serie: 'Serie', quienNombre: 'Contacto User', quienTel: 'Tel User', folio: 'Folio'
};
const OPCIONALES = [S.serie, S.quienNombre, S.quienTel, S.tipo, S.dir, S.coords, S.contacto, S.tel];

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff'
};
const reply = (statusCode, obj) => ({ statusCode, headers: HEADERS, body: JSON.stringify(obj) });
const apiKey = () => process.env.AIRTABLE_WRITE_TOKEN || process.env.AIRTABLE_TOKEN || '';

const clean = (v, max) =>
  String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[*]/g, '').trim();

// ---------- ubicación: coordenadas o link de Google Maps ----------
function coordsDeLink(u) {
  const s = decodeURIComponent(String(u || ''));
  const pats = [/@(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)/, /!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/,
    /[?&](?:q|ll|query|destination|center)=(-?\d{1,3}\.\d+)[, +]+(-?\d{1,3}\.\d+)/];
  for (const re of pats) {
    const m = s.match(re);
    if (m) {
      const lat = +m[1], lon = +m[2];
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
    }
  }
  return null;
}
const HOSTS_MAPS = /^(maps\.app\.goo\.gl|goo\.gl|(www\.)?google\.com(\.mx)?|maps\.google\.com(\.mx)?)$/;
const esLinkMaps = (s) => {
  try {
    const u = new URL(String(s).trim());
    return u.protocol === 'https:' && HOSTS_MAPS.test(u.hostname);
  } catch (e) {
    return false;
  }
};
// Sigue las redirecciones de un link corto (solo hacia Google) hasta encontrar coordenadas.
async function resolverLink(url, fin) {
  let u = String(url).trim();
  for (let i = 0; i < 5; i++) {
    const c = coordsDeLink(u);
    if (c) return c;
    if (!esLinkMaps(u) || Date.now() > fin) return null;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    try {
      const r = await fetch(u, { redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const loc = r.headers.get('location');
      if (!loc) return null;
      u = new URL(loc, u).toString();
    } catch (e) {
      return null;
    } finally {
      clearTimeout(t);
    }
  }
  return coordsDeLink(u);
}

// ---------- validación de una fila ----------
function tipoValido(v) {
  const n = norm(v);
  return TIPOS.find((t) => norm(t) === n) || '';
}

function normalizar(raw) {
  const errores = [];
  const avisos = [];
  const tipo = tipoValido(raw.tipo);
  const lugar = clean(raw.lugar, 120);
  const falla = clean(raw.falla, 500);
  let dir = clean(raw.dir, 200);
  const contacto = clean(raw.contacto, 80);
  const tel = clean(raw.tel, 30);
  const serie = clean(raw.serie, 60);
  if (!tipo) errores.push('Tipo de servicio no válido (elige uno de la lista)');
  if (lugar.length < 2) errores.push('Falta el establecimiento');
  if (falla.length < 3) errores.push('Falta la solicitud o falla');
  const d = tel.replace(/\D/g, '');
  if (d && (d.length < 8 || d.length > 15)) errores.push('Teléfono no válido');
  let lat = null, lon = null;
  const c = Number.isFinite(Number(raw.lat)) && raw.lat !== '' && raw.lat != null && raw.lon !== '' && raw.lon != null
    ? { lat: Number(raw.lat), lon: Number(raw.lon) } : parseCoords(raw.coords);
  if (c && Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180) { lat = c.lat; lon = c.lon; }
  else if (clean(raw.coords, 200)) avisos.push('No se entendieron las coordenadas');
  if (lat == null && !dir) errores.push('Falta la dirección, las coordenadas o un link de Google Maps');
  return { errores, avisos, datos: { tipo, lugar, falla, dir, lat, lon, contacto, tel, serie } };
}

// ---------- plantilla ----------
const COLS = [
  ['Tipo de servicio *', 26], ['Establecimiento *', 30], ['Solicitud Falla *', 38],
  ['Dirección o link de Google Maps', 42], ['Coordenadas (lat, lon)', 26], ['Contacto', 22], ['Telefono', 16], ['Serie del equipo', 20]
];

async function plantilla(nombreMarca, quien) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MantenGO';
  const ws = wb.addWorksheet('Servicios', { views: [{ state: 'frozen', ySplit: PRIMERA - 1 }] });
  ws.columns = COLS.map(([, w]) => ({ width: w }));
  const naranja = 'FFF5A623', oscuro = 'FF0F1B24';
  ws.mergeCells('A1:H1');
  ws.getCell('A1').value = 'Carga masiva de servicios · MantenGO';
  ws.getCell('A1').font = { bold: true, size: 15, color: { argb: oscuro } };
  ws.getCell('A2').value = 'Marca';
  ws.getCell('B2').value = nombreMarca;
  ws.getCell('A3').value = 'Cargado por';
  ws.getCell('B3').value = `${quien.nombre}${quien.tel ? ' · ' + quien.tel : ''}`;
  ['A2', 'A3'].forEach((a) => (ws.getCell(a).font = { bold: true }));
  ['B2', 'B3'].forEach((a) => (ws.getCell(a).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EDF1' } }));
  ws.mergeCells('A4:H4');
  ws.getCell('A4').value = 'Una fila por servicio, a partir de la fila 6. * obligatorio. En ubicación basta con la dirección, las coordenadas o un link de Google Maps. La marca y quién carga se registran solos.';
  ws.getCell('A4').font = { italic: true, size: 10, color: { argb: 'FF5A6B78' } };
  ws.getCell('A4').alignment = { wrapText: true, vertical: 'top' };
  ws.getRow(4).height = 30;
  const h = ws.getRow(PRIMERA - 1);
  COLS.forEach(([t], i) => {
    const c = h.getCell(i + 1);
    c.value = t;
    c.font = { bold: true, color: { argb: oscuro } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: naranja } };
    c.alignment = { vertical: 'middle', wrapText: true };
  });
  h.height = 28;
  for (let r = PRIMERA; r < PRIMERA + MAX_FILAS; r++) {
    for (let c = 1; c <= 8; c++) {
      const cell = ws.getCell(r, c);
      cell.protection = { locked: false };
      if (c === 7 || c === 8) cell.numFmt = '@';
    }
  }
  ws.dataValidations.add(`A${PRIMERA}:A${PRIMERA + MAX_FILAS - 1}`, {
    type: 'list', allowBlank: true, formulae: [`"${TIPOS.join(',')}"`], showErrorMessage: true,
    errorStyle: 'stop', errorTitle: 'Tipo de servicio', error: 'Elige un tipo de la lista.'
  });
  await ws.protect(undefined, { selectLockedCells: true, selectUnlockedCells: true, formatColumns: true, formatRows: true });
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf).toString('base64');
}

// ---------- lectura del archivo ----------
function textoCelda(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((x) => x.text).join('');
    if (v.hyperlink) return String(v.hyperlink || v.text || '');
    if (v.result != null) return textoCelda(v.result);
    if (v.text) return String(v.text);
    if (v instanceof Date) return '';
    return '';
  }
  return String(v);
}

const ALIAS = {
  tipo: ['tipo de servicio', 'tipo'], lugar: ['establecimiento'], falla: ['solicitud falla', 'falla', 'solicitud'],
  dir: ['direccion o link de google maps', 'direccion', 'direccion o link'], coords: ['coordenadas (lat, lon)', 'coordenadas'],
  contacto: ['contacto'], tel: ['telefono'], serie: ['serie del equipo', 'serie']
};

async function leerArchivo(b64) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(b64, 'base64'));
  const ws = wb.getWorksheet('Servicios') || wb.worksheets[0];
  if (!ws) throw Object.assign(new Error('sin hoja'), { codigo: 'archivo' });
  let hdr = 0;
  const idx = {};
  for (let r = 1; r <= 12 && !hdr; r++) {
    const m = {};
    ws.getRow(r).eachCell((cell, c) => {
      const n = norm(textoCelda(cell.value));
      for (const k of Object.keys(ALIAS)) if (!m[k] && ALIAS[k].includes(n)) m[k] = c;
    });
    if (m.lugar && m.falla) { hdr = r; Object.assign(idx, m); }
  }
  if (!hdr) throw Object.assign(new Error('sin encabezados'), { codigo: 'plantilla' });
  const filas = [];
  for (let r = hdr + 1; r <= ws.rowCount && r <= hdr + 1000; r++) {
    const row = ws.getRow(r);
    const raw = {};
    let alguno = false;
    for (const k of Object.keys(ALIAS)) {
      raw[k] = idx[k] ? textoCelda(row.getCell(idx[k]).value).trim() : '';
      if (raw[k]) alguno = true;
    }
    if (alguno) filas.push({ fila: r, raw });
  }
  return filas;
}

// ---------- Airtable ----------
async function crearLote(registros) {
  let campos = registros.map((f) => ({ fields: { ...f } }));
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: campos })
    });
    if (res.ok) return (await res.json()).records || [];
    if (res.status === 422) {
      let b = {};
      try { b = await res.json(); } catch (e) { /* sin detalle */ }
      const err = b.error || {};
      const m = String(err.message || '').match(/"([^"]+)"/);
      if (err.type === 'UNKNOWN_FIELD_NAME' && m && OPCIONALES.includes(m[1])) {
        campos = campos.map((c) => { const f = { ...c.fields }; delete f[m[1]]; return { fields: f }; });
        continue;
      }
    }
    const e = new Error(`Airtable respondió ${res.status}`);
    e.status = res.status;
    throw e;
  }
  throw new Error('Demasiados campos faltantes');
}

// Revisa todas las filas: errores propios y repetidas dentro del archivo.
function revisar(items) {
  const vistos = new Map();
  return items.map(({ fila, raw }) => {
    const n = normalizar(raw);
    const k = `${norm(n.datos.lugar)}|${norm(n.datos.falla)}|${n.datos.tipo}`;
    if (n.datos.lugar && n.datos.falla) {
      if (vistos.has(k)) n.errores.push(`Repetida (igual que la fila ${vistos.get(k)})`);
      else vistos.set(k, fila);
    }
    return { fila, ok: n.errores.length === 0, errores: n.errores, avisos: n.avisos, datos: n.datos };
  });
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
  if (!apiKey()) return reply(503, { error: 'config' });
  if (String(event.body || '').length > MAX_ARCHIVO_B64 + 2000) return reply(413, { error: 'tamano' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'json' }); }
  const action = String(b.action || '');
  if (!['plantilla', 'validar', 'crear'].includes(action)) return reply(400, { error: 'accion' });

  try {
    const r = await ACC.resolver(apiKey(), b.sesion, ['Cliente Marca'], AT_MARCA);
    if (!r) return reply(401, { error: 'sesion' });
    const roles = String(process.env.MASIVA_ROLES || '').split(',').map((x) => norm(x)).filter(Boolean);
    if (roles.length && !roles.includes(norm(r.contacto.rol))) return reply(403, { error: 'permiso' });
    const marca = r.marca;
    const nombreMarca = clean(marca.fields['Cliente Marca'], 80);

    if (action === 'plantilla') {
      const data = await plantilla(nombreMarca, r.contacto);
      return reply(200, { ok: true, nombre: `Plantilla servicios ${nombreMarca}.xlsx`.replace(/[^\w .-]/g, ''), data });
    }

    if (action === 'validar') {
      const arch = String(b.archivo || '');
      if (arch.length < 200 || arch.length > MAX_ARCHIVO_B64 || !/^[A-Za-z0-9+/]+=*$/.test(arch) || !arch.startsWith('UEsD')) {
        return reply(400, { error: 'archivo' });
      }
      let items;
      try {
        items = await leerArchivo(arch);
      } catch (e) {
        return reply(400, { error: e.codigo || 'archivo' });
      }
      if (!items.length) return reply(400, { error: 'vacio' });
      if (items.length > MAX_FILAS) return reply(400, { error: 'demasiadas', max: MAX_FILAS });
      // links de Google Maps → coordenadas (con tiempo límite)
      const fin = Date.now() + 6500;
      let i = 0;
      const pool = Array.from({ length: 8 }, async () => {
        while (i < items.length) {
          const it = items[i++];
          const raw = it.raw;
          if (parseCoords(raw.coords) && !esLinkMaps(raw.coords)) continue;
          const fuente = [raw.coords, raw.dir].find((x) => esLinkMaps(x));
          if (fuente) {
            const c = await resolverLink(fuente, fin);
            if (c) { raw.lat = c.lat; raw.lon = c.lon; } else it.aviso = 'No se pudo leer la ubicación del link';
          }
        }
      });
      await Promise.all(pool);
      const filas = revisar(items);
      filas.forEach((f, k) => { if (items[k].aviso) f.avisos.push(items[k].aviso); });
      return reply(200, {
        ok: true, marca: nombreMarca, total: filas.length, buenas: filas.filter((f) => f.ok).length, filas
      });
    }

    // crear
    const entrada = Array.isArray(b.filas) ? b.filas.slice(0, MAX_FILAS) : [];
    if (!entrada.length) return reply(400, { error: 'vacio' });
    const items = entrada.map((f, k) => ({
      fila: Number(f && f.fila) || k + 1,
      raw: { tipo: f && f.datos && f.datos.tipo, lugar: f && f.datos && f.datos.lugar, falla: f && f.datos && f.datos.falla,
        dir: f && f.datos && f.datos.dir, lat: f && f.datos && f.datos.lat, lon: f && f.datos && f.datos.lon,
        contacto: f && f.datos && f.datos.contacto, tel: f && f.datos && f.datos.tel,
        serie: f && f.datos && f.datos.serie }
    }));
    const buenas = revisar(items).filter((f) => f.ok);
    const registros = buenas.map((f) => {
      const d = f.datos;
      const fields = {
        [S.token]: crypto.randomBytes(24).toString('base64url'), [S.active]: true, [S.etapa]: 'Recibido',
        [S.cliente]: [marca.id], [S.falla]: d.falla, [S.tipo]: d.tipo, [S.lugar]: d.lugar,
        [S.quienNombre]: r.contacto.nombre
      };
      if (r.contacto.tel) fields[S.quienTel] = r.contacto.tel;
      if (d.dir) fields[S.dir] = d.dir;
      if (d.lat != null) fields[S.coords] = `${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}`;
      if (d.contacto) fields[S.contacto] = d.contacto;
      if (d.tel) fields[S.tel] = d.tel;
      if (d.serie) fields[S.serie] = d.serie;
      return fields;
    });
    const creados = [];
    for (let k = 0; k < registros.length; k += 10) {
      const lote = registros.slice(k, k + 10);
      const recs = await crearLote(lote);
      recs.forEach((rec, j) => creados.push({
        fila: buenas[k + j].fila, lugar: buenas[k + j].datos.lugar,
        folio: clean((rec.fields && rec.fields[S.folio]) || '', 40), token: lote[j][S.token]
      }));
    }
    return reply(200, { ok: true, creados, omitidas: items.length - buenas.length });
  } catch (e) {
    console.error('masiva', e && e.status, e && e.message);
    return reply(502, { error: 'airtable' });
  }
};

exports._test = { normalizar, coordsDeLink, esLinkMaps, leerArchivo, plantilla, revisar };
