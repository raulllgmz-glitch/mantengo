// MantenGO · Link único de servicio
// Rutas (ver netlify.toml):
//   /s/<token>        -> página del servicio (HTML renderizado en servidor)
//   /i/<token>/<n>    -> redirección a la foto n (1..N) con URL fresca, usada para la vista previa de WhatsApp
//
// Variables de entorno en Netlify:
//   AIRTABLE_TOKEN    (obligatoria) token personal con permiso de lectura SOLO a la tabla Servicios
//   AIRTABLE_BASE_ID  (opcional)    por defecto la base de MantenGO
//   AIRTABLE_TABLE_ID (opcional)    por defecto la tabla Servicios
//   ALLOW_DEMO        (opcional)    pon "false" en producción para apagar /s/demo

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
  cierre: 'Fecha de Cierre',
  comentario: 'Comentario Cierre',
  serie: 'Serie',
  fotos: 'Evidencias'
};

const WHATSAPP = '524424501585';
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

// ---------- utilidades ----------
const esc = (v) =>
  String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function fechaLarga(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(d);
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
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
};

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

function demoService() {
  return {
    folio: 'MTGO-DEMO',
    tipo: 'Reparación',
    falla: 'Tira agua',
    lugar: 'Abarrotes La Esperanza',
    direccion: 'Calle Hidalgo 120, Querétaro',
    cierre: '2026-11-06',
    serie: 'DEMO-0000',
    comentario:
      'Se localizó obstrucción en el drenaje del evaporador. Se limpió la línea, se verificó que ya no gotea y se confirmó la temperatura de operación del equipo.',
    fotos: [1, 2, 3, 4].map((n) => ({ thumb: placeholder(n), full: placeholder(n), nombre: `Foto ${n}` }))
  };
}

async function fetchService(token) {
  const key = process.env.AIRTABLE_TOKEN;
  if (!key) throw new Error('Falta AIRTABLE_TOKEN');

  const url = new URL(`https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}`);
  // El token ya pasó TOKEN_RE (solo letras, números, - y _), así que es seguro dentro de la fórmula.
  url.searchParams.set(
    'filterByFormula',
    `AND({${F.token}}='${token}',{${F.active}},NOT({${F.cierre}}=BLANK()))`
  );
  url.searchParams.set('maxRecords', '1');
  [F.folio, F.tipo, F.falla, F.lugar, F.direccion, F.cierre, F.comentario, F.serie, F.fotos].forEach((f) =>
    url.searchParams.append('fields[]', f)
  );

  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Airtable respondió ${res.status}`);
  const data = await res.json();
  const rec = data.records && data.records[0];
  if (!rec) return null;

  const f = rec.fields || {};
  const fotos = (Array.isArray(f[F.fotos]) ? f[F.fotos] : [])
    .filter((a) => a && a.url && String(a.type || '').startsWith('image/'))
    .map((a) => ({
      thumb: (a.thumbnails && a.thumbnails.large && a.thumbnails.large.url) || a.url,
      full: a.url,
      nombre: a.filename || ''
    }));

  return {
    folio: f[F.folio] || '',
    tipo: f[F.tipo] || '',
    falla: f[F.falla] || '',
    lugar: f[F.lugar] || '',
    direccion: f[F.direccion] || '',
    cierre: f[F.cierre] || '',
    serie: f[F.serie] || '',
    comentario: f[F.comentario] || '',
    fotos
  };
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
h1{margin:0;font-size:30px;line-height:1.15;font-weight:800;letter-spacing:-.01em}
.sub{margin:6px 0 0;color:var(--muted);font-size:16px}
.card{background:var(--card);border-radius:20px;padding:18px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.k{font-size:11px;font-weight:700;letter-spacing:.14em;color:var(--orange);text-transform:uppercase}
.v{margin-top:3px;font-size:15px;font-weight:600;overflow-wrap:anywhere}
.full{grid-column:1/-1}
h2{margin:0 0 10px;font-size:13px;font-weight:700;color:#D5DEE5}
.coment{margin:0;font-size:15px;color:#E6EDF2;white-space:pre-line}
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

function page({ title, desc, image, body, canonical }) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex, nofollow">
<meta name="description" content="${esc(desc)}">
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
</head>
<body>
${body}
</body>
</html>`;
}

function footer() {
  return `<div class="foot"><b>MantenGO</b> · WhatsApp y teléfono <a href="https://wa.me/${WHATSAPP}">442 450 1585</a><br><a href="mailto:contacto@mantengo.mx">contacto@mantengo.mx</a> · <a href="https://mantengo.mx">mantengo.mx</a></div>`;
}

function renderService(s, token, base, isDemo) {
  const titulo = [s.tipo, s.falla].filter(Boolean).join(' · ') || 'Servicio terminado';
  const waText = encodeURIComponent(`Hola, vi el servicio ${s.folio} y quiero cotizar otro servicio.`);

  const meta = [];
  meta.push(`<div><div class="k">Folio</div><div class="v">${esc(s.folio)}</div></div>`);
  meta.push(`<div><div class="k">Fecha de cierre</div><div class="v">${esc(fechaLarga(s.cierre))}</div></div>`);
  if (s.serie) meta.push(`<div><div class="k">Equipo (serie)</div><div class="v">${esc(s.serie)}</div></div>`);
  if (s.direccion) meta.push(`<div class="${s.serie ? '' : 'full'}"><div class="k">Dirección</div><div class="v">${esc(s.direccion)}</div></div>`);

  const coment = s.comentario
    ? `<section class="card"><h2>Comentario de cierre</h2><p class="coment">${esc(s.comentario)}</p></section>`
    : '';

  const fotos = s.fotos.length
    ? `<section class="card"><h2>Evidencia fotográfica (${s.fotos.length})</h2>
<div class="fotos">${s.fotos
        .map((p, i) => `<a href="#f${i + 1}" aria-label="Ver foto ${i + 1} en grande"><img src="${esc(p.thumb)}" alt="Evidencia ${i + 1} del servicio ${esc(s.folio)}" loading="lazy"></a>`)
        .join('')}</div></section>
${s.fotos
        .map((p, i) => `<a class="lb" id="f${i + 1}" href="#" aria-label="Cerrar"><span aria-hidden="true">&times;</span><img src="${esc(p.full)}" alt="Evidencia ${i + 1} ampliada"></a>`)
        .join('')}`
    : '';

  const body = `<main class="wrap">
<img class="logo" src="/assets/logo.png" alt="MantenGO" width="357" height="76">
<div>
<div class="badge">${CHECK} SERVICIO TERMINADO</div>
<h1 style="margin-top:14px">${esc(titulo)}</h1>
${s.lugar ? `<p class="sub">${esc(s.lugar)}</p>` : ''}
</div>
<section class="card"><div class="grid">${meta.join('')}</div></section>
${coment}
${fotos}
<section class="card cta">
<div class="t"><h3>¿Necesitas otro servicio?</h3><p>Instalación, reparación, retiro o rehabilitación de tus equipos. Te respondemos con una propuesta clara.</p>
<a class="btn" href="https://wa.me/${WHATSAPP}?text=${waText}">Cotizar por WhatsApp</a></div>
<img src="/assets/yeti.png" alt="Mascota de MantenGO" width="225" height="285">
</section>
${footer()}
${isDemo ? '<div class="foot">Vista de ejemplo con datos ficticios.</div>' : ''}
</main>`;

  const ogImage = s.fotos.length && !isDemo ? `${base}/i/${token}/1` : `${base}/assets/yeti.png`;
  return page({
    title: `Servicio terminado · ${s.folio}`,
    desc: [titulo, s.lugar, fechaLarga(s.cierre)].filter(Boolean).join(' · '),
    image: base ? ogImage : '',
    canonical: base ? `${base}/s/${token}` : '',
    body
  });
}

function renderUnavailable() {
  const body = `<main class="wrap empty">
<img class="logo" src="/assets/logo.png" alt="MantenGO" width="357" height="76">
<h1>Este enlace no está disponible</h1>
<p class="sub">Puede que el servicio aún no esté cerrado, que el enlace haya sido desactivado o que esté incompleto. Si lo recibiste de MantenGO, pídenos uno nuevo.</p>
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
    const m = s.match(/\/(s|i)\/([^/?#]+)(?:\/(\d+))?/);
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
      const foto = s && s.fotos[n - 1];
      if (!foto) return { statusCode: 404, body: '' };
      return { statusCode: 302, headers: { Location: foto.thumb, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }, body: '' };
    } catch (e) {
      return { statusCode: 502, body: '' };
    }
  }

  if (token === 'demo' && demoOn) {
    return { statusCode: 200, headers: BASE_HEADERS, body: renderService(demoService(), 'demo', base, true) };
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

exports._test = { TOKEN_RE, renderService, demoService };
