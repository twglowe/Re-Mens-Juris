import { createClient } from "@supabase/supabase-js";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function getUser(req) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  return error ? null : user;
}

const SERVER_VERSION = "v5.5";
export default async function handler(req, res) {
  console.log(SERVER_VERSION + " drafts handler: " + (req.method || "?") + " " + (req.url || ""));
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  try {
    if (req.method === "GET") {
      const { matter_id } = req.query;
      if (!matter_id) return res.status(400).json({ error: "matter_id required" });
      const { data, error } = await supabase.from("drafts")
        .select("*")
        .eq("matter_id", matter_id)
        .eq("owner_id", user.id)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return res.status(200).json({ drafts: data || [] });
    }

    if (req.method === "POST") {
      const { matter_id, case_type_id, subcat_id, doc_type_id, heading_data, instructions, draft_content, conversation } = req.body;
      if (!matter_id) return res.status(400).json({ error: "matter_id required" });
      const { data, error } = await supabase.from("drafts")
        .insert({
          matter_id,
          owner_id: user.id,
          case_type_id: case_type_id || null,
          subcat_id: subcat_id || null,
          doc_type_id: doc_type_id || null,
          heading_data: heading_data || {},
          instructions: instructions || "",
          draft_content: draft_content || "",
          conversation: conversation || []
        })
        .select().single();
      if (error) throw error;
      return res.status(201).json({ draft: data });
    }

    if (req.method === "PUT") {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: "id required" });
      const body = req.body;
      const updates = { updated_at: new Date().toISOString() };
      const fields = ["heading_data", "instructions", "draft_content", "conversation", "case_type_id", "subcat_id", "doc_type_id"];
      for (const f of fields) {
        if (body[f] !== undefined) updates[f] = body[f];
      }
      const { error } = await supabase.from("drafts").update(updates).eq("id", id).eq("owner_id", user.id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    if (req.method === "DELETE") {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: "id required" });
      const { error } = await supabase.from("drafts").delete().eq("id", id).eq("owner_id", user.id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
