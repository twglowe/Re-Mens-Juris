import { createClient } from "@supabase/supabase-js";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function getUser(req) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  return error ? null : user;
}

const SERVER_VERSION = "v5.16a";

/* Default titles seeded only when the user has zero rows. The user can then
   add to / delete from this list freely. Stored in the table once seeded so
   later deletions stick. */
const DEFAULT_TITLES = [
  "WRIT OF SUMMONS",
  "CLAIM FORM",
  "STATEMENT OF CLAIM",
  "DEFENCE",
  "REPLY",
  "COUNTERCLAIM",
  "PARTICULARS OF CLAIM",
  "PETITION",
  "AFFIDAVIT",
  "WITNESS STATEMENT",
  "SKELETON ARGUMENT",
  "WRITTEN SUBMISSIONS",
  "NOTICE OF APPEAL",
  "SUMMONS",
  "ORIGINATING SUMMONS"
];

export default async function handler(req, res) {
  console.log(SERVER_VERSION + " draft_doc_titles handler: " + (req.method || "?") + " " + (req.url || ""));
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  try {
    if (req.method === "GET") {
      let { data, error } = await supabase.from("draft_doc_titles")
        .select("*")
        .eq("owner_id", user.id)
        .order("created_at", { ascending: true });
      if (error) throw error;

      /* First-load seed: if the user has no rows, insert the defaults so they
         appear in the dropdown and can be individually deleted later. The
         table's UNIQUE (owner_id, name) constraint protects against double
         seeding under concurrent first-loads. */
      if (!data || data.length === 0) {
        const rows = DEFAULT_TITLES.map(name => ({ owner_id: user.id, name }));
        const { data: seeded, error: seedErr } = await supabase
          .from("draft_doc_titles")
          .insert(rows)
          .select();
        if (seedErr) {
          /* Race condition with another concurrent first-load \u2014 just re-fetch. */
          const { data: after, error: afterErr } = await supabase.from("draft_doc_titles")
            .select("*").eq("owner_id", user.id).order("created_at", { ascending: true });
          if (afterErr) throw afterErr;
          data = after || [];
        } else {
          data = seeded || [];
        }
      }
      return res.status(200).json({ titles: data });
    }

    if (req.method === "POST") {
      const { name } = req.body || {};
      if (!name || typeof name !== "string") return res.status(400).json({ error: "name required" });
      const trimmed = name.trim();
      if (!trimmed) return res.status(400).json({ error: "name required" });
      if (trimmed.length > 120) return res.status(400).json({ error: "name too long (max 120 chars)" });

      const { data, error } = await supabase.from("draft_doc_titles")
        .insert({ owner_id: user.id, name: trimmed })
        .select().single();
      if (error) {
        /* 23505 = unique_violation */
        if (error.code === "23505") return res.status(409).json({ error: "That title already exists" });
        throw error;
      }
      return res.status(201).json({ title: data });
    }

    if (req.method === "DELETE") {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: "id required" });
      const { error } = await supabase.from("draft_doc_titles")
        .delete()
        .eq("id", id)
        .eq("owner_id", user.id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
