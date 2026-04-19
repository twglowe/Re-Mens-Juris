import { createClient } from "@supabase/supabase-js";

/* v5.6f — api/history.js
   Changes in this version:
   1. createClient() moved inside the handler. At module scope it caches the
      PostgREST schema on first warm, and any column added by a later
      migration (here: `followups jsonb`) gets silently stripped from
      UPDATE/PATCH payloads with no error. Same bug class that broke
      /api/analyse.js until v5.6a. Supabase is now threaded through
      getUser(supabase, req) and canAccess(supabase, userId, matterId).
   2. New PATCH /api/history?id=<rowId> endpoint. Appends a follow-up entry
      to the row's `followups` jsonb array. Read-modify-write. Body shape:
        { question, answer, cost_usd, focus_doc_names }
      Stored entry shape (added server-side):
        { question, answer, cost_usd, focus_doc_names, created_at }
      All fields except question+answer are optional on the request.
      focus_doc_names defaults to [] if absent (forward-compatible with
      Stage 2 per-follow-up document focus selector).
   3. POST prune rule changed (Option 1 from v5.6d handover, confirmed
      19 Apr 2026). When capping to 2 most-recent rows per tool per matter,
      rows with a non-empty `followups` array are SPARED from the prune
      and do not count toward the cap. Users never silently lose follow-up
      work; rows with follow-ups remain until deleted manually.
   4. GET unchanged. select("*") already returns the followups column.
   5. DELETE unchanged.
*/

async function getUser(supabase, req) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  return error ? null : user;
}

async function canAccess(supabase, userId, matterId) {
  const { data: own } = await supabase.from("matters")
    .select("id").eq("id", matterId).eq("owner_id", userId).single();
  if (own) return true;
  const { data: share } = await supabase.from("matter_shares")
    .select("id").eq("matter_id", matterId).eq("user_id", userId).single();
  return !!share;
}

const SERVER_VERSION = "v5.6f";
export default async function handler(req, res) {
  console.log(SERVER_VERSION + " history handler: " + (req.method || "?") + " " + (req.url || ""));

  /* Fresh client per invocation — see comment block at top of file. */
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const user = await getUser(supabase, req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  try {
    /* ─── GET — load history for a matter ──────────────────────────────── */
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

    /* ─── POST — save a new main tool run or chat Q/A ──────────────────── */
    if (req.method === "POST") {
      const { matter_id, question, answer, tool_name } = req.body;
      const access = await canAccess(supabase, user.id, matter_id);
      if (!access) return res.status(403).json({ error: "Access denied" });

      const { data, error } = await supabase.from("conversation_history")
        .insert({ matter_id, user_id: user.id, question, answer, tool_name: tool_name || null })
        .select("id").single();
      if (error) throw error;

      /* Prune rule (Option 1): keep 2 most recent rows per tool per matter,
         BUT only count rows with an empty followups[] toward the cap. Rows
         with follow-ups attached are preserved indefinitely (until the user
         deletes them manually). This protects iterative follow-up work from
         being silently lost when a newer tool run is issued. */
      if (tool_name) {
        const { data: all } = await supabase.from("conversation_history")
          .select("id, created_at, followups")
          .eq("matter_id", matter_id)
          .eq("user_id", user.id)
          .eq("tool_name", tool_name)
          .order("created_at", { ascending: false });
        if (all && all.length > 0) {
          /* Partition: rows with follow-ups are always kept. Rows without
             are subject to the cap-of-2. */
          const prunable = [];
          for (const r of all) {
            const hasFollowups = Array.isArray(r.followups) && r.followups.length > 0;
            if (!hasFollowups) prunable.push(r);
          }
          if (prunable.length > 2) {
            const toDelete = prunable.slice(2).map(r => r.id);
            if (toDelete.length > 0) {
              await supabase.from("conversation_history").delete().in("id", toDelete);
            }
          }
        }
      }

      return res.status(201).json({ success: true, id: data?.id || null });
    }

    /* ─── PATCH — append a follow-up entry to a row's followups[] ──────── */
    if (req.method === "PATCH") {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: "id required" });

      const { question, answer, cost_usd, focus_doc_names } = req.body || {};
      if (typeof question !== "string" || !question.trim()) {
        return res.status(400).json({ error: "question required" });
      }
      if (typeof answer !== "string" || !answer.trim()) {
        return res.status(400).json({ error: "answer required" });
      }

      /* Load target row. Verify ownership via user_id on the row, same as
         DELETE does. We do NOT use canAccess here because shared-matter
         users should not be allowed to mutate another user's history row. */
      const { data: row, error: loadErr } = await supabase.from("conversation_history")
        .select("id, user_id, matter_id, followups")
        .eq("id", id).single();
      if (loadErr || !row) return res.status(404).json({ error: "Not found" });
      if (row.user_id !== user.id) return res.status(403).json({ error: "Forbidden" });

      /* Read-modify-write. Default followups to [] if null/undefined —
         the column default is '[]'::jsonb so this should not happen in
         practice, but be defensive against hand-inserted rows. */
      const existing = Array.isArray(row.followups) ? row.followups : [];
      const entry = {
        question: question,
        answer: answer,
        cost_usd: (typeof cost_usd === "number" && isFinite(cost_usd)) ? cost_usd : 0,
        focus_doc_names: Array.isArray(focus_doc_names) ? focus_doc_names.filter(s => typeof s === "string") : [],
        created_at: new Date().toISOString(),
      };
      const updated = existing.concat([entry]);

      const { data: saved, error: updErr } = await supabase.from("conversation_history")
        .update({ followups: updated })
        .eq("id", id)
        .select("followups")
        .single();
      if (updErr) throw updErr;

      /* Defensive: if the schema cache silently stripped the column, the
         returned followups will not match what we wrote. Detect and fail
         loudly rather than report success on a silent drop. */
      const savedFollowups = Array.isArray(saved?.followups) ? saved.followups : [];
      if (savedFollowups.length !== updated.length) {
        console.error(SERVER_VERSION + " history PATCH: write-back mismatch — expected " + updated.length + " entries, got " + savedFollowups.length + ". Possible schema cache issue.");
        return res.status(500).json({ error: "Follow-up save verification failed" });
      }

      return res.status(200).json({
        success: true,
        followups_count: savedFollowups.length,
        followups: savedFollowups,
      });
    }

    /* ─── DELETE — delete a single history item, or all for a matter ───── */
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
    console.error(SERVER_VERSION + " history error:", err);
    return res.status(500).json({ error: err.message });
  }
}
