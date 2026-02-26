import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  const { action } = req.query;

  try {
    // LOGIN
    if (action === "login" && req.method === "POST") {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: "Email and password required" });

      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return res.status(401).json({ error: "Invalid email or password" });

      return res.status(200).json({
        token: data.session.access_token,
        user: { id: data.user.id, email: data.user.email, name: data.user.user_metadata?.name || data.user.email }
      });
    }

    // VERIFY TOKEN
    if (action === "verify" && req.method === "POST") {
      const token = req.headers.authorization?.replace("Bearer ", "");
      if (!token) return res.status(401).json({ error: "No token" });

      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data.user) return res.status(401).json({ error: "Invalid token" });

      return res.status(200).json({
        user: { id: data.user.id, email: data.user.email, name: data.user.user_metadata?.name || data.user.email }
      });
    }

    // LIST USERS (for sharing — admin only)
    if (action === "users" && req.method === "GET") {
      const token = req.headers.authorization?.replace("Bearer ", "");
      if (!token) return res.status(401).json({ error: "Unauthorized" });

      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error || !user) return res.status(401).json({ error: "Unauthorized" });

      const { data: users, error: usersError } = await supabase.auth.admin.listUsers();
      if (usersError) throw usersError;

      const filtered = users.users
        .filter(u => u.id !== user.id)
        .map(u => ({ id: u.id, email: u.email, name: u.user_metadata?.name || u.email }));

      return res.status(200).json({ users: filtered });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error("Auth error:", err);
    return res.status(500).json({ error: err.message });
  }
}
