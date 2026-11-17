# dm-bot: FN's ManyChat replacement (Meta + Claude)

A Cloudflare Worker that replaces ManyChat for Fernanda Nadaline (FN):

- **Instagram comment → DM**: keyword in a comment → public reply + private DM with link buttons (once per person, per post).
- **Instagram DMs and WhatsApp**: keyword flows first, Claude for any other text, handoff to a human for anything sensitive.
- **WhatsApp broadcasts** with approved templates, opt-out (PARAR) and opt-in (VOLTAR), CSV import from ManyChat.
- **Control panel** at `/panel/`: inbox with takeover, flow editor, AI settings with a sandbox, broadcasts, import, health check, version history, go-live checklist.

```
Meta webhook ─> /webhook ─ signature check, size cap, de-dup
                          ├ mode gate: paused / shadow / live (+ tester allowlist)
                          ├ opt-out / opt-in
                          ├ keyword flows (exact first, then list order)
                          ├ Claude (fixed guardrails + FN knowledge, per-person and daily caps) ─> human handoff
                          └ Meta send ─> D1 log
Panel /panel/ ─> /api/* (password, IP lockout)       Cron weekly ─> IG token refresh, data retention
```

## Safety model

| Layer | What it does |
|---|---|
| **Modes** | `paused` logs only (kill switch). `shadow` works out every reply and shows it in the Inbox marked SHADOW, but sends nothing. `live` sends. **New installs start in shadow.** Going live requires typing LIVE. |
| **Tester allowlist** | IG usernames or WhatsApp numbers that get real replies even in shadow, so you can test end to end before launch. |
| **Health guardrails** | Fixed in `src/ai.js`, not editable from the panel: no medical/nutrition advice, no invented prices or links, health/complaint/payment/"talk to a person" → human. Only discusses FN's business (keeps it inside WhatsApp's 2026 AI policy). |
| **Cost and loop caps** | Max AI replies per person per hour (8) and per day (400). Over the cap → fallback message + human. Also set a monthly spend limit in the Anthropic console. |
| **Human takeover** | Handoffs, replies from the panel and replies typed in the Instagram app pause the bot for that person (24h default). |
| **Panel access** | Password of 12+ characters (setup generates 24), 10 wrong tries locks the IP for 15 min, strict security headers, no caching. Recommended: Cloudflare Access on `/panel/*` so only your emails get in. |
| **Webhook** | HMAC signature check (Instagram and Meta app secrets), 1 MB cap, retry de-duplication. |
| **Rollback** | Every save of flows or settings keeps the previous version (last 20). Restore never switches to live. Plus JSON backup. |
| **Data** | D1 in FN's Cloudflare account, message history deleted after 365 days (configurable). No secrets in the repo; CI fails if a token pattern is committed. |
| **Broadcasts** | Only to opted-in WhatsApp contacts, approved templates only, typed ENVIAR to send. |

## Setup

### 1. Deploy (about 15 minutes)

```bash
cd dm-bot
npm install
bash scripts/setup.sh
```

The script logs you into Cloudflare and creates the D1 database (it writes the id into `wrangler.toml`, which you then commit). It runs the tests, deploys in shadow mode, generates the panel password and webhook verify token, exchanges the Instagram token for a 60-day one, reads FN's account id and stores every secret. It is safe to re-run.

Long term, connect this folder to Cloudflare **Workers Builds** (Workers & Pages > Create > Import repository > `FN27`, root directory `dm-bot`) so merges to `main` deploy automatically. GitHub Actions runs the tests on every PR that touches `dm-bot/`.

### 2. Meta app (about 45 minutes)

1. developers.facebook.com > Create app > **Business**, owned by FN's business portfolio. Add yourself and FN as admins.
2. **Instagram** product > *API setup with Instagram login*: add FN's professional account and generate a token (the setup script asks for it). Webhooks: callback `https://<worker>/webhook`, verify token from the script, fields `messages`, `messaging_postbacks`, `comments`, `live_comments`. In the Instagram app: Settings > Messages and story replies > Message controls > Connected tools > **Allow access to messages**.
3. **WhatsApp** product: connect FN's existing WhatsApp Business Account (see step 3). Business Settings > System users > add one, assign the app and the WABA, generate a permanent token with `whatsapp_business_messaging` + `whatsapp_business_management`. Webhook field: `messages`.
4. Panel > Setup > **Connect webhooks** (switches on Instagram account webhooks and subscribes the app to the WABA) > **Run health check**. Everything should be green.
5. Switch the app to **Live** in Meta when you are ready for real followers. It only serves FN's own accounts, so standard access is normally enough. If Meta asks for review, record the comment-to-DM flow on a tester account.

### 3. Moving off ManyChat (approval gate)

1. Export WhatsApp contacts from ManyChat, import them in the panel (Import tab, tag `manychat`).
2. Rebuild ManyChat's keywords in Flows (or restore `seed/fn-dm-starter.json` from Setup > Backup and edit).
3. **Shadow week**: Instagram webhooks reach both ManyChat and this bot, so leave ManyChat running and read the SHADOW replies in the Inbox for 3 to 7 days.
4. Check in Business Settings that the WABA belongs to FN's portfolio. Disconnect WhatsApp in ManyChat, subscribe our app (Connect webhooks). Do it at a quiet hour.
5. Switch off ManyChat's Instagram automations, then switch the panel to **Live**. Gustavo and FN must both approve this step first.

### 4. Content (approval gate)

1. AI tab: write FN knowledge from the FN27 Mini Brain (programmes, prices, dates, official links, FAQs, tone). The bot only knows what is written there.
2. Sandbox: test a price question, a date question, "tomo remédio para tireoide" (must hand off), "escreve minha redação" (must decline), "você é um robô?" (must say it's automated).
3. FN reads about 10 sandbox replies and approves the voice.
4. Add your number and a test IG account to the allowlist and try every flow for real.

## Daily use

- **Inbox > Needs a human**: reply in the panel (inside 24h) or in the Instagram app; the bot pauses for that person. Use "Hand back to bot" / "Mark done" when finished.
- **Flows**: one keyword per post or launch; use post ids for post-specific keywords. Test before saving.
- **Mode switch** (top right): Paused stops everything instantly if anything goes wrong.
- **Broadcast**: Utility template first where it fits, filter by tag, check the count, type ENVIAR. Gustavo and FN approve the template, audience and timing first.

## Limits

- Free-form replies only within 24h of the person's last message. After that, WhatsApp needs a template and Instagram can't be messaged.
- A private reply to a comment is one message; the chat continues when the person replies.
- Instagram: up to 3 link buttons. WhatsApp: 1 link button or 3 reply buttons. If Meta rejects a format, the bot sends plain text with links.

## Development

```bash
npm test                                      # 15 end-to-end tests, in-memory DB, mocked Meta and Claude
npm run db:init:local && npx wrangler dev     # local run, panel at http://localhost:8787/panel/
```

`src/index.js` webhook, events, panel API, cron · `src/engine.js` matching, parsing, modes, defaults · `src/ai.js` Claude prompt and guardrails · `src/meta.js` Graph API · `src/db.js` D1 and versions · `public/panel/` panel · `scripts/setup.sh` guided setup.

## Privacy

Add a line to FN's privacy policy about automated replies on Instagram/WhatsApp, AI assistance (Anthropic as processor), retention and opting out. CraftFrame should have a DPA with FN covering this processing.
