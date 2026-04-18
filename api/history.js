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

const SERVER_VERSION = "v5.5";
export default async function handler(req, res) {
  console.log(SERVER_VERSION + " history handler: " + (req.method || "?") + " " + (req.url || ""));
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

    // POST — save a message pair, keep max 2 per tool per matter
    if (req.method === "POST") {
      const { matter_id, question, answer, tool_name } = req.body;
      const access = await canAccess(user.id, matter_id);
      if (!access) return res.status(403).json({ error: "Access denied" });
      const { data, error } = await supabase.from("conversation_history")
        .insert({ matter_id, user_id: user.id, question, answer, tool_name: tool_name || null })
        .select("id").single();
      if (error) throw error;
      // Keep only 2 most recent records per tool per matter
      if (tool_name) {
        const { data: all } = await supabase.from("conversation_history")
          .select("id, created_at")
          .eq("matter_id", matter_id)
          .eq("user_id", user.id)
          .eq("tool_name", tool_name)
          .order("created_at", { ascending: false });
        if (all && all.length > 2) {
          const toDelete = all.slice(2).map(r => r.id);
          await supabase.from("conversation_history").delete().in("id", toDelete);
        }
      }
      return res.status(201).json({ success: true, id: data?.id || null });
    }

    // DELETE — delete a single history item by id, or all for a matter
    if (req.method === "DELETE") {
      const { id, matter_id } = req.query;

      // Delete single item by id
      if (id) {
        const { data: item } = await supabase.from("conversation_history")
          .select("matter_id, user_id").eq("id", id).single();
        if (!item) return res.status(404).json({ error: "Not found" });
        if (item.user_id !== user.id) return res.status(403).json({ error: "Forbidden" });
        await supabase.from("conversation_history").delete().eq("id", id);
        return res.status(200).json({ success: true });
      }

      // Delete all for a matter
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
