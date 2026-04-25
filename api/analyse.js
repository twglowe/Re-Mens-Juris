import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

export const config = { maxDuration: 300 };

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const INPUT_COST_PER_M  = 3.00;
const OUTPUT_COST_PER_M = 15.00;

async function getUser(supabase, req) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error) { console.error("Auth error:", error.message); return null; }
    return user;
  } catch (e) {
    console.error("Auth exception:", e.message);
    return null;
  }
}

// Extract core search terms from a natural language question
async function extractSearchTerms(query) {
  try {
    const response = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 200,
      messages: [{
        role: "user",
        content: `Extract the key legal search terms from this question. Return ONLY a space-separated list of the most important nouns, names, and legal concepts — no verbs, no filler words, no explanation. Maximum 8 terms.

Question: "${query}"

Terms:`
      }]
    });
    const terms = response.content?.find(b => b.type === "text")?.text?.trim() || "";
    return terms.split(/\s+/).filter(w => w.length > 2).slice(0, 8);
  } catch (e) {
    // Fall back to simple keyword extraction
    return query.split(/\s+/).filter(w => w.length > 3).slice(0, 8);
  }
}

/* v3.7: searchChunks now accepts optional focusDocNames array.
   When provided, chunks are filtered to only those documents.
   v5.6a: supabase is now passed in, not module-scoped. */
async function searchChunks(supabase, matterId, query, limit, focusDocNames) {
  limit = limit || 30;
  // First try with AI-extracted terms
  const terms = await extractSearchTerms(query);
  const keywords = terms.join(" | ");

  if (keywords) {
    var q = supabase.from("chunks").select("content, document_name, doc_type")
      .eq("matter_id", matterId)
      .textSearch("content", keywords, { type: "plain", config: "english" })
      .limit(limit);
    if (focusDocNames && focusDocNames.length > 0) q = q.in("document_name", focusDocNames);
    const { data, error } = await q;
    if (!error && data?.length) return data;
  }

  // Fall back to simple keyword extraction if AI terms yield nothing
  const simpleKeywords = query.split(/\s+/).filter(w => w.length > 3).slice(0, 10).join(" | ");
  if (simpleKeywords) {
    var q2 = supabase.from("chunks").select("content, document_name, doc_type")
      .eq("matter_id", matterId)
      .textSearch("content", simpleKeywords, { type: "plain", config: "english" })
      .limit(limit);
    if (focusDocNames && focusDocNames.length > 0) q2 = q2.in("document_name", focusDocNames);
    const { data, error } = await q2;
    if (!error && data?.length) return data;
  }

  // Final fallback — return most recent chunks (still filtered by focusDocNames if set)
  var q3 = supabase.from("chunks").select("content, document_name, doc_type")
    .eq("matter_id", matterId).limit(limit);
  if (focusDocNames && focusDocNames.length > 0) q3 = q3.in("document_name", focusDocNames);
  const { data } = await q3;
  return data || [];
}

async function logUsage(supabase, matterId, userId, toolName, inputTokens, outputTokens, cost) {
  try {
    await supabase.from("usage_log").insert({
      matter_id: matterId, user_id: userId, tool_name: toolName,
      input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: cost,
    });
  } catch (e) { console.error("Usage log error:", e); }
}

const SERVER_VERSION = "v5.9a";
export default async function handler(req, res) {
  console.log(SERVER_VERSION + " analyse handler: " + (req.method || "?") + " " + (req.url || ""));
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  /* v5.6a: Fresh createClient() per invocation. The previous module-scope
     client was responsible for sporadic 403 responses from Supabase Auth
     on getUser() calls, which surfaced as 401 Unauthorized to the frontend
     and silently broke tool follow-ups. Documented bug pattern — see v4.2j
     note in permanent technical references. */
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const user = await getUser(supabase, req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  /* v3.7: Accept focusDocNames from request body.
     v5.9a: Accept subElement and freeformFocus from request body. These are
     the two new fields supplied by the unified three-mode focus component
     (Push I) and are folded into the system prompt the same way focusDocNote
     is — as small conditional notes that only appear when the field is set.
     Retrieval is unchanged in v5.9a; subElement and freeformFocus do not
     affect searchChunks. That can be revisited in a later push. */
  const { matterId, matterName, matterNature, matterIssues, messages, jurisdiction, queryType, focusAreas, actingFor, focusDocNames, subElement, freeformFocus } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: "Invalid request" });

  try {
    const latest = messages[messages.length - 1];
    const userQuery = typeof latest.content === "string" ? latest.content : latest.content?.find?.(c => c.type === "text")?.text || "";

    let contextText = "";
    if (matterId) {
      /* v3.7: Pass focusDocNames to searchChunks for document-focused follow-ups */
      const chunks = await searchChunks(supabase, matterId, userQuery, 30, focusDocNames);
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

    /* v3.7: If focusDocNames were specified, tell Claude which documents were targeted */
    var focusDocNote = "";
    if (focusDocNames && focusDocNames.length > 0) {
      focusDocNote = "\nThe user has specifically asked you to focus your answer on the following documents: " + focusDocNames.join(", ") + ". Draw your answer primarily from passages in these documents, citing them by name.\n";
    }

    /* v5.9a: If subElement was specified, narrow the analysis to that sub-element. */
    var subElementNote = "";
    if (subElement && typeof subElement === "string" && subElement.trim().length > 0) {
      subElementNote = "\nThe user has specifically asked you to narrow the analysis to the following sub-element of the parent result: " + subElement.trim() + ". Treat that sub-element as the focus of your answer rather than producing a broad survey.\n";
    }

    /* v5.9a: If freeformFocus was specified, treat it as an additional focus instruction. */
    var freeformFocusNote = "";
    if (freeformFocus && typeof freeformFocus === "string" && freeformFocus.trim().length > 0) {
      freeformFocusNote = "\nThe user has provided the following additional focus instruction for this answer: " + freeformFocus.trim() + ". Honour this instruction in shaping the depth, scope, and emphasis of your response.\n";
    }

    const matterContext = [
      matterNature ? `Nature of the dispute: ${matterNature}` : "",
      matterIssues ? `Key issues in this matter: ${matterIssues}` : "",
      actingFor ? `Acting for: ${actingFor}` : "",
    ].filter(Boolean).join("\n");

    const system = `You are a senior litigation counsel specialising in ${jurisdiction || "Bermuda"} offshore common law litigation. You have deep expertise in Bermuda, Cayman Islands and BVI law, court rules (RSC Bermuda, GCR Cayman, CPR BVI), statutes, company law, trust law, insolvency, and English common law precedent as applied offshore.

Matter: "${matterName || "Current Matter"}"
${matterContext ? `\n${matterContext}\n` : ""}${focusDocNote}${subElementNote}${freeformFocusNote}
${contextText ? `The following passages are retrieved from the matter documents as most relevant to this question. Refer to them specifically, quoting where helpful:\n\n${contextText}` : "No documents uploaded yet. Answer based on your legal knowledge."}

In every response:
1. Apply ${jurisdiction || "Bermuda"}-specific law — cite local statutes, court rules, and leading authority by name
2. Refer to document passages specifically, identifying which document they come from
3. Flag where ${jurisdiction || "Bermuda"} law diverges from English law or other offshore jurisdictions
4. Be precise — identify unsettled points and flag litigation risk
5. Address these focus areas: ${focusAreas?.join(", ") || "all relevant issues"}
6. Use clear ## headings. Do not truncate your response.
Analysis type: ${queryType || "General Legal Analysis"}`;

    const cleanMessages = messages.map(m => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter(c => c.type === "text").map(c => c.text).join("\n") : String(m.content)
    }));

    const response = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 16384,
      system,
      messages: cleanMessages,
    });

    const resultText = response.content?.find(b => b.type === "text")?.text || "";
    const inputTokens  = response.usage?.input_tokens  || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    const costUsd = (inputTokens * INPUT_COST_PER_M / 1_000_000) + (outputTokens * OUTPUT_COST_PER_M / 1_000_000);

    if (matterId) await logUsage(supabase, matterId, user.id, "qa", inputTokens, outputTokens, costUsd);

    return res.status(200).json({ result: resultText, usage: { inputTokens, outputTokens, costUsd } });
  } catch (err) {
    console.error("Analyse error:", err);
    return res.status(500).json({ error: err.message || "Analysis failed" });
  }
}
