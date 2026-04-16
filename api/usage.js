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
  console.log(SERVER_VERSION + " usage handler: " + (req.method || "?") + " " + (req.url || ""));
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { matter_id } = req.query;

  try {
    if (matter_id) {
      // Usage for a specific matter
      const { data, error } = await supabase
        .from("usage_log")
        .select("tool_name, input_tokens, output_tokens, cost_usd, created_at")
        .eq("matter_id", matter_id)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      if (error) throw error;

      const total = (data || []).reduce((acc, r) => ({
        inputTokens:  acc.inputTokens  + (r.input_tokens  || 0),
        outputTokens: acc.outputTokens + (r.output_tokens || 0),
        costUsd:      acc.costUsd      + (r.cost_usd      || 0),
      }), { inputTokens: 0, outputTokens: 0, costUsd: 0 });

      return res.status(200).json({ usage: data || [], total });
    } else {
      // Usage summary across all matters owned by this user
      const { data: matters } = await supabase
        .from("matters")
        .select("id, name")
        .eq("owner_id", user.id);

      const matterIds = (matters || []).map(m => m.id);
      if (matterIds.length === 0) return res.status(200).json({ summary: [] });

      const { data, error } = await supabase
        .from("usage_log")
        .select("matter_id, tool_name, input_tokens, output_tokens, cost_usd")
        .in("matter_id", matterIds)
        .eq("user_id", user.id);
      if (error) throw error;

      const byMatter = {};
      for (const m of matters) byMatter[m.id] = { matterId: m.id, matterName: m.name, inputTokens: 0, outputTokens: 0, costUsd: 0, runs: 0 };
      for (const r of (data || [])) {
        if (byMatter[r.matter_id]) {
          byMatter[r.matter_id].inputTokens  += r.input_tokens  || 0;
          byMatter[r.matter_id].outputTokens += r.output_tokens || 0;
          byMatter[r.matter_id].costUsd      += r.cost_usd      || 0;
          byMatter[r.matter_id].runs++;
        }
      }

      const summary = Object.values(byMatter).sort((a, b) => b.costUsd - a.costUsd);
      return res.status(200).json({ summary });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
