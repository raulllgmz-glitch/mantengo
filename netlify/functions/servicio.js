// MantenGO · Link único de servicio (seguimiento + evidencias de cierre)
// Rutas (ver netlify.toml):
//   /s/<token>        -> página del servicio con línea de tiempo (HTML renderizado en servidor)
//   /i/<token>/<n>    -> redirección a la foto n con URL fresca, usada para la vista previa de WhatsApp
//
// Variables de entorno en Netlify:
//   AIRTABLE_TOKEN    (obligatoria) token personal con permiso de lectura SOLO a la base de MantenGO
//   AIRTABLE_BASE_ID  (opcional)    por defecto la base de MantenGO
//   AIRTABLE_TABLE_ID (opcional)    por defecto la tabla Servicios
//   ALLOW_DEMO        (opcional)    pon "false" en producción para apagar las vistas /s/demo*

const AT_BASE = process.env.AIRTABLE_BASE_ID || 'appqjYUAGBRIh6RHX';
const AT_TABLE = process.env.AIRTABLE_TABLE_ID || 'tbl77Z2y9GVqC30H0';

// Nombres de campo en Airtable. Solo estos campos se piden: nada de montos ni facturas.
const F = {
  token: 'Token Público',
  active: 'Link activo',
  folio: 'Folio',
  tipo: 'Tipo de Servicio',
  falla: 'Solicitud Falla',
  lugar: 'Establecimiento',
  direccion: 'Dirección',
  coords: 'Coordenadas',
  serie: 'Serie',
  etapa: 'Etapa',
  programada: 'Fecha programada',
  programada2: 'Fecha Programada', // así se llama en la tabla de MantenGO; se acepta cualquiera de las dos
  camino: 'Hora en camino',
  estimada: 'Llegada estimada',
  estimada2: 'Llegada Estimada',
  latT: 'Lat técnico',
  lonT: 'Lon técnico',
  ubicAct: 'Ubicación actualizada',
  tecnico: 'Técnico',
  cierre: 'Fecha de Cierre',
  comentario: 'Comentario Cierre',
  fotos: 'Evidencias'
};
// Campos opcionales: si alguno todavía no existe en Airtable, la página sigue funcionando sin él.
const OPTIONAL = [F.tipo, F.falla, F.lugar, F.direccion, F.coords, F.serie, F.etapa, F.programada, F.programada2, F.camino, F.estimada, F.estimada2, F.latT, F.lonT, F.ubicAct, F.tecnico, F.cierre, F.comentario, F.fotos];

const WHATSAPP = '524424501585';
const TZ = 'America/Mexico_City';
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

// Etapas, en orden. El índice es la etapa actual.
const LABELS = ['Solicitud recibida', 'Servicio programado', 'Técnico en camino', 'Servicio en proceso', 'Servicio terminado'];
const EMOJI = ['📥', '📅', '🚚', '🔧', '✅'];
const BADGES = ['SOLICITUD RECIBIDA', 'SERVICIO PROGRAMADO', 'TÉCNICO EN CAMINO', 'SERVICIO EN PROCESO', 'SERVICIO TERMINADO'];
const ALIAS = {
  recibido: 0, recibida: 0, abierto: 0, abierta: 0,
  programado: 1, programada: 1,
  'en camino': 2,
  'en proceso': 3,
  terminado: 4, terminada: 4, cerrado: 4, cerrada: 4
};

// ---------- utilidades ----------
const esc = (v) =>
  String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

function parse(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d) ? null : d;
}
const hasTime = (iso) => String(iso).length > 10;

// "6 de noviembre de 2026"
function fmtDate(iso) {
  const d = parse(iso);
  if (!d) return '';
  return new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: hasTime(iso) ? TZ : 'UTC'
  }).format(d);
}
// "4:00 p.m."
function fmtTime(iso) {
  const d = parse(iso);
  if (!d || !hasTime(iso)) return '';
  return new Intl.DateTimeFormat('es-MX', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TZ }).format(d);
}
// "6 de noviembre · 4:00 p.m."  (sin hora si el campo es solo fecha)
function fmtDT(iso) {
  const d = parse(iso);
  if (!d) return '';
  const day = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', timeZone: hasTime(iso) ? TZ : 'UTC' }).format(d);
  const t = fmtTime(iso);
  return t ? `${day} · ${t}` : day;
}

function baseUrl(event) {
  const h = event.headers || {};
  const host = h['x-forwarded-host'] || h.host || '';
  return host ? `https://${host}` : '';
}

const BASE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  // Solo se envía el dominio (nunca la ruta con el token). OpenStreetMap exige saber de qué sitio viene la petición.
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff'
};

// Etapa actual (0..4). Con fecha de cierre siempre es "terminado".
function stageIndex(s) {
  if (s.cierre) return 4;
  const i = ALIAS[norm(s.etapa)];
  if (i !== undefined) return i;
  const j = LABELS.findIndex((l) => norm(l) === norm(s.etapa));
  if (j >= 0) return j;
  if (s.camino) return 2;
  if (s.programada) return 1;
  return 0;
}

// ---------- datos ----------
function placeholder(n) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">` +
    `<rect width="640" height="480" fill="#1B3040"/>` +
    `<rect x="24" y="24" width="592" height="432" rx="18" fill="none" stroke="#3A5062" stroke-width="3" stroke-dasharray="14 10"/>` +
    `<text x="320" y="236" text-anchor="middle" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="#F5A623">Foto de ejemplo ${n}</text>` +
    `<text x="320" y="278" text-anchor="middle" font-family="Arial, sans-serif" font-size="20" fill="#A9B8C3">Aquí va la evidencia real</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// Vistas de ejemplo: /s/demo (terminado), /s/demo-recibido, /s/demo-programado, /s/demo-encamino, /s/demo-proceso
const DEMOS = { 'demo-recibido': 0, 'demo-programado': 1, 'demo-encamino': 2, 'demo-proceso': 3, demo: 4 };

// Demo: el técnico se acerca al establecimiento en un ciclo de 5 minutos.
function demoTech(now) {
  const p = (now % 300000) / 300000;
  return { lat: 20.58805 + 0.022 * (1 - p), lon: -100.38986 + 0.026 * (1 - p) };
}

function demoService(stage, now = Date.now()) {
  const s = {
    folio: 'MTGO-DEMO',
    tipo: 'Reparación',
    falla: 'Tira agua',
    lugar: 'Abarrotes La Esperanza',
    direccion: 'Calle Hidalgo 120, Querétaro',
    coords: '20.58805, -100.38986',
    serie: 'DEMO-0000',
    etapa: LABELS[stage],
    creado: '2026-11-05T23:42:00.000Z',
    programada: '',
    camino: '',
    estimada: '',
    tlat: null,
    tlon: null,
    tupd: '',
    tecnico: '',
    cierre: '',
    comentario: '',
    fotos: []
  };
  if (stage >= 1) s.programada = '2026-11-06T22:00:00.000Z';
  if (stage >= 1 && stage <= 3) s.estimada = new Date(Date.now() + 45 * 60000).toISOString();
  if (stage >= 2) {
    s.camino = '2026-11-06T21:35:00.000Z';
    s.tecnico = 'Luis';
  }
  if (stage === 2) {
    const d = demoTech(now);
    s.tlat = d.lat;
    s.tlon = d.lon;
    s.tupd = new Date(now).toISOString();
  }
  if (stage === 4) {
    s.cierre = '2026-11-06';
    s.comentario =
      'Se localizó obstrucción en el drenaje del evaporador. Se limpió la línea, se verificó que ya no gotea y se confirmó la temperatura de operación del equipo.';
    s.fotos = [1, 2, 3, 4].map((n) => ({ thumb: placeholder(n), full: placeholder(n), nombre: `Foto ${n}` }));
  }
  return s;
}

async function fetchService(token) {
  const key = process.env.AIRTABLE_TOKEN;
  if (!key) throw new Error('Falta AIRTABLE_TOKEN');

  let optional = OPTIONAL.slice();
  for (let attempt = 0; attempt < 12; attempt++) {
    const url = new URL(`https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}`);
    // El token ya pasó TOKEN_RE (solo letras, números, - y _), así que es seguro dentro de la fórmula.
    url.searchParams.set('filterByFormula', `AND({${F.token}}='${token}',{${F.active}})`);
    url.searchParams.set('maxRecords', '1');
    [F.folio, ...optional].forEach((f) => url.searchParams.append('fields[]', f));

    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });

    if (res.ok) {
      const data = await res.json();
      const rec = data.records && data.records[0];
      if (!rec) return null;
      const f = rec.fields || {};
      const etapa = f[F.etapa];
      const fotos = (Array.isArray(f[F.fotos]) ? f[F.fotos] : [])
        .filter((a) => a && a.url && String(a.type || '').startsWith('image/'))
        .map((a) => ({
          thumb: (a.thumbnails && a.thumbnails.large && a.thumbnails.large.url) || a.url,
          full: a.url,
          nombre: a.filename || ''
        }));
      const tec = f[F.tecnico];
      return {
        folio: f[F.folio] || '',
        tipo: f[F.tipo] || '',
        falla: f[F.falla] || '',
        lugar: f[F.lugar] || '',
        direccion: f[F.direccion] || '',
        coords: f[F.coords] || '',
        serie: f[F.serie] || '',
        etapa: etapa && typeof etapa === 'object' ? etapa.name : etapa || '',
        creado: rec.createdTime || '',
        programada: f[F.programada] || f[F.programada2] || '',
        camino: f[F.camino] || '',
        estimada: f[F.estimada] || f[F.estimada2] || '',
        tlat: num(f[F.latT]),
        tlon: num(f[F.lonT]),
        tupd: f[F.ubicAct] || '',
        tecnico: tec && typeof tec === 'object' ? tec.name || '' : tec || '',
        cierre: f[F.cierre] || '',
        comentario: f[F.comentario] || '',
        fotos
      };
    }

    // Si un campo opcional aún no existe, se quita y se reintenta.
    if (res.status === 422) {
      let body = {};
      try {
        body = await res.json();
      } catch (e) {
        /* sin detalle */
      }
      const err = body.error || {};
      const m = String(err.message || '').match(/"([^"]+)"/);
      if (err.type === 'UNKNOWN_FIELD_NAME' && m && optional.includes(m[1])) {
        optional = optional.filter((x) => x !== m[1]);
        continue;
      }
      throw new Error(`Airtable 422: ${err.type || ''} ${err.message || ''}`);
    }
    throw new Error(`Airtable respondió ${res.status}`);
  }
  throw new Error('Demasiados campos faltantes en Airtable');
}

// ---------- HTML ----------
const CSS = `
:root{--bg:#0F1B24;--card:#16262F;--line:#2A3E4D;--orange:#F5A623;--text:#FFFFFF;--muted:#A9B8C3}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font-family:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;line-height:1.5}
a{color:inherit;text-decoration:none}
.wrap{max-width:560px;margin:0 auto;padding:28px 20px 40px;display:flex;flex-direction:column;gap:20px}
.logo{display:block;width:170px;height:auto}
.badge{display:inline-flex;align-items:center;gap:8px;align-self:flex-start;background:rgba(245,166,35,.16);border:1.5px solid var(--orange);color:var(--text);font-size:12px;font-weight:700;letter-spacing:.12em;padding:6px 12px;border-radius:999px}
.badge svg{flex:none}
.pulse{display:inline-block;width:9px;height:9px;border-radius:99px;background:var(--orange)}
h1{margin:0;font-size:30px;line-height:1.15;font-weight:800;letter-spacing:-.01em}
.sub{margin:6px 0 0;color:var(--muted);font-size:16px}
.card{background:var(--card);border-radius:20px;padding:18px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.folio{display:flex;align-items:center;gap:10px;margin:16px 0 6px}
.folio b{font-size:15px;font-weight:700;letter-spacing:.02em}
.k{font-size:11px;font-weight:700;letter-spacing:.14em;color:var(--orange);text-transform:uppercase}
.v{margin-top:3px;font-size:15px;font-weight:600;overflow-wrap:anywhere}
.full{grid-column:1/-1}
h2{margin:0 0 12px;font-size:13px;font-weight:700;color:#D5DEE5}
.row{display:flex;gap:14px}
.rail{display:flex;flex-direction:column;align-items:center;width:26px;flex:none}
.dot{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:999px;flex:none}
.dot.done{background:var(--orange)}
.dot.now{background:var(--card);border:3px solid var(--orange)}
.dot.now i{display:block;width:8px;height:8px;border-radius:99px;background:var(--orange)}
.dot.todo{background:var(--card);border:2px solid #3A5062}
.line{flex:1;width:2px;min-height:22px;background:var(--line)}
.line.done{background:var(--orange)}
.txt{padding-bottom:16px}
.row:last-child .txt{padding-bottom:0}
.txt b{display:block;font-size:15px;font-weight:700}
.txt.now b{font-weight:800;color:var(--orange)}
.txt.todo b{font-weight:600;color:#9FB0BC}
.txt small{display:block;font-size:12px;color:var(--muted)}
.txt.todo small{color:#8497A5}
.steps{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));margin:0 -6px}
.st{position:relative;display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center}
.st .dot{position:relative;z-index:1}
.st::before{content:"";position:absolute;top:12px;right:50%;width:100%;height:2px;background:var(--line)}
.st:first-child::before{display:none}
.st.done::before,.st.now::before{background:var(--orange)}
.st b{font-size:10.5px;line-height:1.25;font-weight:600;color:#9FB0BC;letter-spacing:-.01em}
.st.done b{color:#D5DEE5}
.st.now b{color:var(--orange);font-weight:800}
.nowbox{margin-top:16px;padding-top:14px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:2px}
.nowbox b{font-size:17px;font-weight:800}
.nowbox span{font-size:14px;color:#E6EDF2}
.nowbox small{font-size:12px;color:var(--muted)}
.more{margin-top:14px;border-top:1px solid var(--line);padding-top:4px}
.more summary{list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;min-height:44px;font-size:14px;font-weight:600;color:var(--orange)}
.more summary::-webkit-details-marker{display:none}
.more .chev{flex:none;transition:transform .2s}
.more[open] .chev{transform:rotate(180deg)}
.more .tl{padding-top:12px}
.place{display:flex;align-items:center;gap:8px;margin:10px 0 0;font-size:18px;font-weight:700;overflow-wrap:anywhere}
.place svg{flex:none}
.loc{display:flex;flex-direction:column;gap:14px}
.locrow{display:flex;gap:12px;align-items:flex-start}
.locrow svg{flex:none;margin-top:2px}
.addr{margin-top:2px;font-size:14px;color:#D5DEE5;overflow-wrap:anywhere}
.coords{margin-top:4px;font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums}
.btn2{display:inline-flex;align-self:flex-start;align-items:center;justify-content:center;height:44px;padding:0 18px;border-radius:999px;border:1.5px solid #2F4455;font-size:14px;font-weight:600}
@media (prefers-reduced-motion:reduce){.more .chev{transition:none}}
.coment{margin:0;font-size:15px;color:#E6EDF2;white-space:pre-line}
.mapbox{border-radius:18px;overflow:hidden;border:1px solid var(--line);background:var(--card)}
#map{height:230px;width:100%;background:#16262F;font-family:inherit}
.leaflet-container{background:#16262F;font-family:inherit}
.leaflet-control-attribution{background:rgba(15,27,36,.85)!important;color:#A9B8C3!important;font-size:10px}
.leaflet-control-attribution a{color:#F5A623!important}
.pinicon{background:none;border:0}
.leaflet-tile-pane{filter:invert(100%) hue-rotate(180deg) brightness(92%) contrast(88%) saturate(70%)}
.mapbox{position:relative}
.distchip{position:absolute;top:10px;left:10px;z-index:1000;display:none;background:rgba(15,27,36,.92);border:1px solid var(--orange);border-radius:999px;padding:6px 12px;font-size:13px;font-weight:700;color:#fff;max-width:calc(100% - 70px)}
.distchip small{font-weight:500;color:var(--muted);margin-left:4px}
.tech{width:76px;height:60px;background:url(/assets/camion.png) center/contain no-repeat;filter:drop-shadow(0 3px 5px rgba(0,0,0,.55))}
.leaflet-bar{border:1px solid #2A3E4D!important;box-shadow:none!important}
.leaflet-bar a,.leaflet-bar a:hover{background:#16262F!important;color:#fff!important;border-bottom:1px solid #2A3E4D!important}
.eta{display:flex;align-items:center;gap:8px;margin:0 0 12px;font-size:14px;font-weight:600;color:#E6EDF2}
.actions{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.act{display:flex;flex-direction:column;align-items:center;gap:8px;padding:6px 0;text-align:center;font-size:12.5px;font-weight:600;color:#D5DEE5;text-decoration:none}
.act span{display:flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;background:rgba(245,166,35,.14);border:1px solid rgba(245,166,35,.35)}
.note{margin:0;font-size:13px;color:var(--muted)}
.fotos{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.fotos a{display:block;border-radius:14px;overflow:hidden;background:#0F1B24;aspect-ratio:4/3}
.fotos img{display:block;width:100%;height:100%;object-fit:cover}
.lb{display:none;position:fixed;inset:0;z-index:10;background:rgba(7,13,18,.94);align-items:center;justify-content:center;padding:16px}
.lb:target{display:flex}
.lb img{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px}
.lb span{position:absolute;top:14px;right:18px;font-size:34px;line-height:1;color:#fff}
.cta{display:flex;align-items:center;gap:14px}
.cta .t{flex:1}
.cta h3{margin:0 0 4px;font-size:17px;font-weight:700}
.cta p{margin:0 0 12px;font-size:13px;color:var(--muted)}
.btn{display:inline-flex;align-items:center;justify-content:center;height:48px;padding:0 22px;border-radius:999px;background:var(--orange);color:#0F1B24;font-weight:700;font-size:15px}
.cta img{width:96px;height:auto;flex:none}
.foot{font-size:13px;color:var(--muted);line-height:1.7}
.foot b{color:#D5DEE5}
.foot a{color:var(--orange)}
.empty{min-height:60vh;display:flex;flex-direction:column;justify-content:center;gap:14px}
@media(max-width:380px){h1{font-size:26px}.cta img{width:76px}}
`;

const CHECK = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F5A623" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const CHECK_DARK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0F1B24" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;

function page({ title, desc, image, body, canonical, refresh, head }) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex, nofollow">
<meta name="description" content="${esc(desc)}">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
<meta property="og:type" content="website">
<meta property="og:site_name" content="MantenGO">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
${image ? `<meta property="og:image" content="${esc(image)}">` : ''}
${canonical ? `<meta property="og:url" content="${esc(canonical)}">` : ''}
<meta name="theme-color" content="#0F1B24">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${CSS}</style>
${head || ''}
</head>
<body>
${body}
</body>
</html>`;
}

function footer() {
  return `<div class="foot"><b>MantenGO</b> · WhatsApp y teléfono <a href="https://wa.me/${WHATSAPP}">442 450 1585</a><br><a href="mailto:contacto@mantengo.mx">contacto@mantengo.mx</a> · <a href="https://mantengo.mx">mantengo.mx</a></div>`;
}

// Texto secundario de cada etapa alcanzada
function stageDetail(i, s) {
  if (i === 0) return fmtDT(s.creado);
  if (i === 1) return s.programada ? `Visita: ${fmtDT(s.programada)}` : '';
  if (i === 2) {
    const t = fmtTime(s.camino);
    return [t ? `Salió a las ${t}` : '', s.tecnico ? `Técnico: ${s.tecnico}` : ''].filter(Boolean).join(' · ');
  }
  if (i === 4) return fmtDate(s.cierre);
  return '';
}

function timelineRows(s, cur) {
  const rows = LABELS.map((label, i) => {
    const done = i < cur || (i === cur && cur === 4);
    const now = i === cur && cur !== 4;
    const state = done ? 'done' : now ? 'now' : 'todo';
    const dot = done ? `<span class="dot done">${CHECK_DARK}</span>` : now ? `<span class="dot now"><i></i></span>` : `<span class="dot todo"></span>`;
    const line = i < LABELS.length - 1 ? `<span class="line ${i < cur ? 'done' : ''}"></span>` : '';
    const detail = i <= cur ? stageDetail(i, s) : '';
    const small = detail || (i > cur ? 'Pendiente' : '');
    return `<div class="row"><div class="rail">${dot}${line}</div><div class="txt ${state}"><b>${esc(label)}</b>${small ? `<small>${esc(small)}</small>` : ''}</div></div>`;
  });
  return rows.join('');
}

const STEPS = ['Recibido', 'Programado', 'En camino', 'En proceso', 'Terminado'];
const NOTES = [
  'Recibimos tu solicitud.',
  'Tu visita ya está agendada.',
  'El técnico va hacia tu establecimiento.',
  'Estamos atendiendo tu equipo.',
  'El servicio ya quedó cerrado.'
];
const CHEV = `<svg class="chev" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F5A623" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`;
const PIN = (size, w) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#F5A623" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s7-6.2 7-11.5a7 7 0 0 0-14 0C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>`;

// Barra horizontal con las cinco etapas
function stepper(cur) {
  return `<div class="steps" role="list" aria-label="Avance del servicio">${STEPS.map((name, i) => {
    const done = i < cur || (i === cur && cur === 4);
    const now = i === cur && cur !== 4;
    const state = done ? 'done' : now ? 'now' : 'todo';
    const dot = done ? `<span class="dot done">${CHECK_DARK}</span>` : now ? `<span class="dot now"><i></i></span>` : `<span class="dot todo"></span>`;
    return `<div class="st ${state}" role="listitem"${now ? ' aria-current="step"' : ''}>${dot}<b>${esc(name)}</b></div>`;
  }).join('')}</div>`;
}

// Estatus actual + despegable con el detalle de cada etapa
function statusCard(s, cur) {
  const detail = stageDetail(cur, s);
  const eta = etaText(s, cur, new Date());
  return `<section class="card">
${eta ? `<p class="eta"><span class="pulse"></span>${esc(eta)}</p>` : ''}
<h2>Estatus del servicio</h2>
${stepper(cur)}
<div class="nowbox"><b>${esc(LABELS[cur])}</b><span>${esc(NOTES[cur])}</span>${detail ? `<small>${esc(detail)}</small>` : ''}</div>
<details class="more"><summary><span>Ver detalle del seguimiento</span>${CHEV}</summary><div class="tl">${timelineRows(s, cur)}</div></details>
</section>`;
}

// "20.58805, -100.38986" -> { lat, lon }. Solo acepta decimales válidos.
function parseCoords(txt) {
  const m = String(txt || '').match(/^\s*\(?\s*(-?\d{1,2}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)\s*\)?\s*$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return null;
  return { lat, lon };
}

const MAPS_URL_RE = /^https:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps)/i;

// Dirección + coordenadas + botón "Ver en mapa"
function locationCard(s) {
  const c = parseCoords(s.coords);
  const coordsUrl = MAPS_URL_RE.test(String(s.coords || '').trim()) ? String(s.coords).trim() : '';
  if (!s.lugar && !s.direccion && !c && !coordsUrl) return '';
  const query = c ? `${c.lat},${c.lon}` : [s.lugar, s.direccion].filter(Boolean).join(' ');
  const href = coordsUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  return `<section class="card loc">
<div class="locrow">${PIN(22, 1.9)}<div><div class="k">Ubicación</div>${s.lugar ? `<div class="v">${esc(s.lugar)}</div>` : ''}${s.direccion ? `<div class="addr">${esc(s.direccion)}</div>` : ''}${c ? `<div class="coords">${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}</div>` : ''}</div></div>
<a class="btn2" href="${esc(href)}" target="_blank" rel="noopener noreferrer">Ver en mapa</a>
</section>`;
}

const STALE_SEC = 600; // la posición del técnico caduca a los 10 min

// Posición vigente del técnico (solo mientras va en camino)
function techPos(s, cur, now) {
  if (cur !== 2 || s.tlat == null || s.tlon == null) return null;
  if (!(Math.abs(s.tlat) <= 90 && Math.abs(s.tlon) <= 180)) return null;
  const t = parse(s.tupd);
  if (!t) return null;
  const age = (now.getTime() - t.getTime()) / 1000;
  if (age > STALE_SEC || age < -120) return null;
  return { lat: s.tlat, lon: s.tlon, age: Math.max(0, Math.round(age)) };
}

function distKm(a, b) {
  const R = 6371;
  const r = (x) => (x * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const LEAFLET_CSS = '<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">';
const LEAFLET_JS = '<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>';

// Mapa con el pin del establecimiento y, si va en camino, el técnico con su distancia (en vivo)
function mapCard(s, cur, token, now) {
  const c = parseCoords(s.coords);
  if (!c) return { html: '', head: '', live: false };
  const pos = techPos(s, cur, now);
  const pin = '<svg xmlns="http://www.w3.org/2000/svg" width="38" height="48" viewBox="0 0 38 48"><path d="M19 46S4 31 4 18a15 15 0 0 1 30 0c0 13-15 28-15 28z" fill="#F5A623" stroke="#0F1B24" stroke-width="3"/><circle cx="19" cy="18" r="6" fill="#0F1B24"/></svg>';
  const safe = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
  const script = `<script>(function(){
window.addEventListener('load',function(){
if(!window.L)return;
var DEST=[${c.lat},${c.lon}],TOKEN=${safe(token)},STAGE=${cur},tech=null,follow=true;
var m=L.map('map',{scrollWheelZoom:false,dragging:!L.Browser.mobile,tap:false,attributionControl:false,zoomControl:false}).setView(DEST,16);
L.control.zoom({position:'topright'}).addTo(m);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(m);
L.control.attribution({prefix:false}).addTo(m);
L.marker(DEST,{icon:L.divIcon({className:'pinicon',html:${safe(pin)},iconSize:[38,48],iconAnchor:[19,46]}),keyboard:false}).addTo(m);
var chip=document.getElementById('dist');
m.getContainer().addEventListener('pointerdown',function(){follow=false;});
function rad(x){return x*Math.PI/180;}
function km(a,b){var h=Math.pow(Math.sin(rad(b[0]-a[0])/2),2)+Math.cos(rad(a[0]))*Math.cos(rad(b[0]))*Math.pow(Math.sin(rad(b[1]-a[1])/2),2);return 12742*Math.asin(Math.sqrt(h));}
function fmt(k){if(k<0.05)return 'Llegando';if(k<0.95)return 'A '+(Math.round(k*100)*10)+' m';return 'A '+k.toFixed(1)+' km';}
function ago(s){if(s<15)return 'ahora';if(s<60)return 'hace '+s+' s';return 'hace '+Math.round(s/60)+' min';}
function apply(p){
 if(!p){if(tech){m.removeLayer(tech);tech=null;}chip.style.display='none';return;}
 var ll=[p.lat,p.lon];
 if(!tech){tech=L.marker(ll,{icon:L.divIcon({className:'pinicon',html:'<div class="tech" aria-hidden="true"></div>',iconSize:[76,60],iconAnchor:[38,34]}),keyboard:false,zIndexOffset:500}).addTo(m);}else{tech.setLatLng(ll);}
 chip.innerHTML=fmt(km(ll,DEST))+'<small>'+ago(p.age||0)+'</small>';chip.style.display='block';
 if(follow)m.fitBounds([ll,DEST],{padding:[56,56],maxZoom:17,animate:false});
}
apply(${safe(pos)});
function tick(){fetch('/p/'+encodeURIComponent(TOKEN),{cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(function(d){if(!d)return;if(d.stage!==STAGE){location.reload();return;}apply(d.pos);}).catch(function(){});}
setInterval(tick,STAGE===2?10000:30000);
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')tick();});
});
})();</script>`;
  return {
    html: `<div class="mapbox"><div id="map" role="img" aria-label="Mapa con la ubicación de ${esc(s.lugar || 'el establecimiento')}"></div><div class="distchip" id="dist" aria-live="polite"></div></div>${script}`,
    head: `${LEAFLET_CSS}\n${LEAFLET_JS}`,
    live: true
  };
}

// "Llega hoy antes de las 11:45 hs" (solo mientras el servicio no termina)
function etaText(s, cur, now) {
  if (cur >= 4 || !s.estimada) return '';
  const d = parse(s.estimada);
  if (!d) return '';
  const day = (x, z) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: z }).format(x);
  const withTime = hasTime(s.estimada);
  const z = withTime ? TZ : 'UTC';
  const today = day(now, TZ);
  const tomorrow = day(new Date(now.getTime() + 86400000), TZ);
  const target = day(d, z);
  if (target < today) return '';
  if (withTime && d.getTime() < now.getTime()) return '';
  let when;
  if (target === today) when = 'hoy';
  else if (target === tomorrow) when = 'mañana';
  else when = 'el ' + new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', timeZone: z }).format(d);
  if (!withTime) return `Llega ${when}`;
  const hhmm = new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ }).format(d);
  return `Llega ${when} antes de las ${hhmm} hs`;
}

const ICON = (path) => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#F5A623" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const ICON_SHARE = ICON('<circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="M8.3 10.8l7.4-4.3M8.3 13.2l7.4 4.3"/>');
const ICON_CHAT = ICON('<path d="M20 12a8 8 0 0 1-11.8 7L4 20l1.1-4A8 8 0 1 1 20 12z"/>');
const ICON_PHONE = ICON('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>');

function actionsRow(s, pageUrl) {
  const share = encodeURIComponent(`Sigue el servicio ${s.folio || ''} de MantenGO: ${pageUrl}`.replace(/\s+/g, ' ').trim());
  const ask = encodeURIComponent(`Hola, tengo una pregunta sobre el servicio ${s.folio}.`);
  return `<nav class="card actions" aria-label="Acciones">
<a class="act" href="https://wa.me/?text=${share}" target="_blank" rel="noopener noreferrer"><span>${ICON_SHARE}</span>Compartir</a>
<a class="act" href="https://wa.me/${WHATSAPP}?text=${ask}" target="_blank" rel="noopener noreferrer"><span>${ICON_CHAT}</span>WhatsApp</a>
<a class="act" href="tel:+${WHATSAPP}"><span>${ICON_PHONE}</span>Llamar</a>
</nav>`;
}

function renderService(s, token, base, isDemo) {
  const cur = stageIndex(s);
  const terminado = cur === 4;
  const titulo = [s.tipo, s.falla].filter(Boolean).join(' · ') || 'Servicio';
  const waText = encodeURIComponent(
    terminado ? `Hola, vi el servicio ${s.folio} y quiero cotizar otro servicio.` : `Hola, tengo una pregunta sobre el servicio ${s.folio}.`
  );

  const meta = [];
  if (terminado && s.cierre) {
    meta.push(`<div><div class="k">Fecha de cierre</div><div class="v">${esc(fmtDate(s.cierre))}</div></div>`);
  } else if (s.programada) {
    meta.push(`<div><div class="k">Visita programada</div><div class="v">${esc(fmtDT(s.programada))}</div></div>`);
  }
  if (s.serie) meta.push(`<div><div class="k">Equipo (serie)</div><div class="v">${esc(s.serie)}</div></div>`);

  let cierre = '';
  if (terminado) {
    if (s.comentario) cierre += `<section class="card"><h2>Comentario de cierre</h2><p class="coment">${esc(s.comentario)}</p></section>`;
    if (s.fotos.length) {
      cierre += `<section class="card"><h2>Evidencia fotográfica (${s.fotos.length})</h2>
<div class="fotos">${s.fotos
        .map((p, i) => `<a href="#f${i + 1}" aria-label="Ver foto ${i + 1} en grande"><img src="${esc(p.thumb)}" alt="Evidencia ${i + 1} del servicio ${esc(s.folio)}" loading="lazy"></a>`)
        .join('')}</div></section>
${s.fotos
        .map((p, i) => `<a class="lb" id="f${i + 1}" href="#" aria-label="Cerrar"><span aria-hidden="true">&times;</span><img src="${esc(p.full)}" alt="Evidencia ${i + 1} ampliada"></a>`)
        .join('')}`;
    }
  } else {
    cierre = `<section class="card"><p class="note">Las fotos de evidencia y el comentario de cierre aparecerán aquí cuando termine el servicio. Esta página se actualiza sola.</p></section>`;
  }

  const map = mapCard(s, cur, token, new Date());
  const body = `<main class="wrap">
<img class="logo" src="/assets/logo.png" alt="MantenGO" width="357" height="76">
<div>
<div class="badge">${terminado ? CHECK : '<span class="pulse"></span>'} ${esc(BADGES[cur])}</div>
${s.folio ? `<p class="folio"><span class="k">Folio</span><b>${esc(s.folio)}</b></p>` : ''}
<h1>${esc(titulo)}</h1>
${s.lugar ? `<p class="place">${PIN(20, 2)}<span>${esc(s.lugar)}</span></p>` : ''}
</div>
${map.html}
${statusCard(s, cur)}
${actionsRow(s, base ? `${base}/s/${token}` : '')}
${locationCard(s)}
<section class="card"><div class="grid">${meta.join('')}</div></section>
${cierre}
<section class="card cta">
<div class="t"><h3>${terminado ? '¿Necesitas otro servicio?' : '¿Dudas sobre tu servicio?'}</h3><p>${terminado ? 'Instalación, reparación, retiro o rehabilitación de tus equipos. Te respondemos con una propuesta clara.' : 'Escríbenos por WhatsApp y con gusto te ayudamos.'}</p>
<a class="btn" href="https://wa.me/${WHATSAPP}?text=${waText}">${terminado ? 'Cotizar por WhatsApp' : 'Escribir por WhatsApp'}</a></div>
<img src="/assets/yeti.png" alt="Mascota de MantenGO" width="225" height="285">
</section>
${footer()}
${isDemo ? '<div class="foot">Vista de ejemplo con datos ficticios.</div>' : ''}
</main>`;

  const ogImage = `${base}/assets/preview-${cur}.png`;
  return page({
    title: `${s.folio} · ${LABELS[cur]}`,
    desc: [titulo, s.lugar, terminado ? fmtDate(s.cierre) : s.programada ? fmtDT(s.programada) : ''].filter(Boolean).join(' · '),
    image: base ? ogImage : '',
    canonical: base ? `${base}/s/${token}` : '',
    refresh: terminado || isDemo || map.live ? 0 : 60,
    head: map.head + (map.live && !terminado && !isDemo ? '\n<noscript><meta http-equiv="refresh" content="60"></noscript>' : ''),
    body
  });
}

function renderUnavailable() {
  const body = `<main class="wrap empty">
<img class="logo" src="/assets/logo.png" alt="MantenGO" width="357" height="76">
<h1>Este enlace no está disponible</h1>
<p class="sub">Puede que el enlace esté incompleto o que haya sido desactivado. Si lo recibiste de MantenGO, pídenos uno nuevo.</p>
<div><a class="btn" href="https://wa.me/${WHATSAPP}">Escribir por WhatsApp</a></div>
${footer()}
</main>`;
  return page({ title: 'Enlace no disponible · MantenGO', desc: 'Este enlace no está disponible.', image: '', body });
}

// ---------- ruta ----------
// Lee el token directo de la dirección original (/s/<token> o /i/<token>/<n>).
// Si no se puede, cae a los parámetros ?token= y ?img= por compatibilidad.
function route(event) {
  const sources = [event.rawUrl, event.path].filter(Boolean).map(String);
  for (const s of sources) {
    const m = s.match(/\/(s|i|p)\/([^/?#]+)(?:\/(\d+))?/);
    if (m) {
      let tok = m[2];
      try {
        tok = decodeURIComponent(tok);
      } catch (e) {
        /* se queda como viene y no pasará la validación */
      }
      return { kind: m[1], token: tok, n: m[3] };
    }
  }
  const q = event.queryStringParameters || {};
  return { kind: q.img !== undefined ? 'i' : 's', token: String(q.token || ''), n: q.img };
}

// ---------- handler ----------
exports.handler = async (event) => {
  const r = route(event);
  const token = r.token.trim();
  const base = baseUrl(event);
  const demoOn = process.env.ALLOW_DEMO !== 'false';

  const unavailable = () => ({ statusCode: 404, headers: BASE_HEADERS, body: renderUnavailable() });

  // Redirección a la foto n con URL fresca (vista previa de WhatsApp)
  if (r.kind === 'i') {
    const n = parseInt(r.n, 10);
    if (!TOKEN_RE.test(token) || !(n >= 1 && n <= 50)) return { statusCode: 404, body: '' };
    try {
      const s = await fetchService(token);
      const foto = s && stageIndex(s) === 4 && s.fotos[n - 1];
      if (!foto) return { statusCode: 404, body: '' };
      return { statusCode: 302, headers: { Location: foto.thumb, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }, body: '' };
    } catch (e) {
      return { statusCode: 502, body: '' };
    }
  }

  // Posición en vivo para el mapa (JSON)
  if (r.kind === 'p') {
    const JSON_H = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' };
    const payload = (s) => {
      const stage = stageIndex(s);
      return { stage, pos: techPos(s, stage, new Date()) };
    };
    if (demoOn && Object.prototype.hasOwnProperty.call(DEMOS, token)) {
      return { statusCode: 200, headers: JSON_H, body: JSON.stringify(payload(demoService(DEMOS[token]))) };
    }
    if (!TOKEN_RE.test(token)) return { statusCode: 404, headers: JSON_H, body: '{}' };
    try {
      const s = await fetchService(token);
      if (!s) return { statusCode: 404, headers: JSON_H, body: '{}' };
      return { statusCode: 200, headers: JSON_H, body: JSON.stringify(payload(s)) };
    } catch (e) {
      console.error('posicion:', e.message);
      return { statusCode: 502, headers: JSON_H, body: '{}' };
    }
  }

  if (demoOn && Object.prototype.hasOwnProperty.call(DEMOS, token)) {
    return { statusCode: 200, headers: BASE_HEADERS, body: renderService(demoService(DEMOS[token]), token, base, true) };
  }

  if (!TOKEN_RE.test(token)) return unavailable();

  try {
    const s = await fetchService(token);
    if (!s) return unavailable();
    return { statusCode: 200, headers: BASE_HEADERS, body: renderService(s, token, base, false) };
  } catch (e) {
    console.error('servicio:', e.message);
    return {
      statusCode: 502,
      headers: BASE_HEADERS,
      body: page({
        title: 'Intenta de nuevo · MantenGO',
        desc: 'No pudimos cargar el servicio.',
        image: '',
        body: `<main class="wrap empty"><img class="logo" src="/assets/logo.png" alt="MantenGO" width="357" height="76"><h1>No pudimos cargar el servicio</h1><p class="sub">Intenta de nuevo en unos minutos.</p>${footer()}</main>`
      })
    };
  }
};

exports._test = { TOKEN_RE, stageIndex, renderService, demoService, parseCoords, etaText, techPos, distKm, mapCard };
