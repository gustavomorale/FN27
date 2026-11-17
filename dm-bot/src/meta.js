// Meta Graph API calls: Instagram (Instagram Login) and WhatsApp Cloud API.

const IG_HOST = 'https://graph.instagram.com';
const FB_HOST = 'https://graph.facebook.com';

async function call(url, token, body, method = 'POST') {
  const res = await fetch(url, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok || data?.error) {
    const err = new Error(data?.error?.message || `Meta API ${res.status}`);
    err.meta = data?.error; err.status = res.status;
    throw err;
  }
  return data;
}

export async function igToken(env) {
  const row = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind('ig_token').first();
  return row?.v || env.IG_ACCESS_TOKEN;
}

const v = env => env.GRAPH_VERSION || 'v24.0';

// ---------- Instagram ----------

/** recipient: { id } for a DM, { comment_id } for a private reply to a comment */
export async function igSendRaw(env, recipient, message) {
  const token = await igToken(env);
  return call(`${IG_HOST}/${v(env)}/${env.IG_USER_ID}/messages`, token, { recipient, message });
}

/**
 * Send text with optional URL buttons and quick replies.
 * Falls back to plain text (links appended) if the template is rejected.
 */
export async function igSend(env, recipient, { text, buttons = [], quickReplies = [] }) {
  const urlButtons = buttons.filter(b => b?.url && b?.title).slice(0, 3);
  const qrs = quickReplies.filter(Boolean).slice(0, 13).map(t => ({ content_type: 'text', title: String(t).slice(0, 20), payload: 'QR:' + t }));
  let message;
  if (urlButtons.length) {
    message = { attachment: { type: 'template', payload: {
      template_type: 'button', text: text.slice(0, 640),
      buttons: urlButtons.map(b => ({ type: 'web_url', url: b.url, title: b.title.slice(0, 20) })),
    } } };
  } else {
    message = { text: text.slice(0, 1000) };
  }
  if (qrs.length) message.quick_replies = qrs;
  try {
    return await igSendRaw(env, recipient, message);
  } catch (e) {
    if (!urlButtons.length) throw e;
    const plain = text + '\n\n' + urlButtons.map(b => `${b.title}: ${b.url}`).join('\n');
    const fallback = { text: plain.slice(0, 1000) };
    if (qrs.length) fallback.quick_replies = qrs;
    return igSendRaw(env, recipient, fallback);
  }
}

export async function igReplyToComment(env, commentId, text) {
  const token = await igToken(env);
  return call(`${IG_HOST}/${v(env)}/${commentId}/replies`, token, { message: text });
}

export async function igProfile(env, igsid) {
  try {
    const token = await igToken(env);
    return await call(`${IG_HOST}/${v(env)}/${igsid}?fields=name,username`, token, null, 'GET');
  } catch { return null; }
}

export async function igRefreshToken(env) {
  const token = await igToken(env);
  const res = await fetch(`${IG_HOST}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`);
  const data = await res.json();
  if (!data.access_token) throw new Error(data?.error?.message || 'IG token refresh failed');
  await env.DB.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at')
    .bind('ig_token', data.access_token, Date.now()).run();
  return { expiresIn: data.expires_in };
}

export async function igMe(env) {
  const token = await igToken(env);
  return call(`${IG_HOST}/${v(env)}/me?fields=user_id,username,name`, token, null, 'GET');
}

// Instagram Login apps must switch on webhooks for the account itself
export async function igSubscribe(env) {
  const token = await igToken(env);
  return call(`${IG_HOST}/${v(env)}/me/subscribed_apps?subscribed_fields=messages,messaging_postbacks,comments,live_comments`, token, null, 'POST');
}

export async function igSubscriptions(env) {
  const token = await igToken(env);
  return call(`${IG_HOST}/${v(env)}/me/subscribed_apps`, token, null, 'GET');
}

// ---------- WhatsApp ----------

export async function waSendRaw(env, payload) {
  return call(`${FB_HOST}/${v(env)}/${env.WA_PHONE_NUMBER_ID}/messages`, env.WA_TOKEN, { messaging_product: 'whatsapp', ...payload });
}

/** Text, one URL button (cta_url) or up to 3 reply buttons. Falls back to plain text. */
export async function waSend(env, to, { text, buttons = [], quickReplies = [] }) {
  const urlButton = buttons.find(b => b?.url && b?.title);
  const replies = quickReplies.filter(Boolean).slice(0, 3);
  let payload;
  if (urlButton && !replies.length) {
    payload = { to, type: 'interactive', interactive: { type: 'cta_url', body: { text: text.slice(0, 1024) },
      action: { name: 'cta_url', parameters: { display_text: urlButton.title.slice(0, 20), url: urlButton.url } } } };
  } else if (replies.length) {
    payload = { to, type: 'interactive', interactive: { type: 'button', body: { text: text.slice(0, 1024) },
      action: { buttons: replies.map((t, i) => ({ type: 'reply', reply: { id: 'qr_' + i, title: String(t).slice(0, 20) } })) } } };
  } else {
    payload = { to, type: 'text', text: { body: text.slice(0, 4096), preview_url: true } };
  }
  try {
    return await waSendRaw(env, payload);
  } catch (e) {
    if (payload.type === 'text') throw e;
    const extra = buttons.filter(b => b?.url).map(b => `${b.title}: ${b.url}`).join('\n');
    return waSendRaw(env, { to, type: 'text', text: { body: (text + (extra ? '\n\n' + extra : '')).slice(0, 4096), preview_url: true } });
  }
}

export async function waMarkRead(env, messageId) {
  try { await waSendRaw(env, { status: 'read', message_id: messageId }); } catch { /* not critical */ }
}

export async function waTemplates(env) {
  const data = await call(`${FB_HOST}/${v(env)}/${env.WA_WABA_ID}/message_templates?fields=name,language,status,category,components&limit=200`, env.WA_TOKEN, null, 'GET');
  return data.data || [];
}

export async function waSendTemplate(env, to, { name, language, bodyParams = [] }) {
  const template = { name, language: { code: language } };
  if (bodyParams.length) template.components = [{ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: String(t) })) }];
  return waSendRaw(env, { to, type: 'template', template });
}

export async function waPhoneInfo(env) {
  return call(`${FB_HOST}/${v(env)}/${env.WA_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating`, env.WA_TOKEN, null, 'GET');
}

export async function waSubscribe(env) {
  return call(`${FB_HOST}/${v(env)}/${env.WA_WABA_ID}/subscribed_apps`, env.WA_TOKEN, null, 'POST');
}

export async function waSubscriptions(env) {
  return call(`${FB_HOST}/${v(env)}/${env.WA_WABA_ID}/subscribed_apps`, env.WA_TOKEN, null, 'GET');
}

// ---------- Webhook signature ----------

export async function verifySignature(rawBody, header, secrets) {
  if (!header || !header.startsWith('sha256=')) return false;
  const given = header.slice(7);
  for (const secret of secrets.filter(Boolean)) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
    const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
    if (timingSafeEqual(hex, given)) return true;
  }
  return false;
}

export function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
