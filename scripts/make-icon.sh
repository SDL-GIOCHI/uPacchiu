#!/usr/bin/env bash
# Prepara le icone Android.
#  - Se il master ha caricato un'icona nell'app (tabella app_settings) la scarica e le aggiunge l'ombra esterna.
#  - Altrimenti usa le icone già nel repository (assets/icon-only.png e assets/icon-foreground.png).
# Qualunque problema qui NON deve far fallire la build dell'APK.
set -uo pipefail

ICON=""
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_ANON_KEY:-}" ]; then
  ICON=$(curl -fsS "$SUPABASE_URL/rest/v1/app_settings?id=eq.1&select=data" \
    -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" 2>/dev/null \
    | jq -r '.[0].data.Icona // empty' 2>/dev/null || true)
fi

if [ -n "$ICON" ]; then
  MAGICK=$(command -v magick || command -v convert || true)
  if [ -z "$MAGICK" ]; then sudo apt-get update -qq && sudo apt-get install -y -qq imagemagick && MAGICK=$(command -v convert); fi
  if curl -fsSL "$ICON" -o /tmp/icon.png && [ -n "$MAGICK" ]; then
    mkdir -p assets
    make() { # $1 = lato finale, $2 = lato del logo, $3 = file di uscita
      "$MAGICK" /tmp/icon.png -background none -resize "$2x$2" -gravity center -extent "$1x$1" \
        \( +clone -background black -shadow 50x14+0+12 \) +swap -background none -layers merge +repage \
        -gravity center -extent "$1x$1" "$3"
    }
    make 1024 900 assets/icon-only.png && make 1024 680 assets/icon-foreground.png \
      && echo "Icona personalizzata scaricata e preparata" \
      || echo "::warning::Preparazione icona personalizzata non riuscita: uso quella del repository"
  else
    echo "::warning::Icona personalizzata non scaricabile: uso quella del repository"
  fi
else
  echo "Nessuna icona personalizzata: uso quella del repository."
fi

if [ -f assets/icon-only.png ]; then
  npm install --no-save --no-audit --no-fund @capacitor/assets \
    && npx capacitor-assets generate --android --assetPath assets \
         --iconBackgroundColor '#FFFFFF' --iconBackgroundColorDark '#FFFFFF' \
    || echo "::warning::Generazione icone non riuscita: resta l'icona predefinita di Capacitor"
fi
exit 0
