/* FN · Reset Metabólico v3 · comportamento das páginas (sem dependências) */
(function () {
  "use strict";
  var C = window.FN_CONFIG || {};
  var page = document.body.getAttribute("data-page");

  /* ---------- utilidades ---------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }

  var DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
  var MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  function parseDate(s) { if (!s) return null; var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function fmt(s, withWeekday) {
    var d = parseDate(s); if (!d) return null;
    var t = d.getDate() + " de " + MESES[d.getMonth()];
    return withWeekday ? DIAS[d.getDay()] + ", " + t : t;
  }

  // Preenche [data-fill] com as datas da configuração; esconde o que não tem data
  $$("[data-fill]").forEach(function (el) {
    var key = el.getAttribute("data-fill");
    var val = fmt(C[key], el.hasAttribute("data-weekday"));
    if (val) { el.textContent = val; }
    else { var w = el.closest("[data-needs]"); if (w) w.hidden = true; /* senão, fica o texto padrão do HTML */ }
  });

  // Medição: Meta Pixel (fbq) e/ou Google Tag Manager (dataLayer), se existirem na página
  function track(event, params, custom) {
    try { if (window.fbq) window.fbq(custom ? "trackCustom" : "track", event, params || {}); } catch (e) {}
    try { (window.dataLayer = window.dataLayer || []).push(Object.assign({ event: event }, params || {})); } catch (e) {}
  }

  // UTMs da URL, para levar adiante
  var qs = new URLSearchParams(location.search);
  function utms() {
    var o = {};
    ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"].forEach(function (k) { if (qs.get(k)) o[k] = qs.get(k); });
    return o;
  }

  // Vídeos: só aparecem se o arquivo existir; senão fica a foto
  $$("[data-video]").forEach(function (slot) {
    var src = (C.videos || {})[slot.getAttribute("data-video")];
    var fallback = slot.nextElementSibling && slot.nextElementSibling.hasAttribute("data-video-fallback") ? slot.nextElementSibling : null;
    if (!src) return;
    fetch(src, { method: "HEAD" }).then(function (r) {
      if (!r.ok) return;
      var v = slot.querySelector("video");
      v.src = src; slot.hidden = false; if (fallback) fallback.hidden = true;
      v.addEventListener("play", function once() { track("VideoPlay", { video: slot.getAttribute("data-video") }, true); v.removeEventListener("play", once); });
    }).catch(function () {});
  });

  $$("[data-privacy]").forEach(function (a) { if (C.politicaPrivacidade) a.href = C.politicaPrivacidade; });

  /* ---------- landing ---------- */
  if (page === "landing") {
    // Título conforme o ângulo do anúncio: ?angulo=inchaco|historia|promessa ou utm_content contendo a palavra
    var ang = (qs.get("angulo") || qs.get("utm_content") || "").toLowerCase();
    var key = /incha/.test(ang) ? "inchaco" : /hist/.test(ang) ? "historia" : "promessa";
    $$("[data-angle]").forEach(function (el) { el.hidden = el.getAttribute("data-angle") !== key; });

    // Formulário
    var form = $("#participar"), email = $("#email"), consent = $("#consent"), msg = $("#form-msg"), btn = form && form.querySelector("button[type=submit]");
    if (form) form.addEventListener("submit", function (e) {
      e.preventDefault();
      var ok = email.checkValidity() && email.value.trim() !== "";
      email.setAttribute("aria-invalid", ok ? "false" : "true");
      if (!ok) { msg.textContent = "Confira o seu e-mail."; msg.className = "form-msg err"; email.focus(); return; }
      if (!consent.checked) { msg.textContent = "Marque a caixa para receber as mensagens do desafio."; msg.className = "form-msg err"; consent.focus(); return; }
      btn.disabled = true; msg.textContent = "Enviando…"; msg.className = "form-msg";
      var payload = Object.assign({ email: email.value.trim(), consent: true, page: location.pathname, angulo: key }, utms());
      var go = function () {
        track("Lead", { content_name: "Reset Metabólico" });
        var next = new URL(C.paginaObrigado || "../obrigado-reset-metabolico-v3/", location.href);
        Object.keys(utms()).forEach(function (k) { next.searchParams.set(k, utms()[k]); });
        location.href = next.toString();
      };
      if (!C.formEndpoint) { go(); return; }
      fetch(C.formEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        .then(function (r) { if (!r.ok) throw new Error(r.status); go(); })
        .catch(function () { btn.disabled = false; msg.textContent = "Não conseguimos enviar agora. Tente de novo em instantes."; msg.className = "form-msg err"; });
    });

    // Barra fixa no celular: aparece depois que o formulário sai da tela
    var bar = $(".sticky");
    if (bar && form && "IntersectionObserver" in window) {
      new IntersectionObserver(function (en) { bar.classList.toggle("show", !en[0].isIntersecting && en[0].boundingClientRect.top < 0); }).observe(form);
    }
  }

  /* ---------- obrigado ---------- */
  if (page === "obrigado") {
    $$("[data-wa]").forEach(function (a) {
      if (C.grupoWhatsApp) a.href = C.grupoWhatsApp;
      a.addEventListener("click", function () { track("JoinWhatsAppGroup", { content_name: "Reset Metabólico" }, true); });
    });

    var sup = $("[data-support]");
    if (sup) { if (C.suporteWhatsApp) { sup.href = "https://wa.me/" + C.suporteWhatsApp; sup.textContent = "+" + C.suporteWhatsApp; } else { var w = sup.closest("[data-needs]"); if (w) w.hidden = true; } }

    // Calendário: gera um .ics com o início do desafio
    var cal = $("#add-cal");
    if (cal) {
      if (!C.inicioEm) { cal.hidden = true; }
      else cal.addEventListener("click", function () {
        var d = C.inicioEm.replace(/-/g, ""), d2 = parseDate(C.inicioEm); d2.setDate(d2.getDate() + 7);
        var end = d2.getFullYear() + String(d2.getMonth() + 1).padStart(2, "0") + String(d2.getDate()).padStart(2, "0");
        var ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Fernanda Nadaline//Reset Metabolico//PT", "BEGIN:VEVENT",
          "UID:reset-" + d + "@desafiofernandanadaline.com", "DTSTAMP:" + new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z",
          "DTSTART;VALUE=DATE:" + d, "DTEND;VALUE=DATE:" + end, "SUMMARY:Desafio Reset Metabólico · Fernanda Nadaline",
          "DESCRIPTION:7 dias de desafio no grupo do WhatsApp: " + (C.grupoWhatsApp || ""), "END:VEVENT", "END:VCALENDAR"].join("\r\n");
        var a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
        a.download = "reset-metabolico.ics"; document.body.appendChild(a); a.click(); a.remove();
        track("AddToCalendar", {}, true);
      });
    }

    // As duas perguntas da Fernanda
    var answers = {};
    $$(".chips").forEach(function (group) {
      var k = group.getAttribute("data-q");
      group.addEventListener("click", function (e) {
        var b = e.target.closest(".chip"); if (!b) return;
        $$(".chip", group).forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
        answers[k] = b.textContent.trim();
        if (answers.lugar && answers.objetivo) {
          $("#q-done").hidden = false;
          track("SurveyAnswered", answers, true);
          if (C.respostasEndpoint) fetch(C.respostasEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({}, answers, utms())) }).catch(function () {});
        }
      });
    });
  }
})();
