# fn-desafio-reset

Funil do **Desafio Reset Metabólico** da nutricionista Fernanda Nadaline: landing + página de obrigado.
HTML, CSS e JS puros em `public/`, servidos pelo Cloudflare (Workers com static assets), com uma função pequena para o formulário.
Projeto CraftFrame, nov 2026.

```
public/                               o site (o que o visitante recebe)
  desafio-reset-metabolico-v3/        landing
  obrigado-reset-metabolico-v3/       obrigado (noindex)
  assets/js/config.js                 ← DATAS, LINKS: o arquivo para editar a cada edição do desafio
  assets/video/LEIA-ME.txt            onde entram os vídeos da Fernanda
  _headers  _redirects  404.html      cache, segurança, atalhos (/ → landing, /reset, /obrigado)
src/worker.js                         POST /api/lead e /api/answers → webhooks (segredos)
wrangler.jsonc                        configuração do Cloudflare
```

## 1 · Repositório

GitHub: **github.com/gustavomorale/FN27** (branch `main`). Para trabalhar localmente:

```bash
git clone https://github.com/gustavomorale/FN27.git
```

## 2 · Ligar no Cloudflare (uma vez)

1. dash.cloudflare.com → **Workers & Pages → Create → Import a repository** → escolha `gustavomorale/FN27`.
2. Build command: *(vazio)* · Deploy command: `npx wrangler deploy` (o padrão). Nada para compilar.
3. Depois do primeiro deploy, em **Settings → Variables and Secrets**, adicione como *Secret*:
   - `LEAD_WEBHOOK_URL` · webhook que recebe o e-mail (ManyChat, Make, Kajabi…)
   - `ANSWERS_WEBHOOK_URL` · webhook das duas perguntas (opcional)
   - `WEBHOOK_TOKEN` · opcional, enviado como `Authorization: Bearer …`
4. **Settings → Domains & Routes → Add custom domain**, por exemplo `desafio.fernandanadaline.com` (o domínio precisa estar no Cloudflare; se ainda estiver só na hospedagem do WordPress, use um subdomínio com CNAME ou mude o DNS para o Cloudflare).
5. Opcional: **Web Analytics** (sem cookies) no mesmo painel.

A partir daí, **todo `git push` na `main` publica sozinho**, e cada branch ganha um link de pré-visualização.

## O que o formulário envia

`POST /api/lead` valida o e-mail e o consentimento e repassa para `LEAD_WEBHOOK_URL`:

```json
{ "email": "…", "consent": true, "angulo": "inchaco", "page": "/desafio-reset-metabolico-v3/",
  "utm_source": "fb", "utm_content": "…", "received_at": "2026-11-02T13:00:00Z",
  "country": "PT", "source": "fn-desafio-reset-v3" }
```

`country` vem do Cloudflare (país de conexão), útil para segmentar sem perguntar.
Sem webhook configurado, responde OK e não repassa nada (modo teste).

## Rodar localmente

```bash
npm install
npm run dev          # http://localhost:8787
```
Segredos locais vão em `.dev.vars` (já no `.gitignore`), uma linha por segredo: `LEAD_WEBHOOK_URL=https://…`

## A cada nova edição do desafio

1. Editar as datas em `public/assets/js/config.js`.
2. `git commit` + `git push`. Pronto.

## Antes do primeiro anúncio

- Colar o Meta Pixel / GTM no `<head>` das duas páginas (respeitando o consentimento de cookies).
- Eventos já disparados: `Lead`, `JoinWhatsAppGroup`, `AddToCalendar`, `SurveyAnswered`, `VideoPlay`.
- Fernanda aprova: FAQ com [Confirmar] e frases da nuvem de depoimentos (consentimento das participantes).
- Trocar o link dos anúncios para o novo domínio.
