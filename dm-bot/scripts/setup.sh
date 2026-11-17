#!/usr/bin/env bash
# Guided setup for the FN DM bot. Safe to re-run: every step checks before it acts.
# Run from the dm-bot folder:  bash scripts/setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

say()  { printf "\n\033[1;35m▶ %s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
ask_secret() { # name, prompt
  local v; read -r -s -p "  $2 (Enter to skip): " v; echo
  if [ -n "$v" ]; then printf '%s' "$v" | npx wrangler secret put "$1" >/dev/null && ok "$1 saved"; else warn "$1 skipped"; fi
}

say "1/6 Cloudflare login"
npx wrangler whoami >/dev/null 2>&1 || npx wrangler login
ok "Logged in as $(npx wrangler whoami 2>/dev/null | grep -Eo '[^ ]+@[^ ]+' | head -1)"

say "2/6 Database (D1)"
if grep -q REPLACE_WITH_D1_ID wrangler.toml; then
  out=$(npx wrangler d1 create fn-dm 2>&1 || true)
  id=$(printf '%s' "$out" | grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  if [ -z "$id" ]; then id=$(npx wrangler d1 list --json | node -e 'const l=JSON.parse(require("fs").readFileSync(0));const d=l.find(x=>x.name==="fn-dm");if(d)console.log(d.uuid)'); fi
  [ -n "$id" ] || { echo "Could not create or find the fn-dm database"; exit 1; }
  sed -i.bak "s/REPLACE_WITH_D1_ID/$id/" wrangler.toml && rm -f wrangler.toml.bak
  ok "Database fn-dm ($id). Commit wrangler.toml so Cloudflare builds use it."
else ok "Database already set in wrangler.toml"; fi
npx wrangler d1 execute fn-dm --remote --file=schema.sql >/dev/null && ok "Tables ready"

say "3/6 Tests and first deploy (bot starts in SHADOW mode: it sends nothing)"
npm test >/dev/null 2>&1 && ok "Tests pass" || { echo "Tests failed, stopping."; exit 1; }
url=$(npx wrangler deploy 2>&1 | grep -Eo 'https://[^ ]+workers\.dev' | head -1 || true)
ok "Deployed ${url:-"(see Cloudflare dashboard for the URL)"}"

say "4/6 Generated secrets (save both in your password manager NOW, they are shown once)"
PANEL_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)
VERIFY=$(openssl rand -hex 20)
printf '%s' "$PANEL_PASSWORD" | npx wrangler secret put PANEL_PASSWORD >/dev/null
printf '%s' "$VERIFY" | npx wrangler secret put META_VERIFY_TOKEN >/dev/null
echo "  PANEL_PASSWORD     $PANEL_PASSWORD"
echo "  META_VERIFY_TOKEN  $VERIFY   (paste into Meta > Webhooks > Verify token)"

say "5/6 Instagram (Meta app > Instagram > API setup with Instagram login)"
read -r -s -p "  Instagram app secret (Enter to skip): " IGSEC; echo
if [ -n "$IGSEC" ]; then
  printf '%s' "$IGSEC" | npx wrangler secret put IG_APP_SECRET >/dev/null && ok "IG_APP_SECRET saved"
  read -r -s -p "  Access token generated for FN's account (short or long-lived): " IGTOK; echo
  if [ -n "$IGTOK" ]; then
    long=$(curl -s "https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=$IGSEC&access_token=$IGTOK" | node -e 'try{const d=JSON.parse(require("fs").readFileSync(0));console.log(d.access_token||"")}catch{console.log("")}')
    [ -n "$long" ] && ok "Exchanged for a 60-day token (refreshed weekly by the bot)" || { long="$IGTOK"; warn "Exchange failed, using the token as given (probably already long-lived)"; }
    printf '%s' "$long" | npx wrangler secret put IG_ACCESS_TOKEN >/dev/null && ok "IG_ACCESS_TOKEN saved"
    me=$(curl -s "https://graph.instagram.com/me?fields=user_id,username&access_token=$long")
    igid=$(printf '%s' "$me" | node -e 'try{console.log(JSON.parse(require("fs").readFileSync(0)).user_id||"")}catch{console.log("")}')
    if [ -n "$igid" ]; then printf '%s' "$igid" | npx wrangler secret put IG_USER_ID >/dev/null && ok "IG_USER_ID $igid ($(printf '%s' "$me" | grep -Eo '"username":"[^"]+"'))"; else warn "Could not read the account id; set IG_USER_ID by hand"; fi
  fi
fi

say "6/6 WhatsApp and Claude"
ask_secret META_APP_SECRET   "Meta app secret (App settings > Basic)"
ask_secret WA_TOKEN          "WhatsApp system user permanent token"
ask_secret WA_PHONE_NUMBER_ID "WhatsApp phone number id"
ask_secret WA_WABA_ID        "WhatsApp Business Account id"
ask_secret ANTHROPIC_API_KEY "Claude API key (console.anthropic.com, set a monthly spend limit there)"

say "Done"
cat <<EOF
  Webhook URL for Meta:  ${url:-https://<your-worker>}/webhook
  Control panel:         ${url:-https://<your-worker>}/panel/
  Next: in the panel, Setup > "Connect webhooks", then "Run health check".
  The bot is in SHADOW mode. Nothing is sent to real followers until you switch to Live.
EOF
