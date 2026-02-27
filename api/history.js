import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function getUser(req) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  return error ? null : user;
}

async function canAccess(userId, matterId) {
  const { data: own } = await supabase.from("matters").select("id").eq("id", matterId).eq("owner_id", userId).single();
  if (own) return true;
  const { data: share } = await supabase.from("matter_shares").select("id").eq("matter_id", matterId).eq("user_id", userId).single();
  return !!share;
}

export default async function handler(req, res) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  try {
    // GET — load history for a matter
    if (req.method === "GET") {
      const { matter_id } = req.query;
      const access = await canAccess(user.id, matter_id);
      if (!access) return res.status(403).json({ error: "Access denied" });
      const { data, error } = await supabase.from("conversation_history")
        .select("*").eq("matter_id", matter_id).eq("user_id", user.id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return res.status(200).json({ history: data || [] });
    }

    // POST — save a message pair (question + answer)
    if (req.method === "POST") {
      const { matter_id, question, answer, tool_name } = req.body;
      const access = await canAccess(user.id, matter_id);
      if (!access) return res.status(403).json({ error: "Access denied" });
      const { error } = await supabase.from("conversation_history").insert({
        matter_id, user_id: user.id, question, answer, tool_name: tool_name || null
      });
      if (error) throw error;
      return res.status(201).json({ success: true });
    }

    // DELETE — clear history for a matter
    if (req.method === "DELETE") {
      const { matter_id } = req.query;
      const { error } = await supabase.from("conversation_history")
        .delete().eq("matter_id", matter_id).eq("user_id", user.id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
