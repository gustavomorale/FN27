// FN DM automation: Meta webhook -> keyword flows -> Claude fallback -> Meta send.
import { parseWebhook, matchFlow, isKeyword, fill, pick, shouldSend } from './engine.js';
import * as meta from './meta.js';
import * as db from './db.js';
import { aiReply } from './ai.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const HOUR = 3600_000;
const DAY = 24 * HOUR;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/webhook' && request.method === 'GET') return verifyWebhook(url, env);
      if (url.pathname === '/webhook' && request.method === 'POST') return receiveWebhook(request, env, ctx);
      if (url.pathname.startsWith('/api/')) return api(request, env, url);
      if (url.pathname === '/') return Response.redirect(url.origin + '/panel/', 302);
      return new Response('Not found', { status: 404 });
    } catch (e) {
      console.error(e);
      return json({ error: e.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try { await meta.igRefreshToken(env); } catch (e) { console.error('IG refresh', e.message); }
      const settings = await db.getSettings(env);
      await env.DB.prepare('DELETE FROM seen WHERE created_at < ?').bind(Date.now() - 30 * DAY).run();
      await env.DB.prepare('DELETE FROM messages WHERE created_at < ?').bind(Date.now() - (settings.retentionDays || 365) * DAY).run();
    })());
  },
};

// ---------------- Webhook ----------------

function verifyWebhook(url, env) {
  if (url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === env.META_VERIFY_TOKEN) {
    return new Response(url.searchParams.get('hub.challenge') || '', { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

async function receiveWebhook(request, env, ctx) {
  if (Number(request.headers.get('content-length') || 0) > 1_000_000) return new Response('Too large', { status: 413 });
  const raw = await request.text();
  if (raw.length > 1_000_000) return new Response('Too large', { status: 413 });
  const ok = await meta.verifySignature(raw, request.headers.get('x-hub-signature-256'), [env.IG_APP_SECRET, env.META_APP_SECRET]);
  if (!ok) return new Response('Bad signature', { status: 401 });
  let body;
  try { body = JSON.parse(raw); } catch { return new Response('Bad JSON', { status: 400 }); }
  const events = parseWebhook(body, { igUserId: env.IG_USER_ID });
  if (events.length) ctx.waitUntil(processEvents(env, events));
  return new Response('EVENT_RECEIVED', { status: 200 });
}

export async function processEvents(env, events) {
  const settings = await db.getSettings(env);
  const flows = await db.getFlows(env);
  for (const ev of events) {
    try { await handleEvent(env, ev, settings, flows); }
    catch (e) {
      console.error('event failed', ev.type, e.message, e.meta);
      try { await db.logMessage(env, { channel: ev.channel, contactId: ev.contactId, direction: 'out', kind: 'system', text: 'Erro: ' + e.message, source: 'system' }); } catch { /* ignore */ }
    }
  }
}

async function handleEvent(env, ev, settings, flows) {
  if (ev.type === 'wa_failed') {
    await db.logMessage(env, { channel: 'wa', contactId: ev.contactId, direction: 'out', kind: 'system', text: 'Falha de entrega: ' + (ev.errors?.[0]?.title || ''), source: 'system', meta: ev.errors });
    return;
  }
  if (!(await db.firstSeen(env, ev.mid))) return; // Meta retries

  if (ev.type === 'ig_echo') return handleEcho(env, ev, settings);

  const fields = ev.channel === 'wa' ? { name: ev.name } : { username: ev.username };
  let { contact, isNew } = await db.upsertContact(env, ev.channel, ev.contactId, fields);
  if (isNew && ev.type === 'ig_dm') {
    const p = await meta.igProfile(env, ev.contactId);
    if (p) { await db.updateContact(env, 'ig', ev.contactId, { name: p.name || null, username: p.username || null }); contact = { ...contact, name: p.name, username: p.username }; }
  }

  const isConversation = ev.type === 'ig_dm' || ev.type === 'wa';
  await db.logMessage(env, { channel: ev.channel, contactId: ev.contactId, direction: 'in', kind: ev.type === 'ig_comment' ? 'comment' : 'dm', text: ev.text || (ev.hasAttachment || ev.msgType !== 'text' ? `[${ev.msgType || 'anexo'}]` : ''), source: 'user', meta: ev.type === 'ig_comment' ? { mediaId: ev.mediaId, commentId: ev.commentId } : null });
  if (isConversation) await db.updateContact(env, ev.channel, ev.contactId, { last_inbound: Date.now() });
  if (settings.mode === 'paused') return; // kill switch: log only
  const live = shouldSend(contact, settings);
  if (ev.type === 'wa' && live) await meta.waMarkRead(env, ev.mid);

  // Human takeover expires after the timeout
  if (contact.mode === 'human' && contact.human_until && Date.now() > contact.human_until) {
    await db.updateContact(env, contact.channel, contact.id, { mode: 'bot', human_until: null });
    contact.mode = 'bot';
  }

  // ---- Comments: keyword -> public reply + private DM (once per person, per post, per flow)
  if (ev.type === 'ig_comment') {
    const flow = matchFlow(flows, { trigger: 'ig_comment', text: ev.text, mediaId: ev.mediaId });
    if (!flow) return;
    if (!(await db.firstSeen(env, `pr:${flow.id}:${ev.mediaId}:${ev.contactId}`))) return;
    const pub = pick(flow.publicReplies);
    if (pub) {
      try {
        if (live) await meta.igReplyToComment(env, ev.commentId, fill(pub, contact));
        await db.logMessage(env, { channel: 'ig', contactId: ev.contactId, direction: 'out', kind: 'comment_reply', text: fill(pub, contact), source: (live ? '' : 'shadow:') + 'flow:' + flow.id });
      } catch (e) { console.error('public reply', e.message); }
    }
    await sendTo(env, settings, contact, flowPayload(flow, contact), { source: 'flow:' + flow.id, recipient: { comment_id: ev.commentId }, kind: 'private_reply' });
    await db.addTags(env, contact, flow.addTags);
    return;
  }

  // ---- DMs and WhatsApp
  const text = ev.text || '';
  if (isKeyword(text, settings.optOutKeywords)) {
    await db.updateContact(env, contact.channel, contact.id, { opted_out: true });
    await sendTo(env, settings, contact, { text: settings.optOutReply }, { source: 'system' });
    return;
  }
  if (isKeyword(text, settings.optInKeywords)) {
    await db.updateContact(env, contact.channel, contact.id, { opted_out: false });
    await sendTo(env, settings, contact, { text: settings.optInReply }, { source: 'system' });
    return;
  }

  if (contact.mode === 'human') {
    await db.updateContact(env, contact.channel, contact.id, { needs_human: true });
    return;
  }

  const trigger = ev.type === 'wa' ? 'wa' : 'ig_dm';
  const flow = text ? matchFlow(flows, { trigger, text }) : null;
  if (flow) {
    await sendTo(env, settings, contact, flowPayload(flow, contact), { source: 'flow:' + flow.id });
    await db.addTags(env, contact, flow.addTags);
    return;
  }

  // Non-text (audio, image, sticker): let a human see it
  if (!text.trim()) {
    await flagHuman(env, settings, contact, 'Mensagem sem texto (áudio, imagem ou anexo)');
    await sendTo(env, settings, contact, { text: settings.ai.fallbackMessage }, { source: 'system' });
    return;
  }

  if (!settings.ai.enabled?.[trigger] || !env.ANTHROPIC_API_KEY) {
    await flagHuman(env, settings, contact, 'Sem palavra-chave (IA desligada)', false);
    return;
  }

  // Cost and loop protection
  const lim = settings.limits || {};
  const perContact = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel = ? AND contact_id = ? AND source IN ('ai', 'shadow:ai') AND created_at > ?").bind(contact.channel, contact.id, Date.now() - HOUR).first();
  const perDay = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE source IN ('ai', 'shadow:ai') AND created_at > ?").bind(Date.now() - DAY).first();
  if (perContact.n >= (lim.aiPerContactPerHour || 8) || perDay.n >= (lim.aiPerDay || 400)) {
    await flagHuman(env, settings, contact, perDay.n >= (lim.aiPerDay || 400) ? 'Limite diário da IA atingido' : 'Muitas mensagens seguidas desta pessoa');
    await sendTo(env, settings, contact, { text: settings.ai.fallbackMessage }, { source: 'system' });
    return;
  }

  let result;
  try {
    const hist = await db.history(env, contact.channel, contact.id, settings.ai.historyTurns || 12);
    result = await aiReply(env, { settings, flows, contact, channel: contact.channel, history: hist, text });
  } catch (e) {
    console.error('AI', e.message);
    await flagHuman(env, settings, contact, 'Erro da IA: ' + e.message);
    await sendTo(env, settings, contact, { text: settings.ai.fallbackMessage }, { source: 'system' });
    return;
  }

  let reply = result.reply;
  if (settings.ai.disclosure) {
    const priorAi = await env.DB.prepare('SELECT 1 FROM messages WHERE channel = ? AND contact_id = ? AND source = ? LIMIT 1').bind(contact.channel, contact.id, 'ai').first();
    if (!priorAi) reply = reply + '\n\n' + settings.ai.disclosure;
  }
  await sendTo(env, settings, contact, { text: reply }, { source: 'ai', meta: { usage: result.usage } });
  await db.addTags(env, contact, result.tags);
  if (result.handoff) await flagHuman(env, settings, contact, result.handoffReason || 'IA pediu ajuda humana');
}

function flowPayload(flow, contact) {
  return {
    text: fill(flow.message, contact),
    buttons: (flow.buttons || []).filter(b => b.url && b.title).map(b => ({ title: fill(b.title, contact), url: b.url })),
    quickReplies: flow.quickReplies || [],
  };
}

async function sendTo(env, settings, contact, payload, { source, recipient, kind = 'dm', meta: extra } = {}) {
  if (!payload?.text) return;
  const shown0 = payload.text + ((payload.buttons || []).length ? '\n' + payload.buttons.map(b => `[${b.title}] ${b.url}`).join('\n') : '');
  if (source !== 'human' && !shouldSend(contact, settings)) {
    // Shadow mode: record what the bot would have said, send nothing
    await db.logMessage(env, { channel: contact.channel, contactId: contact.id, direction: 'out', kind, text: shown0, source: 'shadow:' + source, meta: extra });
    return null;
  }
  let res;
  if (contact.channel === 'wa') {
    res = await meta.waSend(env, contact.id, payload);
  } else {
    res = await meta.igSend(env, recipient || { id: contact.id }, payload);
  }
  const outId = res?.message_id || res?.messages?.[0]?.id;
  if (outId) await db.firstSeen(env, 'out:' + outId);
  const shown = payload.text + ((payload.buttons || []).length ? '\n' + payload.buttons.map(b => `[${b.title}] ${b.url}`).join('\n') : '');
  await db.logMessage(env, { channel: contact.channel, contactId: contact.id, direction: 'out', kind, text: shown, source, meta: extra });
  await db.updateContact(env, contact.channel, contact.id, { last_outbound: Date.now() });
  return res;
}

async function flagHuman(env, settings, contact, reason, takeOver = true) {
  if (!shouldSend(contact, settings)) {
    await db.logMessage(env, { channel: contact.channel, contactId: contact.id, direction: 'out', kind: 'system', text: 'Shadow: passaria para a equipe. Motivo: ' + reason, source: 'shadow:system' });
    return;
  }
  const patch = { needs_human: true, handoff_reason: reason };
  if (takeOver) { patch.mode = 'human'; patch.human_until = Date.now() + (settings.humanTimeoutHours || 24) * HOUR; }
  await db.updateContact(env, contact.channel, contact.id, patch);
  if (settings.notifyWebhookUrl) {
    const who = contact.name || (contact.username ? '@' + contact.username : contact.id);
    try {
      await fetch(settings.notifyWebhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `FN DM: ${who} (${contact.channel === 'wa' ? 'WhatsApp' : 'Instagram'}) precisa de resposta humana. Motivo: ${reason}` }) });
    } catch { /* ignore */ }
  }
}

/** Echo = a message sent from FN's account. If we did not send it, someone typed it in the Instagram app: pause the bot. */
async function handleEcho(env, ev, settings) {
  if (settings.mode !== 'live') return; // in shadow/paused, echoes are ManyChat or tests
  if (await db.wasSeen(env, 'out:' + ev.mid)) return;
  await new Promise(r => setTimeout(r, 3000));
  if (await db.wasSeen(env, 'out:' + ev.mid)) return;
  const recent = await env.DB.prepare('SELECT text FROM messages WHERE channel = ? AND contact_id = ? AND direction = ? AND created_at > ? ORDER BY id DESC LIMIT 5')
    .bind('ig', ev.contactId, 'out', Date.now() - 2 * 60_000).all();
  if (recent.results.some(r => (r.text || '').startsWith((ev.text || '').slice(0, 40)))) return;
  await db.upsertContact(env, 'ig', ev.contactId);
  await db.logMessage(env, { channel: 'ig', contactId: ev.contactId, direction: 'out', kind: 'dm', text: ev.text || '[anexo]', source: 'human_app' });
  await db.updateContact(env, 'ig', ev.contactId, { mode: 'human', human_until: Date.now() + (settings.humanTimeoutHours || 24) * HOUR, needs_human: false, last_outbound: Date.now() });
}

// ---------------- Panel API ----------------

async function api(request, env, url) {
  // Brute-force protection: 10 wrong passwords per IP in 15 minutes locks that IP out for 15 minutes
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const lockKey = 'fail:' + ip;
  const fails = await env.DB.prepare('SELECT v, updated_at FROM kv WHERE k = ?').bind(lockKey).first();
  const failCount = fails && Date.now() - fails.updated_at < 15 * 60_000 ? Number(fails.v) : 0;
  if (failCount >= 10) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
  const auth = request.headers.get('authorization') || '';
  if (!env.PANEL_PASSWORD || env.PANEL_PASSWORD.length < 12 || !meta.timingSafeEqual(auth, 'Bearer ' + env.PANEL_PASSWORD)) {
    await env.DB.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at').bind(lockKey, String(failCount + 1), Date.now()).run();
    return json({ error: env.PANEL_PASSWORD && env.PANEL_PASSWORD.length < 12 ? 'PANEL_PASSWORD must be at least 12 characters' : 'Unauthorised' }, 401);
  }
  if (fails) await env.DB.prepare('DELETE FROM kv WHERE k = ?').bind(lockKey).run();
  const p = url.pathname.replace('/api/', '');
  const body = request.method === 'GET' ? null : await request.json().catch(() => ({}));
  const q = k => url.searchParams.get(k);

  if (p === 'state') {
    const counts = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM contacts) AS contacts,
      (SELECT COUNT(*) FROM contacts WHERE needs_human = 1) AS needs_human,
      (SELECT COUNT(*) FROM contacts WHERE channel = 'wa' AND opted_out = 0) AS wa_reachable,
      (SELECT COUNT(*) FROM messages WHERE direction = 'in' AND created_at > ?) AS in_24h,
      (SELECT COUNT(*) FROM messages WHERE source = 'ai' AND created_at > ?) AS ai_24h`).bind(Date.now() - DAY, Date.now() - DAY).first();
    return json({ flows: await db.getFlows(env), settings: await db.getSettings(env), counts, webhookUrl: url.origin + '/webhook' });
  }

  if (p === 'flows' && request.method === 'PUT') {
    const flows = (body.flows || []).map(f => ({ ...f, id: f.id || crypto.randomUUID().slice(0, 8) }));
    for (const f of flows) {
      if (!f.name || !f.message || !f.keywords?.length || !f.channels?.length) return json({ error: `Flow "${f.name || f.id}" needs a name, keywords, channels and a message` }, 400);
    }
    await db.saveVersion(env, 'flows', await db.getFlows(env));
    await db.saveFlows(env, flows);
    return json({ ok: true, flows });
  }

  if (p === 'settings' && request.method === 'PUT') {
    const before = await db.getSettings(env);
    const next = { ...body.settings };
    if (!['paused', 'shadow', 'live'].includes(next.mode)) next.mode = before.mode;
    if (next.mode === 'live' && before.mode !== 'live' && body.confirmLive !== 'LIVE') return json({ error: 'Type LIVE to switch the bot on for everyone' }, 400);
    await db.saveVersion(env, 'settings', before);
    await db.saveSettings(env, next);
    return json({ ok: true, settings: await db.getSettings(env) });
  }

  if (p === 'contacts') {
    const where = [], vals = [];
    if (q('channel')) { where.push('channel = ?'); vals.push(q('channel')); }
    if (q('filter') === 'needs_human') where.push('needs_human = 1');
    if (q('filter') === 'human') where.push("mode = 'human'");
    if (q('tag')) { where.push('tags LIKE ?'); vals.push(`%"${q('tag')}"%`); }
    if (q('q')) { where.push('(name LIKE ? OR username LIKE ? OR id LIKE ?)'); vals.push(`%${q('q')}%`, `%${q('q')}%`, `%${q('q')}%`); }
    const sql = `SELECT * FROM contacts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(last_inbound, created_at) DESC LIMIT ?`;
    const { results } = await env.DB.prepare(sql).bind(...vals, Math.min(Number(q('limit')) || 200, 1000)).all();
    return json({ contacts: results.map(db.parseContact) });
  }

  if (p === 'messages') {
    const { results } = await env.DB.prepare('SELECT * FROM messages WHERE channel = ? AND contact_id = ? ORDER BY created_at DESC, id DESC LIMIT 200').bind(q('channel'), q('id')).all();
    return json({ contact: await db.getContact(env, q('channel'), q('id')), messages: results.reverse() });
  }

  if (p === 'contact' && request.method === 'POST') {
    const patch = { ...body.patch };
    if (patch.mode === 'human') patch.human_until = Date.now() + (await db.getSettings(env)).humanTimeoutHours * HOUR;
    if (patch.mode === 'bot') { patch.human_until = null; patch.needs_human = false; }
    await db.updateContact(env, body.channel, body.id, patch);
    return json({ ok: true, contact: await db.getContact(env, body.channel, body.id) });
  }

  if (p === 'send' && request.method === 'POST') {
    const contact = await db.getContact(env, body.channel, body.id);
    if (!contact) return json({ error: 'Contact not found' }, 404);
    if (!contact.last_inbound || Date.now() - contact.last_inbound > DAY) {
      return json({ error: contact.channel === 'wa' ? 'Outside the 24h window. Use an approved template (Broadcast tab).' : 'Outside the 24h window. Instagram only allows replies within 24h of their last message.' }, 400);
    }
    await sendTo(env, await db.getSettings(env), contact, { text: body.text.slice(0, 2000) }, { source: 'human' });
    if (body.keepHuman !== false) await db.updateContact(env, contact.channel, contact.id, { mode: 'human', human_until: Date.now() + (await db.getSettings(env)).humanTimeoutHours * HOUR, needs_human: false });
    return json({ ok: true });
  }

  if (p === 'simulate' && request.method === 'POST') {
    const settings = body.settings ? { ...(await db.getSettings(env)), ...body.settings } : await db.getSettings(env);
    const flows = body.flows || await db.getFlows(env);
    const contact = { channel: body.channel === 'wa' ? 'wa' : 'ig', id: 'test', name: body.name || 'Maria Teste', username: 'maria.teste', tags: [] };
    const flow = matchFlow(flows, { trigger: body.channel, text: body.text, mediaId: body.mediaId });
    if (flow) return json({ type: 'flow', flow: flow.name, publicReply: body.channel === 'ig_comment' ? fill(pick(flow.publicReplies) || '', contact) : null, ...flowPayload(flow, contact) });
    if (body.channel === 'ig_comment') return json({ type: 'none', note: 'No keyword matched. Comments without a keyword are ignored.' });
    const result = await aiReply(env, { settings, flows, contact, channel: contact.channel, history: body.history || [], text: body.text });
    return json({ type: 'ai', ...result });
  }

  if (p === 'wa/templates') return json({ templates: await meta.waTemplates(env) });

  if (p === 'wa/audience') {
    const tag = q('tag');
    const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE channel = 'wa' AND opted_out = 0 ${tag ? 'AND tags LIKE ?' : ''}`).bind(...(tag ? [`%"${tag}"%`] : [])).first();
    return json({ count: r.n });
  }

  if (p === 'wa/broadcast' && request.method === 'POST') {
    const { template, language, bodyParams = [], tag, offset = 0, confirm } = body;
    if (confirm !== 'ENVIAR') return json({ error: 'Type ENVIAR to confirm the broadcast' }, 400);
    const limit = 40; // stays well under Workers subrequest limits
    const { results } = await env.DB.prepare(`SELECT * FROM contacts WHERE channel = 'wa' AND opted_out = 0 ${tag ? 'AND tags LIKE ?' : ''} ORDER BY created_at LIMIT ? OFFSET ?`)
      .bind(...(tag ? [`%"${tag}"%`] : []), limit, offset).all();
    let sent = 0; const failed = [];
    for (const row of results.map(db.parseContact)) {
      try {
        await meta.waSendTemplate(env, row.id, { name: template, language, bodyParams: bodyParams.map(t => fill(t, row)) });
        await db.logMessage(env, { channel: 'wa', contactId: row.id, direction: 'out', kind: 'template', text: `[template ${template}]`, source: 'broadcast' });
        sent++;
      } catch (e) { failed.push({ id: row.id, error: e.message }); }
    }
    return json({ sent, failed, next: results.length === limit ? offset + limit : null });
  }

  if (p === 'import' && request.method === 'POST') {
    let n = 0;
    const stmts = [];
    for (const r of (body.rows || []).slice(0, 5000)) {
      const phone = String(r.phone || '').replace(/\D/g, '');
      if (phone.length < 8) continue;
      const tags = JSON.stringify([...new Set((r.tags || []).map(t => String(t).trim().toLowerCase()).filter(Boolean))]);
      stmts.push(env.DB.prepare(`INSERT INTO contacts (channel, id, name, tags, opted_out, created_at) VALUES ('wa', ?, ?, ?, ?, ?)
        ON CONFLICT(channel, id) DO UPDATE SET name = COALESCE(contacts.name, excluded.name), tags = excluded.tags, opted_out = excluded.opted_out`)
        .bind(phone, r.name || null, tags, r.optedOut ? 1 : 0, Date.now()));
      n++;
    }
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    return json({ ok: true, imported: n });
  }

  if (p === 'health') {
    const out = {};
    try { out.instagram = await meta.igMe(env); } catch (e) { out.instagram = { error: e.message }; }
    try { out.whatsapp = await meta.waPhoneInfo(env); } catch (e) { out.whatsapp = { error: e.message }; }
    const tok = await env.DB.prepare('SELECT updated_at FROM kv WHERE k = ?').bind('ig_token').first();
    out.igTokenRefreshedAt = tok?.updated_at || null;
    out.claudeKey = !!env.ANTHROPIC_API_KEY;
    try { out.instagramWebhookFields = await meta.igSubscriptions(env); } catch (e) { out.instagramWebhookFields = { error: e.message }; }
    try { out.whatsappSubscribedApps = await meta.waSubscriptions(env); } catch (e) { out.whatsappSubscribedApps = { error: e.message }; }
    out.mode = (await db.getSettings(env)).mode;
    out.panelPasswordStrong = (env.PANEL_PASSWORD || '').length >= 16;
    out.secrets = Object.fromEntries(['META_VERIFY_TOKEN', 'META_APP_SECRET', 'IG_APP_SECRET', 'IG_USER_ID', 'IG_ACCESS_TOKEN', 'WA_TOKEN', 'WA_PHONE_NUMBER_ID', 'WA_WABA_ID', 'ANTHROPIC_API_KEY'].map(k => [k, !!env[k]]));
    return json(out);
  }

  if (p === 'connect' && request.method === 'POST') {
    const out = {};
    try { out.instagram = await meta.igSubscribe(env); } catch (e) { out.instagram = { error: e.message }; }
    try { out.whatsapp = await meta.waSubscribe(env); } catch (e) { out.whatsapp = { error: e.message }; }
    return json(out);
  }

  if (p === 'versions') return json({ versions: await db.listVersions(env, q('type')) });
  if (p === 'versions/restore' && request.method === 'POST') {
    const data = await db.getVersion(env, body.key);
    if (!data) return json({ error: 'Version not found' }, 404);
    if (body.key.startsWith('ver:flows:')) { await db.saveVersion(env, 'flows', await db.getFlows(env)); await db.saveFlows(env, data); }
    else { const cur = await db.getSettings(env); await db.saveVersion(env, 'settings', cur); await db.saveSettings(env, { ...data, mode: cur.mode === 'live' ? data.mode : cur.mode }); }
    return json({ ok: true });
  }

  if (p === 'ig/refresh-token' && request.method === 'POST') return json(await meta.igRefreshToken(env));

  return json({ error: 'Not found' }, 404);
}
