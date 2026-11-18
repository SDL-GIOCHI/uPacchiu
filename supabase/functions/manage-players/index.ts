// Edge Function: gestione account giocatori. Solo il master può chiamarla.
// Usa la service_role key (disponibile solo lato server, MAI nel client).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const EMAIL_DOMAIN = Deno.env.get("EMAIL_DOMAIN") ?? "lentinia.app";
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Metodo non consentito" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 1) chi sta chiamando?
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Non autenticato" }, 401);

    // 2) è master?
    const admin = createClient(url, service, { auth: { persistSession: false } });
    const { data: me } = await admin.from("profiles").select("role").eq("id", user.id).single();
    if (!me || me.role !== "master") return json({ error: "Solo il master può farlo" }, 403);

    const body = await req.json();
    const action = String(body.action ?? "");

    if (action === "create") {
      const username = String(body.username ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      if (!USERNAME_RE.test(username)) {
        return json({ error: "Nome utente: 3-32 caratteri tra lettere minuscole, numeri, . _ -" }, 400);
      }
      if (password.length < 6) return json({ error: "La password deve avere almeno 6 caratteri" }, 400);

      const { data, error } = await admin.auth.admin.createUser({
        email: `${username}@${EMAIL_DOMAIN}`,
        password,
        email_confirm: true,
        user_metadata: { username },
      });
      if (error) return json({ error: error.message }, 400);

      if (body.trainer_id) {
        const { error: e2 } = await admin.from("trainers").update({ owner_id: data.user.id }).eq("id", body.trainer_id);
        if (e2) return json({ error: "Account creato ma assegnazione fallita: " + e2.message }, 400);
      }
      return json({ ok: true, id: data.user.id });
    }

    if (action === "set_password") {
      const password = String(body.password ?? "");
      if (password.length < 6) return json({ error: "La password deve avere almeno 6 caratteri" }, 400);
      const { error } = await admin.auth.admin.updateUserById(String(body.user_id), { password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "delete") {
      if (body.user_id === user.id) return json({ error: "Non puoi eliminare il tuo account" }, 400);
      const { error } = await admin.auth.admin.deleteUser(String(body.user_id));
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "Azione sconosciuta" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
