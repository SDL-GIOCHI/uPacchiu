/* Pokédex Lentinia — sincronizzazione con Supabase
 * Caricato PRIMA dello script principale dell'app. Le funzioni usano le variabili globali
 * dell'app (DB, draw, V, EDIT, SNAP, mkt, PK0, ...) solo quando vengono eseguite.
 *
 * Modello dati:
 *  - trainers      -> una riga per allenatore, diviso in master_data / player_data
 *  - pokemon_state -> override del Pokédex (e flag Incontrato/Catturato), una riga per Pokémon
 *  - map_state     -> una riga con la mappa
 * Ogni salvataggio invia solo le chiavi cambiate (RPC patch_*), quindi modifiche
 * simultanee a campi diversi non si sovrascrivono.
 */
(function () {
  "use strict";
  const cfg = window.LENTINIA_CONFIG || {};
  const BUCKET = "lentinia";
  const PLAYER_KEYS = /^(Squadra \d|SqN \d|Ach|AchD|Poz|Inv|Med|Note|Rank|Soldi|Base|ExtraNome: Extra \d|Attributi (Fisici|Sociali): .+|Abilità (Lotta|Sopravvivenza|Sociali|Conoscenza|Extra): .+)$/;
  // chiavi di un Pokémon in squadra che il giocatore può modificare (devono coincidere con pk_key_ok() nel database)
  const PK_KEYS = /^(Quick References: (Precisione|Danno|Oggetto)|Attributi (Fisici|Sociali): .+|Skill (di Lotta|di Sopravvivenza|Sociali): .+|Note)$/;
  const S = (window.Sync = { local: false });

  let sb = null, profile = null, chan = null;
  let last = { tr: {}, ov: {}, map: {} };
  let muted = false, pushTimer = null, pushing = false, dirty = false;
  let refTimer = null, needRef = false, pollTimer = null, started = false;
  const imgCache = new Map();
  const j = JSON.stringify;
  const norm = (x) => JSON.parse(j(x));
  const uuid = () =>
    (crypto.randomUUID && crypto.randomUUID()) ||
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 3) | 8).toString(16);
    });
  const host = () => { try { return new URL(cfg.SUPABASE_URL).host; } catch (e) { return String(cfg.SUPABASE_URL || "(non impostato)"); } };
  const emailOf = (u) => { const x = String(u || "").trim().toLowerCase(); return x.includes("@") ? x : x + "@" + (cfg.EMAIL_DOMAIN || "lentinia.app"); };

  function deq(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!(k in b) || !deq(a[k], b[k])) return false;
    return true;
  }

  S.isMaster = () => (S.local ? true : !!profile && profile.role === "master");
  S.uid = () => (profile ? profile.id : null);
  const teamNames = (t) => [1, 2, 3, 4, 5, 6].map((n) => String(t["Squadra " + n] || "").trim().toUpperCase()).filter(Boolean);
  // un giocatore può modificare un Pokémon solo se è nella squadra del PROPRIO allenatore
  S.canPk = (e) => {
    if (S.local || !profile || DB.master || profile.role === "master" || !e) return false;
    const nm = String(e.Nome || "").trim().toUpperCase();
    return !!nm && DB.tr.some((t) => t._o === profile.id && teamNames(t).includes(nm));
  };
  // numeri dei Pokémon in squadra (il database li usa per verificare i permessi)
  function syncSq(t) {
    for (let n = 1; n <= 6; n++) {
      const nm = String(t["Squadra " + n] || "").trim().toUpperCase();
      const i = nm ? DB.man.pokemon.findIndex((e) => String(e.Nome || "").trim().toUpperCase() === nm) : -1;
      const v = i >= 0 ? String(DB.man.pokemon[i]["N°"]) : null;
      if (v == null) { if (t["SqN " + n] != null) delete t["SqN " + n]; }
      else if (t["SqN " + n] !== v) t["SqN " + n] = v;
    }
  }
  const myTeamNs = () => {
    const out = new Set();
    DB.tr.forEach((t) => { if (t._o === (profile && profile.id)) teamNames(t).forEach((nm) => {
      const e = DB.man.pokemon.find((x) => String(x.Nome || "").trim().toUpperCase() === nm); if (e) out.add(String(e["N°"]));
    }); });
    return out;
  };

  /* ---------- indicatore di stato + messaggi ------------------------- */
  const css = document.createElement("style");
  css.textContent =
    "#syncrow{display:flex;justify-content:flex-end;align-items:center;height:18px;padding:6px 14px 0;box-sizing:content-box}" +
    "#syncdot{width:10px;height:10px;border-radius:50%;background:#bbb;opacity:.9}" +
    "#syncdot.ok{background:#27AE60}#syncdot.sync{background:#FF9900}#syncdot.err{background:#FB1B1B}" +
    "#synctoast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1C1C1C;color:#fff;padding:9px 16px;border-radius:999px;font-size:13px;z-index:10000;max-width:86vw;text-align:center}" +
    "#lgn{position:fixed;inset:0;background:#fff;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;overflow:auto}" +
    "#lgn .lb{width:100%;max-width:340px;text-align:center}" +
    "#lgn h1{margin:12px 0 4px;font-size:26px;letter-spacing:.02em;color:#1C1C1C}" +
    "#lgn p{margin:0 0 18px;color:#666;font-size:14px}" +
    "#lgn input{width:100%;box-sizing:border-box;border:1.5px solid #1C1C1C;background:#fff;color:#1C1C1C;border-radius:999px;padding:12px 18px;font:inherit;font-size:16px;margin:0 0 10px;outline:none}" +
    "#lgn input:focus{border-color:#FB1B1B}" +
    "#lgn button{width:100%;border:0;border-radius:999px;padding:13px 18px;background:#FB1B1B;color:#fff;font:inherit;font-size:16px;font-weight:600;cursor:pointer;margin-top:4px}" +
    "#lgn button:disabled{opacity:.6}" +
    "#lgn .er{color:#FB1B1B;font-size:14px;min-height:20px;margin:6px 0 0}";
  document.head.appendChild(css);
  const dot = document.createElement("div");
  dot.id = "syncdot";
  dot.title = "Sincronizzazione";
  // riga propria sopra l'app: non si sovrappone alla grafica e scorre con la pagina
  const mountDot = () => {
    if (document.getElementById("syncrow")) return;
    const app = document.getElementById("app");
    if (!app) return;
    const row = document.createElement("div");
    row.id = "syncrow";
    row.appendChild(dot);
    app.parentNode.insertBefore(row, app);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountDot); else mountDot();
  function setStatus(st) {
    dot.className = st;
    dot.title = { ok: "Sincronizzato", sync: "Salvataggio…", err: "Offline / errore di sincronizzazione" }[st] || "";
  }
  function toast(msg) {
    let t = document.getElementById("synctoast");
    if (!t) { t = document.createElement("div"); t.id = "synctoast"; document.body.appendChild(t); }
    t.textContent = msg;
    clearTimeout(t._t);
    t._t = setTimeout(() => t.remove(), 4000);
  }

  /* ---------- schermata di login -------------------------------------- */
  const POKEBALL =
    '<svg viewBox="-1 -1 26 26" width="64" height="64"><circle cx="12" cy="12" r="11" fill="#fff" stroke="#1C1C1C" stroke-width="1.6"/><path d="M1 12A11 11 0 0 1 23 12Z" fill="#FB1B1B" stroke="#1C1C1C" stroke-width="1.6"/><line x1="1" y1="12" x2="23" y2="12" stroke="#1C1C1C" stroke-width="1.6"/><circle cx="12" cy="12" r="3.5" fill="#fff" stroke="#1C1C1C" stroke-width="1.6"/></svg>';
  function showLogin(msg) {
    let d = document.getElementById("lgn");
    if (!d) {
      d = document.createElement("div");
      d.id = "lgn";
      d.innerHTML =
        '<form class="lb" autocomplete="on">' + '<img id="lgi" alt="" src="icon.png" style="width:104px;height:104px;background:transparent">' +
        "<h1>Pokédex Lentinia</h1><p>Accedi con il tuo nome utente</p>" +
        '<input id="lg-u" name="username" placeholder="Nome utente" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false">' +
        '<input id="lg-p" name="password" type="password" placeholder="Password" autocomplete="current-password">' +
        '<button type="submit">Accedi</button><div class="er" id="lg-e"></div><p style="margin:14px 0 0;font-size:11px;color:#999">Server: ' + host() + '</p></form>';
      document.body.appendChild(d);
      d.querySelector("form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const u = d.querySelector("#lg-u").value, p = d.querySelector("#lg-p").value, er = d.querySelector("#lg-e"), b = d.querySelector("button");
        if (!u.trim() || !p) { er.textContent = "Inserisci nome utente e password."; return; }
        b.disabled = true; er.textContent = "";
        const { data, error } = await sb.auth.signInWithPassword({ email: emailOf(u), password: p });
        b.disabled = false;
        if (error) {
          console.error("login", error);
          const msg = String(error.message || "");
          er.textContent = error.code === "invalid_credentials" || /invalid login credentials/i.test(msg) ? "Nome utente o password errati."
            : /api key|apikey|jwt/i.test(msg) ? "Configurazione errata: chiave API non valida (" + msg + ")."
            : /fetch|network|load failed/i.test(msg) ? "Impossibile contattare il server " + host() + ". Controlla la connessione o l'indirizzo configurato."
            : "Accesso non riuscito: " + msg;
          return;
        }
        d.querySelector("#lg-p").value = "";
        await start(data.session);
      });
    }
    d.style.display = "flex";
    d.querySelector("#lg-e").textContent = msg || "";
  }
  function hideLogin() { const d = document.getElementById("lgn"); if (d) d.style.display = "none"; }

  /* ---------- avvio / uscita ------------------------------------------ */
  S.boot = async function () {
    try { installManifest(); } catch (e) {}
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || !window.supabase) {
      S.local = true; // nessuna configurazione: l'app funziona come prima, solo in locale
      draw();
      return;
    }
    sb = S.sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    sb.auth.onAuthStateChange((ev) => {
      if (ev === "SIGNED_OUT") { teardown(); showLogin(); }
    });
    const { data } = await sb.auth.getSession();
    if (data && data.session) await start(data.session);
    else showLogin();
  };

  function teardown() {
    started = false; profile = null;
    clearTimeout(pushTimer); clearTimeout(refTimer); clearInterval(pollTimer);
    pushTimer = null; pushing = false; dirty = false; needRef = false;
    if (chan && sb) { try { sb.removeChannel(chan); } catch (e) {} chan = null; }
    try { localStorage.removeItem("lentinia2"); localStorage.removeItem("lentinia_profile"); } catch (e) {}
    const a = document.getElementById("app"); if (a) a.innerHTML = "";
    setStatus("");
  }

  S.logout = async function () { if (sb) await sb.auth.signOut(); };

  async function start(session) {
    let p = null;
    try {
      const r = await sb.from("profiles").select("id,username,role").eq("id", session.user.id).single();
      if (r.error) throw r.error;
      p = r.data;
      try { localStorage.setItem("lentinia_profile", j(p)); } catch (e) {}
    } catch (e) {
      try { const c = JSON.parse(localStorage.getItem("lentinia_profile") || "null"); if (c && c.id === session.user.id) p = c; } catch (e2) {}
      if (!p) { showLogin("Impossibile leggere il profilo. Controlla la connessione."); return; }
    }
    profile = p;
    DB.master = p.role === "master";
    hideLogin();
    started = true;
    try {
      await pull(true);
      setStatus("ok");
    } catch (e) {
      console.error(e);
      setStatus("err");
      toast("Offline: mostro gli ultimi dati salvati");
    }
    if (!started) return;
    subscribe();
    try { fixRoute(); } catch (e) {}
    draw();
  }

  /* ---------- Pokémon: ricostruzione da base + override --------------- */
  window.applyPk = function (i) {
    const e = DB.man.pokemon[i], b = PK0[i];
    Object.keys(e).forEach((k) => delete e[k]);
    Object.assign(e, b);
    e.RankB = e["Grado Sfida"] || "";
    e.StB = {};
    PSK.forEach((k) => (e.StB[k] = +e[k] || 0));
    Object.assign(e, DB.ov[e["N°"]] || {});
    e.MosseB = e.MosseL || [];
    mk(e);
  };
  const reapplyAll = () => DB.man.pokemon.forEach((_, i) => applyPk(i));

  /* ---------- snapshot e diff ----------------------------------------- */
  function split(t) {
    const m = {}, p = {};
    for (const k in t) { if (k === "_id" || k === "_o") continue; (PLAYER_KEYS.test(k) ? p : m)[k] = t[k]; }
    return { m, p };
  }
  const strs = (o) => { const r = {}; for (const k in o) r[k] = j(o[k]); return r; };
  function snapAll() {
    const o = { tr: {}, ov: {}, map: {} };
    DB.tr.forEach((t) => { if (t._id) { const s = split(t); o.tr[t._id] = { m: strs(s.m), p: strs(s.p) }; } });
    Object.keys(DB.ov).forEach((n) => (o.ov[n] = strs(DB.ov[n])));
    o.map = strs(DB.map);
    return o;
  }
  function diff(l, c) {
    const out = {};
    for (const k in c) if (l[k] !== c[k]) out[k] = JSON.parse(c[k]);
    for (const k in l) if (!(k in c)) out[k] = null;
    return out;
  }
  const empty = (o) => !Object.keys(o).length;

  /* ---------- immagini: dataURL -> Storage ----------------------------- */
  async function upImg(url) {
    if (imgCache.has(url)) return imgCache.get(url);
    const m = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(url);
    if (!m) return url;
    const bin = atob(m[2]), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const h = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
      .map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 40);
    const ext = { jpeg: "jpg", png: "png", webp: "webp", gif: "gif" }[m[1].split("/")[1]] || "img";
    const path = "img/" + h + "." + ext;
    const { error } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: m[1], upsert: false, cacheControl: "31536000" });
    if (error && !/exist|duplicate/i.test(error.message || "") && String(error.statusCode) !== "409") throw error;
    const pub = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    imgCache.set(url, pub);
    return pub;
  }
  async function fixImgs(o) {
    if (!o || typeof o !== "object") return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === "string" && v.startsWith("data:image/")) o[k] = await upImg(v);
      else if (v && typeof v === "object") await fixImgs(v);
    }
  }

  /* ---------- salvataggio (push) -------------------------------------- */
  S.changed = function () {
    if (muted || S.local || !profile) return;
    dirty = true;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, 600);
  };

  async function push() {
    pushTimer = null;
    if (!profile) return;
    if (pushing) { dirty = true; return; }
    pushing = true; dirty = false; setStatus("sync");
    const master = S.isMaster(), uid = profile.id;
    let err = null, needPull = false;
    try {
      DB.tr.forEach((t) => syncSq(t));
      if (master) {
        DB.tr.forEach((t) => { if (!t._id) t._id = uuid(); });
        for (const t of DB.tr) await fixImgs(t);
        for (const n of Object.keys(DB.ov)) { await fixImgs(DB.ov[n]); const i = DB.man.pokemon.findIndex((e) => String(e["N°"]) === String(n)); if (i >= 0) applyPk(i); }
        await fixImgs(DB.map);
      }
      const cur = snapAll();

      // allenatori
      for (let i = 0; i < DB.tr.length; i++) {
        const t = DB.tr[i], id = t._id;
        if (!id) continue;
        const c = cur.tr[id], l = last.tr[id];
        if (!l) {
          if (!master) continue;
          const sp = split(t);
          const { error } = await sb.from("trainers").insert({ id, position: i, owner_id: null, master_data: sp.m, player_data: sp.p });
          if (error) throw error;
          last.tr[id] = c;
          continue;
        }
        const own = master || t._o === uid;
        const md = master ? diff(l.m, c.m) : {}, pd = own ? diff(l.p, c.p) : {};
        if (empty(md) && empty(pd)) continue;
        const { error } = await sb.rpc("patch_trainer", { p_id: id, p_master: md, p_player: pd });
        if (error) {
          if (error.code === "42501") { needPull = true; last.tr[id] = c; continue; }
          throw error;
        }
        if (master) l.m = c.m;
        if (own) l.p = c.p;
      }
      for (const id of Object.keys(last.tr)) {
        if (cur.tr[id]) continue;
        if (master) {
          const { error } = await sb.from("trainers").delete().eq("id", id);
          if (error) throw error;
        } else needPull = true;
        delete last.tr[id];
      }

      // Pokédex: il master tutto, il giocatore solo i campi consentiti dei Pokémon della propria squadra
      {
        const mine = master ? null : myTeamNs();
        const ns = new Set([...Object.keys(cur.ov), ...Object.keys(last.ov)]);
        for (const n of ns) {
          if (!master && !mine.has(String(n))) continue;
          const c = cur.ov[n] || {}, l = last.ov[n] || {};
          let d = diff(l, c);
          if (!master) { const f = {}; for (const k in d) if (PK_KEYS.test(k)) f[k] = d[k]; d = f; }
          if (empty(d)) continue;
          const { error } = await sb.rpc("patch_pokemon", { p_n: +n, p_patch: d });
          if (error) {
            if (!master && error.code === "42501") { needPull = true; last.ov[n] = c; continue; }
            throw error;
          }
          if (master) last.ov[n] = c;
          else { const nl = { ...l }; for (const k in d) { if (d[k] === null) delete nl[k]; else nl[k] = c[k]; } last.ov[n] = nl; }
        }
      }
      // Mappa: solo master
      if (master) {
        const d = diff(last.map, cur.map);
        if (!empty(d)) {
          const { error } = await sb.rpc("patch_map", { p_patch: d });
          if (error) throw error;
          last.map = cur.map;
        }
      }
      try { persistLocal(); } catch (e) {}
    } catch (e) {
      err = e;
    }
    pushing = false;
    if (err) {
      console.error("push", err);
      setStatus("err");
      toast("Salvataggio non riuscito, riprovo…");
      clearTimeout(pushTimer);
      pushTimer = setTimeout(push, 5000);
      return;
    }
    if (needPull) { toast("Alcune modifiche non erano consentite e sono state annullate"); scheduleRefresh(); }
    if (dirty) { pushTimer = setTimeout(push, 50); return; }
    setStatus("ok");
    if (needRef) scheduleRefresh();
  }
  // salva la cache locale senza riattivare il push
  function persistLocal() { muted = true; try { persist(); } finally { muted = false; } }

  /* ---------- lettura (pull) ------------------------------------------ */
  async function fetchAll() {
    const [a, b, c] = await Promise.all([
      sb.from("trainers").select("id,position,owner_id,master_data,player_data,created_at").order("position").order("created_at"),
      sb.from("pokemon_state").select("n,data"),
      sb.from("map_state").select("data").eq("id", 1).maybeSingle(),
    ]);
    for (const r of [a, b, c]) if (r.error) throw r.error;
    return { tr: a.data || [], pk: b.data || [], map: (c.data && c.data.data) || {} };
  }

  async function pull(initial) {
    const R = await fetchAll();
    if (!initial && (pushTimer || pushing || dirty)) return false;

    // Database vuoto + master: propone di caricare i dati presenti su questo dispositivo
    if (initial && S.isMaster() && !R.tr.length && !R.pk.length) {
      if (confirm("Il database online è vuoto.\nCaricare i dati presenti su questo dispositivo (allenatori, Pokédex, mappa)?")) {
        last = { tr: {}, ov: {}, map: {} };
        dirty = true;
        await push();
        return true;
      }
    }

    const newTr = R.tr.map((r) => Object.assign({}, mkt(), r.master_data, r.player_data, { _id: r.id, _o: r.owner_id }));
    const newOv = {};
    R.pk.forEach((r) => { newOv[r.n] = r.data || {}; delete newOv[r.n].MosseL; });
    const newMap = Object.assign({ Immagine: "", sec: [] }, R.map);

    const same = deq(norm([DB.tr, DB.ov, DB.map]), norm([newTr, newOv, newMap]));
    if (!same) {
      muted = true;
      try {
        DB.tr = newTr; DB.ov = newOv; DB.map = newMap;
        reapplyAll();
        persist();
      } finally { muted = false; }
      if (V.id != null && V.v === "allenatori" && !DB.tr[V.id]) V = { v: "dashboard" };
    }
    last = snapAll();
    return !same;
  }

  /* ---------- aggiornamenti in tempo reale ----------------------------- */
  function busy() {
    try {
      if (typeof EDIT !== "undefined" && EDIT) return true;
      if (typeof SNAP !== "undefined" && SNAP) return true;
    } catch (e) {}
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== "checkbox" && a.type !== "file") return true;
    if (document.querySelector(".ovl,.zv")) return true;
    return false;
  }
  function scheduleRefresh() {
    if (!profile) return;
    needRef = true;
    clearTimeout(refTimer);
    refTimer = setTimeout(tryRefresh, 250);
  }
  async function tryRefresh() {
    if (!needRef || !profile) return;
    if (busy() || pushing || pushTimer) { refTimer = setTimeout(tryRefresh, 1200); return; }
    needRef = false;
    try {
      const ch = await pull(false);
      setStatus("ok");
      if (ch) { const y = window.scrollY; draw(); window.scrollTo(0, y); }
    } catch (e) {
      console.error("refresh", e);
      setStatus("err");
      needRef = true;
      refTimer = setTimeout(tryRefresh, 8000);
    }
  }
  function subscribe() {
    if (chan) { try { sb.removeChannel(chan); } catch (e) {} }
    chan = sb.channel("lentinia-live");
    ["trainers", "pokemon_state", "map_state"].forEach((table) =>
      chan.on("postgres_changes", { event: "*", schema: "public", table }, scheduleRefresh));
    chan.subscribe((st) => {
      if (st === "SUBSCRIBED") { setStatus("ok"); scheduleRefresh(); }
      else if (st === "CHANNEL_ERROR" || st === "TIMED_OUT" || st === "CLOSED") setStatus("err");
    });
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (!document.hidden) scheduleRefresh(); }, 30000);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleRefresh(); });
  window.addEventListener("online", scheduleRefresh);
  document.addEventListener("focusout", () => setTimeout(() => { if (needRef) tryRefresh(); }, 50));

  /* ---------- scheda di un altro giocatore: sola lettura --------------- */
  S.afterDraw = function () {
    if (S.local || !profile) return;
    if (V.v === "allenatori" && V.id != null) {
      const t = DB.tr[V.id];
      const app = document.getElementById("app");
      if (t && !DB.master && t._o !== profile.id) {
        let past = false;
        [...app.children].forEach((k) => {
          if (k.classList.contains("bar")) {
            past = true;
            const eb = k.querySelector("[data-edit]"); if (eb) eb.style.display = "none";
            const cb = k.querySelector("[data-cancel]"); if (cb) cb.style.display = "none";
            return;
          }
          if (past) k.setAttribute("inert", "");
        });
        const bar = app.querySelector(".bar");
        if (bar && !app.querySelector("#rolbl")) {
          const p = document.createElement("p");
          p.id = "rolbl"; p.className = "mu"; p.style.cssText = "text-align:center;margin:6px 0";
          p.textContent = "Scheda di sola lettura";
          bar.after(p);
        }
      }
    }
  };

  /* ---------- importazione backup (master) ----------------------------- */
  S.importAll = function (o) {
    const old = DB.tr;
    DB.tr = o.tr.map((s, i) => Object.assign({}, mkt(), s, { _id: old[i] && old[i]._id, _o: old[i] ? old[i]._o : null }));
    DB.ov = o.ov || {};
    Object.values(DB.ov).forEach((x) => delete x.MosseL);
    DB.map = Object.assign({ Immagine: "", sec: [] }, o.map || {});
    reapplyAll();
    persist();
    draw();
  };

  /* ---------- gestione account (master) -------------------------------- */
  async function invoke(body) {
    const { data, error } = await sb.functions.invoke("manage-players", { body });
    if (error) {
      let msg = error.message;
      try { const b = await error.context.json(); if (b && b.error) msg = b.error; } catch (e) {}
      throw new Error(msg);
    }
    if (data && data.error) throw new Error(data.error);
    return data;
  }
  async function accounts() {
    const m = modal(mhead("Account giocatori") + '<div id="acl" class="mu">Carico…</div><p id="acm" style="color:#FB1B1B;margin:8px 0 0"></p>');
    const box = m.querySelector("#acl"), msg = m.querySelector("#acm");
    const trOpts = (sel) => '<option value="">— nessuna scheda —</option>' +
      DB.tr.map((t) => `<option value="${t._id}" ${t._id === sel ? "selected" : ""}>${esc(t.Nome || "Allenatore")}</option>`).join("");
    const inp = "border:1.5px solid #1C1C1C;border-radius:999px;padding:8px 14px;font:inherit;background:#fff;color:#1C1C1C;min-width:0;";
    async function render() {
      const { data: ps, error } = await sb.from("profiles").select("id,username,role").order("username");
      if (error) { box.textContent = "Errore: " + error.message; return; }
      box.className = "";
      box.innerHTML =
        ps.map((p) => {
          const owned = DB.tr.find((t) => t._o === p.id);
          return `<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0"><b style="flex:1 1 100px">${esc(p.username)}${p.role === "master" ? " (master)" : ""}</b>` +
            (p.role === "master" ? "" :
              `<select data-as="${p.id}" style="${inp}flex:1 1 140px">${trOpts(owned && owned._id)}</select>` +
              `<button data-pw="${p.id}">Password</button><button data-del="${p.id}" data-un="${esc(p.username)}">Elimina</button>`) + "</div>";
        }).join("") +
        `<hr style="border:0;border-top:1px solid #ddd;margin:14px 0"><b>Nuovo giocatore</b>` +
        `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">` +
        `<input id="nu" placeholder="nome utente" autocapitalize="none" style="${inp}flex:1 1 120px">` +
        `<input id="np" placeholder="password (min. 6)" style="${inp}flex:1 1 120px">` +
        `<select id="nt" style="${inp}flex:1 1 140px">${trOpts("")}</select>` +
        `<button class="p" id="nc">Crea</button></div>`;
    }
    await render();
    const run = async (fn) => {
      msg.textContent = "";
      try { await fn(); await render(); scheduleRefresh(); }
      catch (e) { msg.textContent = e.message || String(e); }
    };
    m.addEventListener("change", (e) => {
      const s = e.target.closest("[data-as]"); if (!s) return;
      run(async () => {
        const uid = s.dataset.as;
        let r = await sb.from("trainers").update({ owner_id: null }).eq("owner_id", uid); if (r.error) throw r.error;
        if (s.value) { r = await sb.from("trainers").update({ owner_id: uid }).eq("id", s.value); if (r.error) throw r.error; }
        DB.tr.forEach((t) => { if (t._o === uid) t._o = null; });
        const t = DB.tr.find((x) => x._id === s.value); if (t) t._o = uid;
      });
    });
    m.addEventListener("click", (e) => {
      const pw = e.target.closest("[data-pw]"), del = e.target.closest("[data-del]"), nc = e.target.closest("#nc");
      if (pw) {
        const np = prompt("Nuova password (min. 6 caratteri):");
        if (np) run(() => invoke({ action: "set_password", user_id: pw.dataset.pw, password: np }));
      } else if (del) {
        if (confirm("Eliminare l’account “" + del.dataset.un + "”? La sua scheda resta, ma senza proprietario."))
          run(() => invoke({ action: "delete", user_id: del.dataset.del }));
      } else if (nc) {
        run(() => invoke({
          action: "create",
          username: m.querySelector("#nu").value,
          password: m.querySelector("#np").value,
          trainer_id: m.querySelector("#nt").value || null,
        }));
      }
    });
  }


  /* ---------- installazione come app (manifest) ------------------------ */
  let manifestUrl = null;
  function installManifest() {
    const u = new URL("icon.png", location.href).href;
    const man = { name: "Pokédex Lentinia", short_name: "Lentinia", start_url: location.href.split("#")[0], display: "standalone", background_color: "#FFFFFF", theme_color: "#FB1B1B", icons: [{ src: u, sizes: "512x512", type: "image/png", purpose: "any" }] };
    if (manifestUrl) URL.revokeObjectURL(manifestUrl);
    manifestUrl = URL.createObjectURL(new Blob([JSON.stringify(man)], { type: "application/manifest+json" }));
    let l = document.querySelector('link[rel="manifest"]');
    if (!l) { l = document.createElement("link"); l.rel = "manifest"; document.head.appendChild(l); }
    l.href = manifestUrl;
  }

  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-logout]")) S.logout();
    else if (e.target.closest("[data-accounts]")) accounts();
  });
})();
