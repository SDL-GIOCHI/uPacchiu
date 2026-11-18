// Scrive capacitor.config.json. L'APK è un "guscio" a schermo intero che carica il sito:
// ogni aggiornamento pubblicato su GitHub Pages arriva subito, senza reinstallare l'app.
const fs = require("fs");
const url = process.env.APP_URL;
if (!url) { console.error("Imposta APP_URL (es. APP_URL=https://utente.github.io/repo/ node scripts/make-config.js)"); process.exit(1); }
const cfg = {
  appId: "app.lentinia.pokedex",
  appName: "Pokédex Lentinia",
  webDir: "web",
  backgroundColor: "#FFFFFF",
  server: { url, androidScheme: "https", cleartext: false },
  android: { allowMixedContent: false }
};
fs.writeFileSync("capacitor.config.json", JSON.stringify(cfg, null, 2) + "\n");
console.log("capacitor.config.json scritto, server.url =", url);
