# Pokédex Lentinia

Sito (GitHub Pages) + app Android a schermo intero (APK) + database in tempo reale (Supabase).

```
web/                       l'app (index.html, sync.js, config.js)
supabase/migrations/       schema database, permessi (RLS), realtime, storage
supabase/functions/        manage-players: crea/gestisce gli account giocatori (solo master)
scripts/                   generazione config Capacitor + patch Android "frameless"
.github/workflows/         pages.yml (sito) · android.yml (APK) · keepalive.yml (anti-pausa) · supabase.yml (facoltativo)
```

## Come funziona

- **Accesso**: nome utente + password (Supabase Auth). Il master ha un account `master`; i giocatori vengono creati dal master dentro l'app (dashboard → **Account**) e collegati a una scheda.
- **Permessi** (applicati dal database, non solo dall'interfaccia):
  - il **master** modifica tutto;
  - un **giocatore** può modificare solo la **propria** scheda:
    - allenatore: soldi, squadra Pokémon, attributi (fisici e sociali), abilità (nelle Extra anche il nome del campo), achievement, pozioni, inventario, medaglie, note (+ il rank, che sale da solo con gli achievement);
    - Pokémon: **solo quelli nella propria squadra** e solo precisione, danno, oggetto, attributi, skill e note;
    - le schede degli altri e tutto il resto sono in sola lettura;
  - Pokédex (Incontrato/Catturato, altri campi dei Pokémon), Mappa e Icona: lettura per tutti, scrittura solo master.
- **Tempo reale**: ogni cambiamento arriva a tutti gli utenti collegati in pochi istanti (indicatore in basso a sinistra: verde = sincronizzato, arancione = salvataggio, rosso = offline).
- **Modifiche simultanee**: ogni salvataggio invia solo i campi cambiati e il database li unisce. Se il master cambia i *Soldi* mentre un giocatore scrive una nota sulla stessa scheda, si salvano entrambi. Gli aggiornamenti remoti non vengono applicati mentre stai scrivendo o sei in modalità Modifica: arrivano appena finisci.
- **Immagini**: le foto vengono caricate su Supabase Storage (solo il master può caricarle) e nel database resta solo l'indirizzo.
- **APK**: è un guscio a schermo intero che apre il sito. Ogni aggiornamento del sito arriva subito, senza reinstallare l'app.

## Stato attuale

Il progetto Supabase **pokedex-lentinia** (`iyxdmcopwgmawlgcemkb`, regione Francoforte, piano gratuito) è già creato: migrazioni 0001-0003 applicate, funzione `manage-players` pubblicata, permessi collaudati sul database. Restano da fare solo i punti **1 (passi 2, 4, 5)**, **2**, **3** e **4** qui sotto.
Valori da inserire come variabili GitHub:
- `SUPABASE_URL` = `https://iyxdmcopwgmawlgcemkb.supabase.co`
- `SUPABASE_ANON_KEY` = la chiave che trovi in `web/config.js`
- `SUPABASE_PROJECT_REF` = `iyxdmcopwgmawlgcemkb` (solo se usi il workflow `supabase.yml`)

## 1. Supabase

1. Crea un progetto su supabase.com.
2. **Authentication → Providers → Email**: disattiva *Confirm email*.
3. **SQL Editor**: esegui in ordine `0001_init.sql`, `0002_permessi_icona.sql` e `0003_hardening_funzioni.sql` (già fatto sul progetto attuale).
4. **Authentication → Users → Add user**: email `master@lentinia.app`, una password a scelta, *Auto Confirm User* attivo.
5. Nel SQL Editor: `update public.profiles set role = 'master' where username = 'master';`
6. Pubblica la funzione degli account (da terminale, con la [Supabase CLI](https://supabase.com/docs/guides/cli)):
   ```bash
   supabase login
   supabase link --project-ref <PROJECT_REF>
   supabase functions deploy manage-players
   ```
   (oppure usa il workflow `supabase.yml`, vedi sotto).
7. **Project Settings → API**: copia *Project URL* e la chiave *anon public*.

> Gli utenti accedono con un nome utente: internamente diventa `nomeutente@lentinia.app`. Nessuna email viene mai inviata.

## 2. GitHub (sito)

1. Crea un repository e carica questa cartella (branch `main`).
2. **Settings → Secrets and variables → Actions → Variables** → aggiungi:
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_ANON_KEY` = chiave anon public (è pubblica per progettazione: la sicurezza è nelle policy RLS)
3. **Settings → Pages → Source: GitHub Actions**.
4. Fai un push su `main`: il workflow *Deploy sito* pubblica su `https://<utente>.github.io/<repo>/`.

## 3. Primo accesso

1. Apri il sito, entra come `master`.
2. Il database è vuoto: l'app chiede se caricare i dati presenti sul dispositivo (allenatori, Pokédex, mappa). Accetta **dal dispositivo/browser che ha i dati aggiornati**.
3. Dashboard → **Account** → crea i giocatori (nome utente, password, scheda collegata). Puoi cambiare password, riassegnare la scheda o eliminare l'account in qualsiasi momento.

## 4. APK Android

1. Genera una volta la chiave di firma (serve perché gli aggiornamenti dell'APK si installino sopra la versione precedente):
   ```bash
   keytool -genkeypair -v -keystore lentinia.jks -alias lentinia -keyalg RSA -keysize 2048 -validity 10000
   base64 -w0 lentinia.jks     # su macOS: base64 -i lentinia.jks
   ```
   Conserva `lentinia.jks` e la password in un posto sicuro (non nel repository).
2. **Settings → Secrets and variables → Actions → Secrets**:
   `ANDROID_KEYSTORE_B64` (output di base64), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`lentinia`), `ANDROID_KEY_PASSWORD` (la stessa password, se non ne hai scelta una diversa).
   Facoltativo: variabile `APP_URL` se il sito non è su `https://<utente>.github.io/<repo>/`.
3. **Actions → Build APK Android → Run workflow**. A fine build scarichi `Pokedex-Lentinia.apk` dagli *Artifacts* (con un tag `v1.0.0` l'APK viene anche allegato alla Release).
4. Sul telefono: apri il file, consenti l'installazione da origini sconosciute, installa. L'app parte a schermo intero; le barre di sistema riappaiono con uno swipe dal bordo.

Senza keystore il workflow produce un APK di debug: funziona, ma ogni build ha una firma diversa e per aggiornare bisogna prima disinstallare la versione precedente.

L'APK serve solo da guscio: il codice dell'app vive sul sito. Va ricompilato solo se cambi nome, icona o URL.

## 5. Icona dell'app

Dashboard (master) → pillola **Icona**, prima di *Importa dati*: carichi un PNG (consigliato 1024×1024, la trasparenza viene mantenuta). L'icona cambia subito per tutti su sito, schermata di accesso, scheda del browser e installazione come app desktop (PWA).
Per l'**APK** l'icona del launcher si decide in fase di build: dopo averla cambiata rilancia *Actions → Build APK Android* (la scarica da sola dal database e genera le icone Android) e reinstalla l'APK.

## 6. Niente pausa dopo 7 giorni

Il piano gratuito di Supabase mette in pausa i progetti inattivi. `keepalive.yml` fa una richiesta al database ogni giorno (e un commit vuoto se il repository è fermo da più di 45 giorni, perché GitHub disattiva i workflow pianificati dopo 60 giorni di inattività). Non serve configurare nulla oltre alle variabili del punto 2. Se vuoi una garanzia assoluta, il piano Pro di Supabase non mette in pausa i progetti.

## 7. Workflow Supabase (facoltativo)

`supabase.yml` applica migrazioni e pubblica la funzione a ogni push su `supabase/**`. Servono: secret `SUPABASE_ACCESS_TOKEN` (da supabase.com/dashboard/account/tokens), secret `SUPABASE_DB_PASSWORD`, variabile `SUPABASE_PROJECT_REF`.

## Sviluppo in locale

Compila `web/config.js` con URL e anon key, poi `npm run dev` (o qualsiasi server statico su `web/`). Senza configurazione l'app parte in modalità solo-locale, come la versione precedente.

## Limiti da conoscere

- **Squadra e Pokémon**: il database verifica che il Pokémon sia nella squadra del giocatore usando i numeri che l'app scrive nella sua scheda (`SqN 1…6`); un giocatore che manomettesse l'API potrebbe dichiarare in squadra un Pokémon qualsiasi, ma anche così potrebbe cambiare solo i campi consentiti (precisione, danno, oggetto, attributi, skill, note).
- **Rank**: il rank sale automaticamente quando un giocatore completa tutti gli achievement, quindi `Rank` è tra i campi che il giocatore può scrivere. L'interfaccia non gli mostra il selettore, ma chi chiamasse direttamente l'API potrebbe impostarlo a mano sulla propria scheda. Si può blindare spostando il passaggio di rank in una funzione lato server.
- **Lettura**: ogni giocatore loggato può leggere tutte le schede e lo stato del Pokédex (la dashboard mostra già tutti gli allenatori).
- **Offline**: senza rete l'app mostra gli ultimi dati salvati e ritenta da sola, ma le modifiche fatte offline si perdono se chiudi l'app prima del ritorno della connessione.
- **Supabase gratuito**: i progetti inattivi per circa una settimana vengono messi in pausa; si riattivano dalla dashboard.
- Dopo un'importazione backup (Importa dati) i dati online di **tutti** vengono sostituiti.
