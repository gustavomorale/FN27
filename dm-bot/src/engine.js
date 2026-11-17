// Pure logic: keyword matching, templating, parsing Meta webhooks. No I/O here so it is easy to test.

export function normalise(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#@ ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function keywordHit(text, keyword, mode) {
  const t = normalise(text);
  const k = normalise(keyword);
  if (!k) return false;
  if (mode === 'exact') return t === k;
  if (k === '*') return true;
  return (' ' + t + ' ').includes(' ' + k + ' ');
}

/**
 * Find the flow for an event.
 * trigger: 'ig_comment' | 'ig_dm' | 'wa'
 * Exact matches win over "contains"; otherwise the first flow in list order wins.
 */
export function matchFlow(flows, { trigger, text, mediaId }) {
  const candidates = (flows || []).filter(f =>
    f && f.active !== false &&
    Array.isArray(f.channels) && f.channels.includes(trigger) &&
    (trigger !== 'ig_comment' || !f.mediaIds?.length || f.mediaIds.includes(String(mediaId)))
  );
  for (const mode of ['exact', 'contains']) {
    for (const f of candidates) {
      const m = f.match || 'contains';
      if (m !== mode) continue;
      if ((f.keywords || []).some(k => keywordHit(text, k, m))) return f;
    }
  }
  return null;
}

export function isKeyword(text, list) {
  return (list || []).some(k => keywordHit(text, k, 'exact'));
}

export function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

export function fill(template, contact = {}) {
  const fn = firstName(contact.name) || contact.username || '';
  return String(template || '')
    .replaceAll('{first_name}', fn)
    .replaceAll('{name}', contact.name || fn)
    .replaceAll('{username}', contact.username ? '@' + contact.username : fn)
    .replace(/\s+([!?.,])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function pick(list) {
  const arr = (list || []).filter(Boolean);
  return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
}

/** Turn a Meta webhook body into a flat list of events we care about. */
export function parseWebhook(body, { igUserId } = {}) {
  const out = [];
  if (!body || !Array.isArray(body.entry)) return out;

  if (body.object === 'instagram') {
    for (const entry of body.entry) {
      for (const m of entry.messaging || []) {
        const msg = m.message;
        if (msg?.is_echo) {
          out.push({ type: 'ig_echo', channel: 'ig', contactId: String(m.recipient?.id), mid: msg.mid, text: msg.text || '', ts: m.timestamp });
          continue;
        }
        if (msg && !msg.is_deleted) {
          out.push({
            type: 'ig_dm', channel: 'ig', contactId: String(m.sender?.id), mid: msg.mid,
            text: msg.quick_reply?.payload?.startsWith('QR:') ? msg.quick_reply.payload.slice(3) : (msg.text || ''),
            hasAttachment: !!msg.attachments?.length, ts: m.timestamp,
          });
          continue;
        }
        if (m.postback) {
          out.push({ type: 'ig_dm', channel: 'ig', contactId: String(m.sender?.id), mid: m.postback.mid,
            text: m.postback.payload?.startsWith('QR:') ? m.postback.payload.slice(3) : (m.postback.title || ''), ts: m.timestamp });
        }
      }
      for (const c of entry.changes || []) {
        if (c.field !== 'comments' && c.field !== 'live_comments') continue;
        const v = c.value || {};
        if (!v.id || !v.from?.id) continue;
        if (igUserId && String(v.from.id) === String(igUserId)) continue; // our own replies
        out.push({ type: 'ig_comment', channel: 'ig', contactId: String(v.from.id), username: v.from.username,
          commentId: String(v.id), mediaId: String(v.media?.id || ''), parentId: v.parent_id || null,
          isLive: c.field === 'live_comments', text: v.text || '', mid: 'c:' + v.id });
      }
    }
  }

  if (body.object === 'whatsapp_business_account') {
    for (const entry of body.entry) {
      for (const c of entry.changes || []) {
        const v = c.value || {};
        const names = Object.fromEntries((v.contacts || []).map(x => [x.wa_id, x.profile?.name]));
        for (const msg of v.messages || []) {
          let text = '';
          if (msg.type === 'text') text = msg.text?.body || '';
          else if (msg.type === 'interactive') text = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
          else if (msg.type === 'button') text = msg.button?.text || '';
          out.push({ type: 'wa', channel: 'wa', contactId: String(msg.from), name: names[msg.from], mid: msg.id,
            text, msgType: msg.type, ts: Number(msg.timestamp) * 1000 });
        }
        for (const st of v.statuses || []) {
          if (st.status === 'failed') out.push({ type: 'wa_failed', channel: 'wa', contactId: String(st.recipient_id), mid: 'st:' + st.id, errors: st.errors });
        }
      }
    }
  }
  return out;
}

/** Is this contact a tester who always gets real replies? */
export function onAllowlist(contact, settings) {
  const list = (settings.allowlist || []).map(x => String(x).trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  if (!list.length || !contact) return false;
  const digits = s => String(s || '').replace(/\D/g, '');
  return list.some(x => x === String(contact.id).toLowerCase() || (contact.username && x === contact.username.toLowerCase()) ||
    (contact.channel === 'wa' && digits(x).length >= 8 && digits(x) === digits(contact.id)));
}

/** Should a message to this contact really be sent? */
export function shouldSend(contact, settings) {
  if (settings.mode === 'live') return true;
  if (settings.mode === 'paused') return false;
  return onAllowlist(contact, settings);
}

/** Human-readable flow summary given to Claude so it can point people to the right keyword. */
export function flowsSummary(flows) {
  return (flows || []).filter(f => f.active !== false).map(f =>
    `- Palavra-chave ${f.keywords.map(k => `"${k}"`).join(' / ')} (${f.channels.join(', ')}): ${f.name}${f.description ? ': ' + f.description : ''}`
  ).join('\n');
}

export const DEFAULT_SETTINGS = {
  // paused: logs only · shadow: works out replies but sends nothing (testers on the allowlist still get real replies) · live: sends
  mode: 'shadow',
  allowlist: [],          // IG usernames, IG ids or WhatsApp numbers that always get real replies (testers)
  limits: { aiPerContactPerHour: 8, aiPerDay: 400 },
  ai: {
    enabled: { ig_dm: true, wa: true },
    model: 'claude-haiku-5-5',
    maxTokens: 500,
    historyTurns: 12,
    knowledge: 'Escreva aqui o conhecimento da FN: quem é a Fernanda, programas, preços, datas, links oficiais, perguntas frequentes e o tom de voz. A IA só usa o que está aqui.',
    disclosure: '',
    handoffMessage: 'Vou passar sua mensagem para a equipe da Fernanda e alguém te responde por aqui em breve. 💛',
    fallbackMessage: 'Recebi sua mensagem! A equipe da Fernanda te responde em breve. 💛',
  },
  humanTimeoutHours: 24,
  optOutKeywords: ['PARAR', 'SAIR', 'STOP', 'CANCELAR', 'DESCADASTRAR'],
  optInKeywords: ['VOLTAR', 'START', 'RECEBER'],
  optOutReply: 'Pronto, você não vai mais receber nossas mensagens de divulgação. Se mudar de ideia, é só mandar VOLTAR.',
  optInReply: 'Que bom te ter de volta! Você vai voltar a receber as novidades da Fernanda. 💛',
  notifyWebhookUrl: '',
};

export function mergeSettings(saved) {
  const s = saved || {};
  return { ...DEFAULT_SETTINGS, ...s, limits: { ...DEFAULT_SETTINGS.limits, ...(s.limits || {}) }, ai:{ ...DEFAULT_SETTINGS.ai, ...(s.ai || {}), enabled: { ...DEFAULT_SETTINGS.ai.enabled, ...(s.ai?.enabled || {}) } } };
}
