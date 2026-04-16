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
  console.log(SERVER_VERSION + " sharing handler: " + (req.method || "?") + " " + (req.url || ""));
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  try {
    // GET shares for a matter
    if (req.method === "GET") {
      const { matter_id } = req.query;
      const { data, error } = await supabase.from("matter_shares")
        .select("id, user_id, permission, created_at")
        .eq("matter_id", matter_id);
      if (error) throw error;

      // Enrich with user emails
      const enriched = await Promise.all((data || []).map(async (share) => {
        const { data: { user: sharedUser } } = await supabase.auth.admin.getUserById(share.user_id);
        return {
          ...share,
          email: sharedUser?.email || "Unknown",
          name: sharedUser?.user_metadata?.name || sharedUser?.email || "Unknown"
        };
      }));

      return res.status(200).json({ shares: enriched });
    }

    // SHARE a matter
    if (req.method === "POST") {
      const { matter_id, user_id, permission } = req.body;
      if (!matter_id || !user_id) return res.status(400).json({ error: "matter_id and user_id required" });

      // Verify requester owns this matter
      const { data: matter } = await supabase.from("matters").select("owner_id, name").eq("id", matter_id).single();
      if (!matter || matter.owner_id !== user.id) return res.status(403).json({ error: "Only the owner can share this matter" });

      // Cannot share with yourself
      if (user_id === user.id) return res.status(400).json({ error: "Cannot share with yourself" });

      // Verify target user exists
      const { data: { user: targetUser }, error: findError } = await supabase.auth.admin.getUserById(user_id);
      if (findError || !targetUser) return res.status(404).json({ error: "User not found" });

      // Upsert share
      const { error } = await supabase.from("matter_shares").upsert({
        matter_id, user_id, permission: permission || "read"
      }, { onConflict: "matter_id,user_id" });
      if (error) throw error;

      return res.status(200).json({ success: true, sharedWith: targetUser.email });
    }

    // REMOVE a share
    if (req.method === "DELETE") {
      const { matter_id, user_id } = req.body;
      if (!matter_id || !user_id) return res.status(400).json({ error: "matter_id and user_id required" });

      // Verify ownership
      const { data: matter } = await supabase.from("matters").select("owner_id").eq("id", matter_id).single();
      if (!matter || matter.owner_id !== user.id) return res.status(403).json({ error: "Only the owner can remove sharing" });

      const { error } = await supabase.from("matter_shares").delete()
        .eq("matter_id", matter_id)
        .eq("user_id", user_id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
