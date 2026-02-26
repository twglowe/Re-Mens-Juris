import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

export const config = { maxDuration: 120 };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function getUser(req) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  return error ? null : user;
}

async function searchChunks(matterId, query, limit = 25) {
  const keywords = query.split(/\s+/).filter(w => w.length > 3).slice(0, 10).join(" | ");
  if (!keywords) {
    const { data } = await supabase.from("chunks").select("content, document_name, doc_type").eq("matter_id", matterId).limit(limit);
    return data || [];
  }
  const { data, error } = await supabase.from("chunks").select("content, document_name, doc_type")
    .eq("matter_id", matterId)
    .textSearch("content", keywords, { type: "plain", config: "english" })
    .limit(limit);
  if (error || !data?.length) {
    const { data: fallback } = await supabase.from("chunks").select("content, document_name, doc_type").eq("matter_id", matterId).limit(limit);
    return fallback || [];
  }
  return data;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { matterId, matterName, messages, jurisdiction, queryType, focusAreas } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: "Invalid request" });

  try {
    const latest = messages[messages.length - 1];
    const userQuery = typeof latest.content === "string" ? latest.content : latest.content?.find?.(c => c.type === "text")?.text || "";

    let contextText = "";
    if (matterId) {
      const chunks = await searchChunks(matterId, userQuery);
      if (chunks.length > 0) {
        const byDoc = {};
        for (const c of chunks) {
          if (!byDoc[c.document_name]) byDoc[c.document_name] = { type: c.doc_type, passages: [] };
          byDoc[c.document_name].passages.push(c.content);
        }
        contextText = "RELEVANT PASSAGES FROM MATTER DOCUMENTS:\n\n";
        for (const [name, d] of Object.entries(byDoc)) {
          contextText += `--- ${name} [${d.type}] ---\n${d.passages.join("\n\n")}\n\n`;
        }
      }
    }

    const system = `You are a senior litigation counsel specialising in ${jurisdiction || "Bermuda"} offshore common law litigation. You have deep expertise in Bermuda, Cayman Islands and BVI law, court rules (RSC Bermuda, GCR Cayman, CPR BVI), statutes, company law, trust law, insolvency, and English common law precedent as applied offshore.

Matter: "${matterName || "Current Matter"}"

${contextText ? `The following passages are retrieved from the matter documents as most relevant to this question. Refer to them specifically, quoting where helpful:\n\n${contextText}` : "No documents uploaded yet. Answer based on your legal knowledge."}

In every response:
1. Apply ${jurisdiction || "Bermuda"}-specific law — cite local statutes, court rules, and leading authority by name
2. Refer to document passages specifically, identifying which document they come from
3. Flag where ${jurisdiction || "Bermuda"} law diverges from English law or other offshore jurisdictions
4. Be precise — identify unsettled points and flag litigation risk
5. Address these focus areas: ${focusAreas?.join(", ") || "all relevant issues"}
6. Use clear ## headings. Do not truncate your response.
Analysis type: ${queryType || "General Legal Analysis"}
End with: ⚠️ Professional Caution: AI-generated analysis. Verify against current primary sources before reliance.`;

    const cleanMessages = messages.map(m => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter(c => c.type === "text").map(c => c.text).join("\n") : String(m.content)
    }));

    const response = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-opus-4-5",
      max_tokens: 8192,
      system,
      messages: cleanMessages,
    });

    return res.status(200).json({ result: response.content?.find(b => b.type === "text")?.text || "" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
