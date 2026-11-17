import { mergeSettings } from './engine.js';

export const now = () => Date.now();

export async function getSettings(env) {
  const row = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind('settings').first();
  return mergeSettings(row ? JSON.parse(row.v) : null);
}

export async function saveSettings(env, settings) {
  await env.DB.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at')
    .bind('settings', JSON.stringify(settings), now()).run();
}

export async function getFlows(env) {
  const { results } = await env.DB.prepare('SELECT data FROM flows ORDER BY position, updated_at').all();
  return results.map(r => JSON.parse(r.data));
}

export async function saveFlows(env, flows) {
  const stmts = [env.DB.prepare('DELETE FROM flows')];
  flows.forEach((f, i) => stmts.push(env.DB.prepare('INSERT INTO flows (id, data, position, updated_at) VALUES (?, ?, ?, ?)').bind(f.id, JSON.stringify(f), i, now())));
  await env.DB.batch(stmts);
}

export function parseContact(row) {
  if (!row) return null;
  return { ...row, tags: JSON.parse(row.tags || '[]'), needs_human: !!row.needs_human, opted_out: !!row.opted_out };
}

export async function getContact(env, channel, id) {
  return parseContact(await env.DB.prepare('SELECT * FROM contacts WHERE channel = ? AND id = ?').bind(channel, id).first());
}

export async function upsertContact(env, channel, id, fields = {}) {
  const existing = await getContact(env, channel, id);
  if (!existing) {
    await env.DB.prepare('INSERT OR IGNORE INTO contacts (channel, id, name, username, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(channel, id, fields.name || null, fields.username || null, now()).run();
  } else if ((fields.name && !existing.name) || (fields.username && fields.username !== existing.username)) {
    await env.DB.prepare('UPDATE contacts SET name = COALESCE(name, ?), username = COALESCE(?, username) WHERE channel = ? AND id = ?')
      .bind(fields.name || null, fields.username || null, channel, id).run();
  }
  return { contact: await getContact(env, channel, id), isNew: !existing };
}

export async function updateContact(env, channel, id, patch) {
  const cols = [], vals = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!['name', 'username', 'tags', 'mode', 'human_until', 'needs_human', 'handoff_reason', 'opted_out', 'last_inbound', 'last_outbound'].includes(k)) continue;
    cols.push(`${k} = ?`);
    vals.push(k === 'tags' ? JSON.stringify(v) : (typeof v === 'boolean' ? (v ? 1 : 0) : v));
  }
  if (!cols.length) return;
  await env.DB.prepare(`UPDATE contacts SET ${cols.join(', ')} WHERE channel = ? AND id = ?`).bind(...vals, channel, id).run();
}

export async function addTags(env, contact, tags) {
  const merged = [...new Set([...(contact.tags || []), ...(tags || []).filter(Boolean)])];
  if (merged.length !== (contact.tags || []).length) {
    await updateContact(env, contact.channel, contact.id, { tags: merged });
    contact.tags = merged;
  }
}

export async function logMessage(env, { channel, contactId, direction, kind, text, source, meta }) {
  await env.DB.prepare('INSERT INTO messages (channel, contact_id, direction, kind, text, source, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(channel, contactId, direction, kind, text || null, source || null, meta ? JSON.stringify(meta) : null, now()).run();
}

export async function history(env, channel, contactId, limit = 12) {
  const { results } = await env.DB.prepare('SELECT * FROM messages WHERE channel = ? AND contact_id = ? AND kind IN (\'dm\', \'private_reply\', \'template\') ORDER BY created_at DESC, id DESC LIMIT ?')
    .bind(channel, contactId, limit).all();
  return results.reverse();
}

/** Returns true the first time an id is seen. */
export async function firstSeen(env, eventId) {
  if (!eventId) return true;
  const r = await env.DB.prepare('INSERT OR IGNORE INTO seen (event_id, created_at) VALUES (?, ?)').bind(eventId, now()).run();
  return r.meta.changes > 0;
}

export async function wasSeen(env, eventId) {
  return !!(await env.DB.prepare('SELECT 1 FROM seen WHERE event_id = ?').bind(eventId).first());
}

// ---- Version history (last 20 of each) for rollback
export async function saveVersion(env, type, data) {
  await env.DB.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?)').bind(`ver:${type}:${now()}:${Math.random().toString(36).slice(2, 6)}`, JSON.stringify(data), now()).run();
  const { results } = await env.DB.prepare('SELECT k FROM kv WHERE k LIKE ? ORDER BY updated_at DESC LIMIT -1 OFFSET 20').bind(`ver:${type}:%`).all();
  for (const r of results) await env.DB.prepare('DELETE FROM kv WHERE k = ?').bind(r.k).run();
}

export async function listVersions(env, type) {
  const { results } = await env.DB.prepare('SELECT k, updated_at FROM kv WHERE k LIKE ? ORDER BY updated_at DESC').bind(`ver:${type === 'flows' ? 'flows' : 'settings'}:%`).all();
  return results.map(r => ({ key: r.k, at: r.updated_at }));
}

export async function getVersion(env, key) {
  if (!/^ver:(flows|settings):/.test(String(key))) return null;
  const row = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(key).first();
  return row ? JSON.parse(row.v) : null;
}
