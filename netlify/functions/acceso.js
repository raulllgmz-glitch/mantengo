'use strict';
// Entrada por teléfono con PIN (Twilio Verify). El contacto debe estar dado de alta en la tabla Contactos.
//
// POST /api/acceso
//   { action: 'pedir', tel }         → manda el PIN (siempre responde ok, exista o no el teléfono)
//   { action: 'verificar', tel, pin } → { ok, sesion, nombre }
//
// Variables: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SID, SESSION_SECRET,
//            OTP_CHANNEL (sms | whatsapp, por defecto sms), AIRTABLE_TOKEN.

const A = require('../lib/acceso');

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

async function twilio(path, params) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const res = await fetch(`https://verify.twilio.com/v2/Services/${process.env.TWILIO_VERIFY_SID}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(params).toString()
  });
  let body = {};
  try {
    body = await res.json();
  } catch (e) {
    /* sin cuerpo */
  }
  return { status: res.status, body };
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
  if (!key() || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_VERIFY_SID ||
      String(process.env.SESSION_SECRET || '').length < 24) {
    return reply(503, { error: 'config' });
  }
  if (String(event.body || '').length > 500) return reply(413, { error: 'tamano' });
  let b;
  try {
    b = JSON.parse(event.body || '{}');
  } catch (e) {
    return reply(400, { error: 'json' });
  }
  const tel = A.telDiez(b.tel);
  if (!tel) return reply(400, { error: 'telefono' });
  const canal = process.env.OTP_CHANNEL === 'whatsapp' ? 'whatsapp' : 'sms';

  try {
    const contacto = await A.contactoPorTel(key(), tel);

    if (b.action === 'pedir') {
      if (!contacto) {
        await wait(700); // misma espera que cuando sí se manda, para no delatar qué teléfonos existen
        return reply(200, { ok: true });
      }
      const r = await twilio('Verifications', { To: `+52${tel}`, Channel: canal });
      if (r.status === 429) return reply(429, { error: 'espera' });
      if (r.status >= 300) {
        console.error('acceso twilio pedir', r.status, r.body && r.body.code);
        return reply(502, { error: 'envio' });
      }
      return reply(200, { ok: true });
    }

    if (b.action === 'verificar') {
      const pin = String(b.pin || '');
      if (!/^\d{4,8}$/.test(pin)) return reply(400, { error: 'pin' });
      if (!contacto) {
        await wait(700);
        return reply(401, { error: 'pin' });
      }
      const r = await twilio('VerificationCheck', { To: `+52${tel}`, Code: pin });
      if (r.status === 429) return reply(429, { error: 'espera' });
      if (r.status !== 200 || !r.body || r.body.status !== 'approved') {
        await wait(400);
        return reply(401, { error: 'pin' });
      }
      const sesion = A.firmar({ c: contacto.id, m: contacto.marca });
      return reply(200, { ok: true, sesion, nombre: contacto.nombre });
    }
    return reply(400, { error: 'accion' });
  } catch (e) {
    console.error('acceso', e && e.status, e && e.message);
    return reply(502, { error: 'airtable' });
  }
};
