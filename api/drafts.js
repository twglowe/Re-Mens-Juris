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

  if (req.method === "GET") {
    const { matter_id } = req.query;
    if (!matter_id) return res.status(400).json({ error: "matter_id required" });
    const { data, error } = await supabase.from("drafts")
      .select("*").eq("matter_id", matter_id).eq("owner_id", user.id)
      .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ drafts: data });
  }

  if (req.method === "POST") {
    const { matter_id, title, document_type, court, action_no, plaintiff,
            defendant, firm, counsel_for, content } = req.body;
    if (!matter_id || !content) return res.status(400).json({ error: "matter_id and content required" });
    const { data, error } = await supabase.from("drafts").insert({
      matter_id, owner_id: user.id, title: title || "Untitled",
      document_type, court, action_no, plaintiff, defendant, firm, counsel_for, content
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ draft: data });
  }

  if (req.method === "DELETE") {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "id required" });
    const { error } = await supabase.from("drafts").delete().eq("id", id).eq("owner_id", user.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
