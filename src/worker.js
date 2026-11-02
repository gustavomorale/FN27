// FN · Desafio Reset Metabólico · Cloudflare Worker
// Serve the static site from /public and handle two small form endpoints.
//
//   POST /api/lead     { email, consent, angulo, page, utm_* }  → LEAD_WEBHOOK_URL
//   POST /api/answers  { lugar, objetivo, utm_* }               → ANSWERS_WEBHOOK_URL
//
// Webhook URLs and the optional WEBHOOK_TOKEN are Cloudflare secrets, never in the page code.
// With no webhook set, the endpoints answer OK without forwarding (test mode).

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function pick(src, keys) {
  const out = {};
  for (const k of keys) if (typeof src[k] === "string" && src[k].length <= 300) out[k] = src[k];
  return out;
}

async function forward(target, body, env) {
  if (!target) return json({ ok: true, forwarded: false });
  const headers = { "content-type": "application/json" };
  if (env.WEBHOOK_TOKEN) headers.authorization = `Bearer ${env.WEBHOOK_TOKEN}`;
  try {
    const r = await fetch(target, { method: "POST", headers, body: JSON.stringify(body) });
    if (!r.ok) {
      console.error("webhook failed", r.status);
      return json({ ok: false, error: "upstream" }, 502);
    }
    return json({ ok: true, forwarded: true });
  } catch (e) {
    console.error("webhook error", e && e.message);
    return json({ ok: false, error: "upstream" }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/lead" || url.pathname === "/api/answers") {
      if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
      const origin = request.headers.get("origin");
      if (origin && new URL(origin).host !== url.host) return json({ ok: false, error: "origin" }, 403);

      let data;
      try { data = await request.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
      if (!data || typeof data !== "object") return json({ ok: false, error: "invalid_json" }, 400);

      const meta = {
        received_at: new Date().toISOString(),
        country: (request.cf && request.cf.country) || null, // "onde você mora" sem perguntar
        source: "fn-desafio-reset-v3",
      };

      if (url.pathname === "/api/lead") {
        const email = String(data.email || "").trim().toLowerCase();
        if (!EMAIL.test(email) || email.length > 254) return json({ ok: false, error: "email" }, 400);
        if (data.consent !== true) return json({ ok: false, error: "consent" }, 400);
        const body = { email, consent: true, ...pick(data, ["angulo", "page", ...UTM]), ...meta };
        return forward(env.LEAD_WEBHOOK_URL, body, env);
      }

      const body = { ...pick(data, ["lugar", "objetivo", ...UTM]), ...meta };
      return forward(env.ANSWERS_WEBHOOK_URL, body, env);
    }

    // Everything else is the static site
    return env.ASSETS.fetch(request);
  },
};
