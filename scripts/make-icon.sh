#!/usr/bin/env bash
# Scarica l'icona impostata dal master nell'app (tabella app_settings) e genera le icone Android.
# Se non c'è nessuna icona resta quella predefinita di Capacitor.
set -uo pipefail
: "${SUPABASE_URL:?}"; : "${SUPABASE_ANON_KEY:?}"

ICON=$(curl -fsS "$SUPABASE_URL/rest/v1/app_settings?id=eq.1&select=data" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" | jq -r '.[0].data.Icona // empty')

if [ -z "$ICON" ]; then
  echo "Nessuna icona impostata: uso l'icona predefinita."
  exit 0
fi

MAGICK=$(command -v magick || command -v convert || true)
if [ -z "$MAGICK" ]; then sudo apt-get update -qq && sudo apt-get install -y -qq imagemagick && MAGICK=$(command -v convert); fi

mkdir -p assets
curl -fsSL "$ICON" -o /tmp/icon.png
# icona intera (trasparenza mantenuta) e livello "foreground" con margine di sicurezza per le icone adattive
"$MAGICK" /tmp/icon.png -background none -resize 1024x1024 -gravity center -extent 1024x1024 assets/icon-only.png
"$MAGICK" /tmp/icon.png -background none -resize 680x680   -gravity center -extent 1024x1024 assets/icon-foreground.png
npm install --no-save --no-audit --no-fund @capacitor/assets
npx capacitor-assets generate --android --assetPath assets \
  --iconBackgroundColor '#FFFFFF' --iconBackgroundColorDark '#FFFFFF' \
  || echo "::warning::Generazione icone non riuscita: resta l'icona predefinita"
