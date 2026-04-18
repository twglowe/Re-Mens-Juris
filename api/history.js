import { createClient } from "@supabase/supabase-js";

async function getUser(supabase, req) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  return error ? null : user;
}

async function canAccess(supabase, userId, matterId) {
  const { data: own } = await supabase.from("matters").select("id").eq("id", matterId).eq("owner_id", userId).single();
  if (own) return true;
  const { data: share } = await supabase.from("matter_shares").select("id").eq("matter_id", matterId).eq("user_id", userId).single();
  return !!share;
}

const SERVER_VERSION = "v5.6d";
export default async function handler(req, res) {
  console.log(SERVER_VERSION + " history handler: " + (req.method || "?") + " " + (req.url || ""));
  /* v5.6d: createClient() moved inside handler — module-scope instantiation
     caches the PostgREST schema and silently drops any columns added after
     the function first warmed up. Same bug class that broke /api/analyse. */
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const user = await getUser(supabase, req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  try {
    /* GET — load history for a matter (includes followups column). */
    if (req.method === "GET") {
      const { matter_id } = req.query;
      const access = await canAccess(supabase, user.id, matter_id);
      if (!access) return res.status(403).json({ error: "Access denied" });
      const { data, error } = await supabase.from("conversation_history")
        .select("*").eq("matter_id", matter_id).eq("user_id", user.id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return res.status(200).json({ history: data || [] });
    }

    /* POST — save a new main tool run (or chat Q/A). Prune rule: keep last 2
       rows per tool per matter, BUT only rows with an empty followups array
       count toward the cap. Rows that have follow-ups are preserved until the
       user deletes them manually. (v5.6d Option B.) */
    if (req.method === "POST") {
      const { matter_id, question, answer, tool_name } = req.body;
      const access = await canAccess(supabase, user.id, matter_id);
      if (!access) return res.status(403).json({ error: "Access denied" });
      const { data, error } = await supabase.from("conversation_history")
        .insert({ matter_id, user_id: user.id, question, answer, tool_name: tool_name || null })
        .select("id").single();
      if (error) throw error;
      if (tool_name) {
        const { data: all } = await supabase.from("conversation_history")
          .select("id, created_at, followups")
          .eq("matter_id", matter_id)
          .eq("user_id", user.id)
          .eq("tool_name", tool_name)
          .order("created_at", { ascending: false });
        if (all) {
          /* Only prune rows that have no follow-ups attached. */
          const prunable = all.filter(function(r){
            return !r.followups || r.followups.length === 0;
          });
          if (prunable.length > 2) {
            const toDelete = prunable.slice(2).map(function(r){ return r.id; });
            await supabase.from("conversation_history").delete().in("id", toDelete);
          }
        }
      }
      return res.status(201).json({ success: true, id: data?.id || null });
    }

    /* PATCH — append a follow-up Q/A to an existing row's followups array.
       Body: { id, followup: { question, answer, created_at? } }
       (id may also come from the query string.) */
    if (req.method === "PATCH") {
      const id = req.query.id || (req.body && req.body.id);
      const followup = req.body && req.body.followup;
      if (!id) return res.status(400).json({ error: "id required" });
      if (!followup || typeof followup.question !== "string" || typeof followup.answer !== "string") {
        return res.status(400).json({ error: "followup.question and followup.answer required" });
      }
      /* Ownership check */
      const { data: row, error: rowErr } = await supabase.from("conversation_history")
        .select("id, user_id, followups").eq("id", id).single();
      if (rowErr || !row) return res.status(404).json({ error: "Not found" });
      if (row.user_id !== user.id) return res.status(403).json({ error: "Forbidden" });
      const existing = Array.isArray(row.followups) ? row.followups : [];
      const entry = {
        question: followup.question,
        answer: followup.answer,
        created_at: followup.created_at || new Date().toISOString()
      };
      const updated = existing.concat([entry]);
      const { error: updErr } = await supabase.from("conversation_history")
        .update({ followups: updated }).eq("id", id);
      if (updErr) throw updErr;
      return res.status(200).json({ success: true, followup_count: updated.length });
    }

    /* DELETE — remove a single row by id, or all rows for a matter. */
    if (req.method === "DELETE") {
      const { id, matter_id } = req.query;

      if (id) {
        const { data: item } = await supabase.from("conversation_history")
          .select("matter_id, user_id").eq("id", id).single();
        if (!item) return res.status(404).json({ error: "Not found" });
        if (item.user_id !== user.id) return res.status(403).json({ error: "Forbidden" });
        await supabase.from("conversation_history").delete().eq("id", id);
        return res.status(200).json({ success: true });
      }

      if (matter_id) {
        await supabase.from("conversation_history")
          .delete().eq("matter_id", matter_id).eq("user_id", user.id);
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ error: "id or matter_id required" });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
