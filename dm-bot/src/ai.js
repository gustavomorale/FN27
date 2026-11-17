// Claude fallback for free-text messages that no keyword flow caught.
import { flowsSummary } from './engine.js';

// Fixed guardrails. Not editable from the panel on purpose.
const GUARDRAILS = `Você é o assistente automático de mensagens da Fernanda Nadaline (FN) no Instagram e no WhatsApp.
Você atende apenas assuntos do negócio da FN: programas, desafios, conteúdos, inscrições, datas, acesso e dúvidas de quem quer participar. Não é um assistente geral: se pedirem algo fora disso, responda com gentileza que por aqui você só ajuda com os programas da Fernanda.

Regras obrigatórias:
1. Use só as informações do bloco CONHECIMENTO e da lista de palavras-chave. Nunca invente preços, datas, links, garantias, resultados ou depoimentos. Se não souber, diga que vai confirmar com a equipe e marque handoff = true.
2. Saúde: você não é profissional de saúde. Nunca dê diagnóstico, prescrição, dieta individual, quantidades, orientação sobre remédios, suplementos, gravidez, amamentação, doenças, exames ou cirurgias. Se a pessoa mencionar qualquer condição de saúde, remédio, gravidez, transtorno alimentar, compulsão, sofrimento emocional ou pedir orientação individual, responda com acolhimento curto, diga que a equipe vai responder pessoalmente e marque handoff = true. Se houver sinal de risco imediato ou crise, oriente a procurar ajuda profissional ou um serviço de emergência local e marque handoff = true.
3. Marque handoff = true também para: reclamação, reembolso, problema de pagamento ou acesso, pedido para falar com a Fernanda ou com uma pessoa, parcerias, imprensa, ou qualquer coisa sensível.
4. Se perguntarem se você é um robô ou uma pessoa, seja honesto: você é o assistente automático da equipe da Fernanda.
5. Responda no idioma da pessoa (normalmente português do Brasil), em tom caloroso, simples e próximo, como a equipe da FN escreveria. Mensagens curtas: no máximo 3 frases curtas, sem listas longas. No máximo 1 emoji.
6. Nunca peça dados sensíveis (documentos, cartão, senhas, dados de saúde).
7. Quando existir uma palavra-chave que entrega o que a pessoa quer, indique a palavra-chave.`;

export async function aiReply(env, { settings, flows, contact, channel, history, text }) {
  const ai = settings.ai;
  const now = new Date().toLocaleString('pt-BR', { timeZone: env.TIMEZONE || 'Europe/London' });
  const system = [
    GUARDRAILS,
    `\nCONHECIMENTO (fonte única de verdade):\n${ai.knowledge || '(vazio)'}`,
    `\nPALAVRAS-CHAVE DISPONÍVEIS:\n${flowsSummary(flows) || '(nenhuma)'}`,
    `\nCONTEXTO: canal ${channel === 'wa' ? 'WhatsApp' : 'Instagram Direct'}; nome da pessoa: ${contact.name || contact.username || 'desconhecido'}; data e hora: ${now}.`,
  ].join('\n');

  const messages = [];
  for (const m of history) {
    const role = m.direction === 'in' ? 'user' : 'assistant';
    const content = (m.text || '').trim();
    if (!content) continue;
    if (messages.length && messages[messages.length - 1].role === role) messages[messages.length - 1].content += '\n' + content;
    else messages.push({ role, content });
  }
  if (!messages.length || messages[messages.length - 1].role !== 'user') messages.push({ role: 'user', content: text });
  while (messages.length && messages[0].role !== 'user') messages.shift();

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: ai.model || 'claude-haiku-5-5',
      max_tokens: ai.maxTokens || 500,
      system,
      messages,
      tools: [{
        name: 'responder',
        description: 'Envia a resposta para a pessoa.',
        input_schema: {
          type: 'object',
          properties: {
            reply: { type: 'string', description: 'Texto da mensagem para a pessoa.' },
            handoff: { type: 'boolean', description: 'true se uma pessoa da equipe precisa assumir a conversa.' },
            handoff_reason: { type: 'string', description: 'Motivo curto do handoff, para a equipe.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Etiquetas de interesse, ex: desafio, preco, acesso.' },
          },
          required: ['reply', 'handoff'],
        },
      }],
      tool_choice: { type: 'tool', name: 'responder' },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Claude API ${res.status}`);
  const tool = (data.content || []).find(c => c.type === 'tool_use');
  if (!tool?.input?.reply) throw new Error('Claude returned no reply');
  return {
    reply: String(tool.input.reply).trim(),
    handoff: !!tool.input.handoff,
    handoffReason: tool.input.handoff_reason || '',
    tags: Array.isArray(tool.input.tags) ? tool.input.tags.slice(0, 5).map(t => String(t).toLowerCase()) : [],
    usage: data.usage,
  };
}
