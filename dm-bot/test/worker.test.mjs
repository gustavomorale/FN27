// End-to-end tests of the Worker with an in-memory D1 (node:sqlite) and mocked Meta + Claude APIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import worker from '../src/index.js';
import { matchFlow, fill, normalise } from '../src/engine.js';

function d1() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (q, args = []) => ({
    bind: (...a) => { if (a.some(x => x === undefined)) throw new Error('D1: undefined bind in ' + q); return stmt(q, a); },
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => { const r = sql.prepare(q).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: q => stmt(q), batch: async list => { for (const s of list) await s.run(); }, raw: sql };
}

const calls = [];
let aiOutput = { reply: 'Oi! O desafio começa dia 1.', handoff: false, tags: ['desafio'] };
globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url: String(url), body });
  if (String(url).includes('api.anthropic.com')) {
    return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'responder', input: aiOutput }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 });
  }
  if (String(url).includes('?fields=name,username')) return new Response(JSON.stringify({ name: 'Ana Souza', username: 'ana.s' }), { status: 200 });
  if (String(url).includes('/messages') && body?.messaging_product) return new Response(JSON.stringify({ messages: [{ id: 'wamid.' + calls.length }] }), { status: 200 });
  if (String(url).includes('/messages')) return new Response(JSON.stringify({ recipient_id: '1', message_id: 'mid.out.' + calls.length }), { status: 200 });
  return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
};

const env = {
  DB: d1(), IG_APP_SECRET: 'igsecret', META_APP_SECRET: 'fbsecret', META_VERIFY_TOKEN: 'verify',
  IG_USER_ID: '999', IG_ACCESS_TOKEN: 'igtok', WA_TOKEN: 'watok', WA_PHONE_NUMBER_ID: '555', WA_WABA_ID: '777',
  ANTHROPIC_API_KEY: 'sk', PANEL_PASSWORD: 'a-long-test-password-123', GRAPH_VERSION: 'v24.0', TIMEZONE: 'Europe/London',
};

async function post(body, secret = 'igsecret') {
  const raw = JSON.stringify(body);
  const sig = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  const pending = [];
  const res = await worker.fetch(new Request('https://fn.example/webhook', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': sig } }), env, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);
  return res;
}
async function apiCall(path, body, method = body ? 'POST' : 'GET') {
  const res = await worker.fetch(new Request('https://fn.example/api/' + path, { method, body: body ? JSON.stringify(body) : undefined, headers: { authorization: 'Bearer a-long-test-password-123' } }), env, { waitUntil() {} });
  return { status: res.status, data: await res.json() };
}
const contact = (ch, id) => env.DB.raw.prepare('SELECT * FROM contacts WHERE channel = ? AND id = ?').get(ch, id);

const flows = [
  { id: 'desafio', name: 'Link do desafio', active: true, channels: ['ig_comment', 'ig_dm', 'wa'], keywords: ['DESAFIO'], match: 'contains',
    publicReplies: ['Te mandei no direct, {first_name}! 💛'], message: 'Oi {first_name}! Aqui está o link do desafio:', buttons: [{ title: 'Quero participar', url: 'https://desafiofernandanadaline.com' }], addTags: ['desafio'] },
  { id: 'preco', name: 'Preço', active: true, channels: ['ig_dm', 'wa'], keywords: ['preço'], match: 'exact', message: 'O valor é R$ 97.' },
];

test('engine: matching, accents, exact vs contains, templating', () => {
  assert.equal(normalise('  Quero o DESAFIÓ!! '), 'quero o desafio');
  assert.equal(matchFlow(flows, { trigger: 'ig_dm', text: 'quero o desafio por favor' }).id, 'desafio');
  assert.equal(matchFlow(flows, { trigger: 'wa', text: 'Preco' }).id, 'preco');
  assert.equal(matchFlow(flows, { trigger: 'wa', text: 'qual o preco?' }), null);
  assert.equal(matchFlow(flows, { trigger: 'ig_dm', text: 'desafios' }), null);
  assert.equal(fill('Oi {first_name}!', {}), 'Oi!');
  assert.equal(fill('Oi {first_name}!', { name: 'Ana Souza' }), 'Oi Ana!');
});

test('setup: save flows and settings through the panel API', async () => {
  assert.equal((await worker.fetch(new Request('https://fn.example/api/state'), env, {})).status, 401);
  assert.equal((await apiCall('flows', { flows }, 'PUT')).status, 200);
  const s = (await apiCall('state')).data.settings;
  assert.equal(s.mode, 'shadow', 'safe default is shadow');
  s.ai.disclosure = '(Resposta automática)';
  s.mode = 'live';
  assert.equal((await apiCall('settings', { settings: s }, 'PUT')).status, 400, 'live needs confirmation');
  const r = await apiCall('settings', { settings: s, confirmLive: 'LIVE' }, 'PUT');
  assert.equal(r.data.settings.mode, 'live');
  assert.ok((await apiCall('versions?type=settings')).data.versions.length >= 1, 'previous settings kept for rollback');
});

test('webhook: verification and bad signature', async () => {
  const ok = await worker.fetch(new Request('https://fn.example/webhook?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=42'), env, {});
  assert.equal(await ok.text(), '42');
  const bad = await worker.fetch(new Request('https://fn.example/webhook', { method: 'POST', body: '{}', headers: { 'x-hub-signature-256': 'sha256=00' } }), env, {});
  assert.equal(bad.status, 401);
});

test('comment with keyword: public reply + private reply, once per person per post', async () => {
  calls.length = 0;
  const ev = id => ({ object: 'instagram', entry: [{ id: '999', changes: [{ field: 'comments', value: { id, text: 'DESAFIO 🙌', from: { id: 'u1', username: 'ana.s' }, media: { id: 'm1' } } }] }] });
  assert.equal((await post(ev('c1'))).status, 200);
  const pub = calls.find(c => c.url.includes('/c1/replies'));
  const priv = calls.find(c => c.body?.recipient?.comment_id === 'c1');
  assert.ok(pub, 'public reply sent');
  assert.match(pub.body.message, /Te mandei no direct/);
  assert.equal(priv.body.message.attachment.payload.template_type, 'button');
  assert.deepEqual(JSON.parse(contact('ig', 'u1').tags), ['desafio']);
  calls.length = 0;
  await post(ev('c2'));
  assert.equal(calls.length, 0, 'no second DM for same person/post');
  await post(ev('c1'));
  assert.equal(calls.length, 0, 'retry de-duplicated');
});

test('our own comment replies are ignored', async () => {
  calls.length = 0;
  await post({ object: 'instagram', entry: [{ id: '999', changes: [{ field: 'comments', value: { id: 'c9', text: 'DESAFIO', from: { id: '999', username: 'fernanda' }, media: { id: 'm1' } } }] }] });
  assert.equal(calls.length, 0);
});

test('IG DM keyword triggers the flow and fetches the profile', async () => {
  calls.length = 0;
  await post({ object: 'instagram', entry: [{ id: '999', messaging: [{ sender: { id: 'u2' }, recipient: { id: '999' }, timestamp: Date.now(), message: { mid: 'mid.in.1', text: 'oi, quero o desafio' } }] }] });
  const send = calls.find(c => c.body?.recipient?.id === 'u2');
  assert.match(send.body.message.attachment.payload.text, /^Oi Ana!/);
  assert.equal(contact('ig', 'u2').name, 'Ana Souza');
});

test('WhatsApp free text goes to Claude, disclosure added once, handoff pauses the bot', async () => {
  calls.length = 0;
  const wa = (mid, text) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { contacts: [{ wa_id: '447700900000', profile: { name: 'Bia Lima' } }], messages: [{ from: '447700900000', id: mid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
  await post(wa('w1', 'quando começa?'), 'fbsecret');
  const ai = calls.find(c => c.url.includes('anthropic'));
  assert.ok(ai.body.system.includes('Link do desafio'), 'flows summary in prompt');
  assert.equal(ai.body.tool_choice.name, 'responder');
  const sent = calls.find(c => c.body?.type === 'text' && c.body.to === '447700900000');
  assert.match(sent.body.text.body, /Resposta automática/);

  calls.length = 0;
  aiOutput = { reply: 'Vou passar para a equipe. 💛', handoff: true, handoff_reason: 'Pergunta sobre remédio' };
  await post(wa('w2', 'tomo remédio pra tireoide, posso fazer?'), 'fbsecret');
  const sent2 = calls.find(c => c.body?.type === 'text');
  assert.doesNotMatch(sent2.body.text.body, /Resposta automática/, 'disclosure only on first AI reply');
  const c = contact('wa', '447700900000');
  assert.equal(c.mode, 'human'); assert.equal(c.needs_human, 1);

  calls.length = 0;
  await post(wa('w3', 'oi?'), 'fbsecret');
  assert.ok(!calls.some(x => x.url.includes('anthropic')), 'no AI while a human has the chat');
  assert.ok(!calls.some(x => x.body?.type === 'text'), 'no auto reply while human');
});

test('WhatsApp opt-out and opt-in', async () => {
  const wa = (mid, text) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { contacts: [{ wa_id: '5511999990000', profile: { name: 'Caio' } }], messages: [{ from: '5511999990000', id: mid, timestamp: '1', type: 'text', text: { body: text } }] } }] }] });
  await post(wa('o1', 'Parar'), 'fbsecret');
  assert.equal(contact('wa', '5511999990000').opted_out, 1);
  await post(wa('o2', 'voltar'), 'fbsecret');
  assert.equal(contact('wa', '5511999990000').opted_out, 0);
});

test('reply typed in the Instagram app pauses the bot for that person', async () => {
  await post({ object: 'instagram', entry: [{ id: '999', messaging: [{ sender: { id: '999' }, recipient: { id: 'u3' }, timestamp: Date.now(), message: { mid: 'mid.app.1', text: 'Oi! Aqui é a Fê', is_echo: true } }] }] });
  assert.equal(contact('ig', 'u3').mode, 'human');
});

test('panel: simulate, manual send window, import, broadcast confirm', async () => {
  aiOutput = { reply: 'Resposta de teste', handoff: false };
  const sim = await apiCall('simulate', { channel: 'ig_comment', text: 'desafio' });
  assert.equal(sim.data.type, 'flow');
  const sim2 = await apiCall('simulate', { channel: 'wa', text: 'tem certificado?' });
  assert.equal(sim2.data.type, 'ai');
  const send = await apiCall('send', { channel: 'ig', id: 'u1', text: 'oi' });
  assert.equal(send.status, 400, 'comment-only contact has no open 24h window');
  const imp = await apiCall('import', { rows: [{ phone: '+55 11 98888-7777', name: 'Dora', tags: ['Reset'] }, { phone: 'x' }] });
  assert.equal(imp.data.imported, 1);
  assert.equal((await apiCall('wa/audience?tag=reset')).data.count, 1);
  assert.equal((await apiCall('wa/broadcast', { template: 't', language: 'pt_BR', tag: 'reset' })).status, 400);
  calls.length = 0;
  const b = await apiCall('wa/broadcast', { template: 't', language: 'pt_BR', tag: 'reset', bodyParams: ['{first_name}'], confirm: 'ENVIAR' });
  assert.equal(b.data.sent, 1);
  assert.equal(calls[0].body.template.components[0].parameters[0].text, 'Dora');
});

test('shadow mode logs replies without sending, testers on the allowlist still get real replies', async () => {
  const s = (await apiCall('state')).data.settings;
  s.mode = 'shadow'; s.allowlist = ['@tester.fn', '+44 7700 900123'];
  await apiCall('settings', { settings: s }, 'PUT');
  calls.length = 0;
  await post({ object: 'instagram', entry: [{ id: '999', changes: [{ field: 'comments', value: { id: 'cs1', text: 'desafio', from: { id: 'u9', username: 'someone' }, media: { id: 'm2' } } }] }] });
  assert.equal(calls.length, 0, 'nothing sent to Meta in shadow');
  const logged = env.DB.raw.prepare("SELECT source FROM messages WHERE contact_id = 'u9' AND direction = 'out'").all().map(r => r.source);
  assert.deepEqual(logged.sort(), ['shadow:flow:desafio', 'shadow:flow:desafio']);
  await post({ object: 'instagram', entry: [{ id: '999', changes: [{ field: 'comments', value: { id: 'cs2', text: 'desafio', from: { id: 'u10', username: 'Tester.FN' }, media: { id: 'm2' } } }] }] });
  assert.ok(calls.some(c => c.body?.recipient?.comment_id === 'cs2'), 'allowlisted tester gets the real DM');
  calls.length = 0;
  const wa = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { contacts: [{ wa_id: '447700900123', profile: { name: 'T' } }], messages: [{ from: '447700900123', id: 'ws1', timestamp: '1', type: 'text', text: { body: 'desafio' } }] } }] }] };
  await post(wa, 'fbsecret');
  assert.ok(calls.some(c => c.body?.to === '447700900123'), 'allowlisted WhatsApp number matched by digits');
});

test('paused mode sends nothing at all', async () => {
  const s = (await apiCall('state')).data.settings;
  s.mode = 'paused';
  await apiCall('settings', { settings: s }, 'PUT');
  calls.length = 0;
  await post({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { contacts: [{ wa_id: '447700900123', profile: { name: 'T' } }], messages: [{ from: '447700900123', id: 'wp1', timestamp: '1', type: 'text', text: { body: 'desafio' } }] } }] }] }, 'fbsecret');
  assert.equal(calls.length, 0);
});

test('AI per-contact limit hands off instead of looping', async () => {
  const s = (await apiCall('state')).data.settings;
  s.mode = 'live'; s.limits = { aiPerContactPerHour: 2, aiPerDay: 400 };
  await apiCall('settings', { settings: s, confirmLive: 'LIVE' }, 'PUT');
  aiOutput = { reply: 'ok', handoff: false };
  const msg = id => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { contacts: [{ wa_id: '447700900777', profile: { name: 'L' } }], messages: [{ from: '447700900777', id, timestamp: '1', type: 'text', text: { body: 'pergunta ' + id } }] } }] }] });
  for (const id of ['l1', 'l2', 'l3']) await post(msg(id), 'fbsecret');
  assert.equal(contact('wa', '447700900777').needs_human, 1);
  assert.match(contact('wa', '447700900777').handoff_reason, /Muitas mensagens/);
});

test('panel locks out an IP after 10 wrong passwords', async () => {
  const bad = () => worker.fetch(new Request('https://fn.example/api/state', { headers: { authorization: 'Bearer nope', 'cf-connecting-ip': '1.2.3.4' } }), env, {});
  for (let i = 0; i < 10; i++) assert.equal((await bad()).status, 401);
  assert.equal((await bad()).status, 429);
  const good = await worker.fetch(new Request('https://fn.example/api/state', { headers: { authorization: 'Bearer a-long-test-password-123', 'cf-connecting-ip': '1.2.3.4' } }), env, {});
  assert.equal(good.status, 429, 'even the right password waits out the lockout');
});

test('oversized webhook is rejected', async () => {
  const res = await worker.fetch(new Request('https://fn.example/webhook', { method: 'POST', body: 'x'.repeat(1_000_001) }), env, {});
  assert.equal(res.status, 413);
});
