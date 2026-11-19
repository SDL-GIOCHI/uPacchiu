#!/usr/bin/env bash
# Copia nel progetto Android le icone già pronte (android-res/). Nessun download, nessuno strumento esterno.
set -euo pipefail
RES=android/app/src/main/res
[ -d "$RES" ] || { echo "Cartella $RES non trovata: esegui prima 'npx cap add android'"; exit 1; }
cp -r android-res/. "$RES"/
# elimina eventuali icone adattive vecchie che citano risorse inesistenti
rm -f "$RES"/mipmap-*/ic_launcher_background.* 2>/dev/null || true
echo "Icone applicate:"; ls "$RES"/mipmap-xxxhdpi
