/* Entrada por teléfono + PIN. Uso: MGA.login(contenedor, function (sesion) {...}) */
(function () {
  'use strict';
  var KEY = 'mg_ses', TEL = 'mg_tel';
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k) || ''; if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return ''; } }
  function vigente(t) {
    try { var p = JSON.parse(atob(t.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))); return p.e * 1000 > Date.now() + 60000; } catch (e) { return false; }
  }
  function token() { var t = ls(KEY); return t && vigente(t) ? t : ''; }
  function clear() { ls(KEY, null); }

  var css = '.mga{background:var(--card,#16262F);border:1px solid var(--line,#2A3E4D);border-radius:18px;padding:22px;margin-top:8px}' +
    '.mga h2{margin:0 0 6px;font-size:21px}.mga p{margin:0 0 16px;color:var(--muted,#A9B8C3);font-size:15px}' +
    '.mga input{width:100%;min-height:54px;border-radius:14px;border:1.5px solid var(--line,#2A3E4D);background:#0F1B24;color:#fff;font:600 20px Inter,system-ui,sans-serif;padding:0 16px;letter-spacing:1px;margin-bottom:12px}' +
    '.mga input:focus{outline:none;border-color:var(--orange,#F5A623)}' +
    '.mga button.go{display:flex;align-items:center;justify-content:center;width:100%;min-height:54px;border:0;border-radius:999px;background:var(--orange,#F5A623);color:#0F1B24;font:800 17px Inter,system-ui,sans-serif;cursor:pointer}' +
    '.mga button.go:disabled{opacity:.55;cursor:default}' +
    '.mga .lnk{background:none;border:0;color:var(--orange,#F5A623);font:600 14px Inter,system-ui,sans-serif;padding:12px 4px;cursor:pointer}' +
    '.mga .e{color:#FF8A8A;font-size:14px;min-height:20px;margin:0 0 10px}.mga .row{display:flex;justify-content:space-between;gap:8px}';

  function login(box, ok) {
    if (!document.getElementById('mga-css')) { var s = document.createElement('style'); s.id = 'mga-css'; s.textContent = css; document.head.appendChild(s); }
    var tel = '';
    function post(body) {
      return fetch('/api/acceso', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { d._status = r.status; return d; }); });
    }
    function paso1(msg) {
      box.innerHTML = '<div class="mga"><h2>Entra con tu teléfono</h2><p>Te mandamos un PIN por mensaje de texto.</p>' +
        '<input id="mga-t" type="tel" inputmode="numeric" autocomplete="tel-national" placeholder="10 dígitos" maxlength="16">' +
        '<p class="e" id="mga-e">' + (msg || '') + '</p><button class="go" id="mga-b" type="button">Enviarme el PIN</button></div>';
      var t = box.querySelector('#mga-t'), b = box.querySelector('#mga-b'), e = box.querySelector('#mga-e');
      t.value = ls(TEL);
      function enviar() {
        var d = t.value.replace(/\D/g, '');
        if (d.length < 10) { e.textContent = 'Escribe tu número de 10 dígitos.'; return; }
        tel = d.slice(-10); b.disabled = true; b.textContent = 'Enviando…'; e.textContent = '';
        post({ action: 'pedir', tel: tel }).then(function (r) {
          if (r.ok) { ls(TEL, tel); return paso2(r.prueba ? 'Modo de prueba: no se mandó SMS. Escribe el PIN de prueba.' : ''); }
          b.disabled = false; b.textContent = 'Enviarme el PIN';
          e.textContent = r._status === 429 ? 'Ya te mandamos un PIN. Espera un momento antes de pedir otro.' : 'No pudimos enviar el PIN. Inténtalo de nuevo.';
        }).catch(function () { b.disabled = false; b.textContent = 'Enviarme el PIN'; e.textContent = 'Sin conexión. Revisa tu internet.'; });
      }
      b.addEventListener('click', enviar);
      t.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') enviar(); });
      t.focus();
    }
    function paso2(msg) {
      box.innerHTML = '<div class="mga"><h2>Escribe tu PIN</h2><p>Si tu número está registrado, te llegó un PIN al ' + tel.replace(/(\d{2})(\d{4})(\d{4})/, '$1 $2 $3') + '.</p>' +
        '<input id="mga-p" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="PIN" maxlength="8">' +
        '<p class="e" id="mga-e">' + (msg || '') + '</p><button class="go" id="mga-b" type="button">Entrar</button>' +
        '<div class="row"><button class="lnk" id="mga-c" type="button">Cambiar número</button><button class="lnk" id="mga-r" type="button" disabled>Reenviar PIN</button></div></div>';
      var p = box.querySelector('#mga-p'), b = box.querySelector('#mga-b'), e = box.querySelector('#mga-e'), rs = box.querySelector('#mga-r');
      setTimeout(function () { rs.disabled = false; }, 30000);
      function entrar() {
        var v = p.value.replace(/\D/g, '');
        if (v.length < 4) { e.textContent = 'Escribe el PIN que recibiste.'; return; }
        b.disabled = true; b.textContent = 'Verificando…'; e.textContent = '';
        post({ action: 'verificar', tel: tel, pin: v }).then(function (r) {
          if (r.ok && r.sesion) { ls(KEY, r.sesion); return ok(r.sesion, r.nombre || ''); }
          b.disabled = false; b.textContent = 'Entrar';
          e.textContent = r._status === 429 ? 'Demasiados intentos. Pide un PIN nuevo en unos minutos.' : 'PIN incorrecto o vencido.';
        }).catch(function () { b.disabled = false; b.textContent = 'Entrar'; e.textContent = 'Sin conexión. Revisa tu internet.'; });
      }
      b.addEventListener('click', entrar);
      p.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') entrar(); });
      box.querySelector('#mga-c').addEventListener('click', function () { paso1(''); });
      rs.addEventListener('click', function () {
        rs.disabled = true;
        post({ action: 'pedir', tel: tel }).then(function (r) { e.textContent = r.ok ? 'Te mandamos otro PIN.' : 'Espera un momento antes de pedir otro.'; setTimeout(function () { rs.disabled = false; }, 30000); });
      });
      p.focus();
    }
    paso1('');
  }
  window.MGA = { token: token, clear: clear, login: login };
})();
