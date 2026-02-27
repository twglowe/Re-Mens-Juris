import { createClient } from "@supabase/supabase-js";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function getUser(req) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  return error ? null : user;
}

async function canAccessMatter(userId, matterId) {
  const { data: own } = await supabase.from("matters").select("id").eq("id", matterId).eq("owner_id", userId).single();
  if (own) return { access: true, canEdit: true };
  const { data: share } = await supabase.from("matter_shares").select("permission").eq("matter_id", matterId).eq("user_id", userId).single();
  if (share) return { access: true, canEdit: share.permission === "edit" };
  return { access: false, canEdit: false };
}

export default async function handler(req, res) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  try {
    if (req.method === "GET") {
      const { matter_id } = req.query;
      const { access } = await canAccessMatter(user.id, matter_id);
      if (!access) return res.status(403).json({ error: "Access denied" });

      const { data, error } = await supabase.from("documents").select("*").eq("matter_id", matter_id).order("created_at", { ascending: false });
      if (error) throw error;
      return res.status(200).json({ documents: data });
    }

    if (req.method === "DELETE") {
      const { id } = req.query;
      const { data: doc } = await supabase.from("documents").select("matter_id").eq("id", id).single();
      if (!doc) return res.status(404).json({ error: "Document not found" });

      const { canEdit } = await canAccessMatter(user.id, doc.matter_id);
      if (!canEdit) return res.status(403).json({ error: "You do not have edit permission" });

      await supabase.from("chunks").delete().eq("document_id", id);
      await supabase.from("documents").delete().eq("id", id);
      const { count } = await supabase.from("documents").select("*", { count: "exact", head: true }).eq("matter_id", doc.matter_id);
      await supabase.from("matters").update({ document_count: count || 0 }).eq("id", doc.matter_id);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
