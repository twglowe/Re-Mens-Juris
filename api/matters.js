import { createClient } from "@supabase/supabase-js";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function getUser(req) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  return error ? null : user;
}

export default async function handler(req, res) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  try {
    if (req.method === "GET") {
      const { data: own } = await supabase.from("matters").select("*").eq("owner_id", user.id).order("created_at", { ascending: false });
      const { data: shares } = await supabase.from("matter_shares").select("matter_id, permission, matters(*)").eq("user_id", user.id);
      const shared = (shares || []).map(s => ({ ...s.matters, shared: true, permission: s.permission }));
      return res.status(200).json({ matters: [...(own || []), ...shared] });
    }

    if (req.method === "POST") {
      const { name, jurisdiction, nature, issues } = req.body;
      if (!name) return res.status(400).json({ error: "Name required" });
      const { data, error } = await supabase.from("matters")
        .insert({ name, jurisdiction: jurisdiction || "Bermuda", owner_id: user.id, document_count: 0, nature: nature || "", issues: issues || "" })
        .select().single();
      if (error) throw error;
      return res.status(201).json({ matter: data });
    }

    if (req.method === "PATCH") {
      const { id } = req.query;
      const { nature, issues, name } = req.body;
      const { data: matter } = await supabase.from("matters").select("owner_id").eq("id", id).single();
      if (!matter || matter.owner_id !== user.id) return res.status(403).json({ error: "Only the owner can edit this matter" });
      const updates = {};
      if (nature !== undefined) updates.nature = nature;
      if (issues !== undefined) updates.issues = issues;
      if (name !== undefined) updates.name = name;
      const { error } = await supabase.from("matters").update(updates).eq("id", id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    if (req.method === "DELETE") {
      const { id } = req.query;
      const { data: matter } = await supabase.from("matters").select("owner_id").eq("id", id).single();
      if (!matter || matter.owner_id !== user.id) return res.status(403).json({ error: "Only the owner can delete this matter" });
      await supabase.from("matter_shares").delete().eq("matter_id", id);
      await supabase.from("conversation_history").delete().eq("matter_id", id);
      await supabase.from("chunks").delete().eq("matter_id", id);
      await supabase.from("documents").delete().eq("matter_id", id);
      const { error } = await supabase.from("matters").delete().eq("id", id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
