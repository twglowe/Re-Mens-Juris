import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

export const config = { maxDuration: 300 };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function getUser(req) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  return error ? null : user;
}

async function getAllChunks(matterId, docTypes = null, limit = 200) {
  let query = supabase.from("chunks").select("content, document_name, doc_type, chunk_index").eq("matter_id", matterId).order("document_name").order("chunk_index");
  if (docTypes && docTypes.length > 0) query = query.in("doc_type", docTypes);
  const { data } = await query.limit(limit);
  return data || [];
}

async function getChunksByDoc(matterId, docTypes = null) {
  const chunks = await getAllChunks(matterId, docTypes);
  const byDoc = {};
  for (const c of chunks) {
    if (!byDoc[c.document_name]) byDoc[c.document_name] = { type: c.doc_type, text: "" };
    byDoc[c.document_name].text += c.content + "\n\n";
  }
  return byDoc;
}

async function runTool(system, userPrompt) {
  const response = await anthropic.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-opus-4-5",
    max_tokens: 8192,
    system,
    messages: [{ role: "user", content: userPrompt }],
  });
  return response.content?.find(b => b.type === "text")?.text || "";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { tool, matterId, matterName, jurisdiction, anchorDocIds, anchorDocNames, instructions } = req.body;
  if (!tool || !matterId) return res.status(400).json({ error: "tool and matterId required" });

  const jur = jurisdiction || "Bermuda";

  try {
    let result = "";

    // ── INCONSISTENCY TRACKER ─────────────────────────────────────────────────
    if (tool === "inconsistency") {
      const byDoc = await getChunksByDoc(matterId);

      // Separate anchor docs from the rest
      let anchorText = "";
      let otherText = "";

      for (const [name, data] of Object.entries(byDoc)) {
        const isAnchor = anchorDocNames?.includes(name);
        if (isAnchor) {
          anchorText += `=== ANCHOR: ${name} [${data.type}] ===\n${data.text}\n\n`;
        } else {
          otherText += `=== ${name} [${data.type}] ===\n${data.text}\n\n`;
        }
      }

      if (!anchorText) {
        // No anchors selected — compare all documents against each other
        anchorText = Object.entries(byDoc).slice(0, 3).map(([n, d]) => `=== ${n} [${d.type}] ===\n${d.text}`).join("\n\n");
        otherText = Object.entries(byDoc).slice(3).map(([n, d]) => `=== ${n} [${d.type}] ===\n${d.text}`).join("\n\n");
      }

      const system = `You are a senior litigation counsel conducting a forensic inconsistency analysis for the matter "${matterName}" in ${jur}.

Your task is to identify factual inconsistencies, contradictions, and conflicts between the anchor documents and other documents in this matter.

An inconsistency includes:
- Direct contradictions (Document A says X happened on date D; Document B says X happened on date E)
- Conflicting accounts of the same event by different witnesses
- Facts asserted in pleadings contradicted by evidence
- Witness statements that contradict exhibits or other witness statements
- Admissions in one document that undermine positions taken in another
- Omissions that are inconsistent with what other documents reveal

For each inconsistency found, provide:
1. A clear description of the inconsistency
2. The anchor statement (exact quote if possible, with document name)
3. The contradicting statement (exact quote if possible, with document name)  
4. Assessment of significance: CRITICAL / SIGNIFICANT / MINOR
5. Tactical observations — how this inconsistency could be used or needs to be addressed

Format your response with:
## Inconsistency Analysis — ${matterName}
Then for each finding:
### [Number]. [Brief description]
**Anchor document:** [name and quote]
**Contradicting document:** [name and quote]
**Significance:** CRITICAL / SIGNIFICANT / MINOR
**Tactical note:** [observation]

End with:
## Summary
A brief summary of the most significant inconsistencies and overall assessment of the factual landscape.

⚠️ Professional Caution: AI-generated analysis. Verify all quotations against source documents before reliance.`;

      result = await runTool(system,
        `ANCHOR DOCUMENTS (the baseline factual positions):\n\n${anchorText}\n\nOTHER DOCUMENTS TO COMPARE AGAINST:\n\n${otherText || "(No other documents — comparing anchor documents internally)"}\n\n${instructions ? `Additional instructions: ${instructions}` : "Identify all inconsistencies, contradictions and conflicts."}`
      );
    }

    // ── CHRONOLOGY ────────────────────────────────────────────────────────────
    else if (tool === "chronology") {
      const byDoc = await getChunksByDoc(matterId);
      const allText = Object.entries(byDoc).map(([n, d]) => `=== ${n} [${d.type}] ===\n${d.text}`).join("\n\n");

      result = await runTool(
        `You are a senior litigation counsel constructing a detailed legal chronology for the matter "${matterName}" in ${jur}. Extract every date, event, and action mentioned across all documents. For disputed dates or events, note the dispute.`,
        `Extract a full chronology from these documents. Format as:\n\n## Chronology — ${matterName}\n\nFor each entry:\n**[DATE]** — [Event description] *(Source: [document name])*\n\nIf a date is disputed between documents, note both versions and flag as DISPUTED.\nGroup by year if the chronology spans multiple years.\nEnd with a ## Key Dates Summary of the most significant dates.\n\nDOCUMENTS:\n\n${allText}`
      );
    }

    // ── PERSONS INDEX ─────────────────────────────────────────────────────────
    else if (tool === "persons") {
      const byDoc = await getChunksByDoc(matterId);
      const allText = Object.entries(byDoc).map(([n, d]) => `=== ${n} [${d.type}] ===\n${d.text}`).join("\n\n");

      result = await runTool(
        `You are a senior litigation counsel compiling a persons and entities index for the matter "${matterName}" in ${jur}. Identify every individual, company, and organisation mentioned and summarise what the documents reveal about each.`,
        `Compile a persons and entities index. Format as:\n\n## Persons & Entities Index — ${matterName}\n\nFor each person or entity:\n### [Full Name / Entity Name]\n**Role:** [their role in the matter]\n**Mentioned in:** [list of documents]\n**Key facts:** [what the documents reveal about them, including any conflicting accounts]\n\nDOCUMENTS:\n\n${allText}`
      );
    }

    // ── ISSUE TRACKER ─────────────────────────────────────────────────────────
    else if (tool === "issues") {
      const byDoc = await getChunksByDoc(matterId);
      const allText = Object.entries(byDoc).map(([n, d]) => `=== ${n} [${d.type}] ===\n${d.text}`).join("\n\n");

      result = await runTool(
        `You are a senior litigation counsel in ${jur} mapping the legal and factual issues in the matter "${matterName}". Identify every issue raised in the pleadings and assess the evidence for and against each party on that issue.`,
        `Produce an issue tracker. Format as:\n\n## Issue Tracker — ${matterName}\n\nFor each issue:\n### Issue [N]: [Issue description]\n**Type:** Legal / Factual / Mixed\n**As pleaded by:** [which party raises this]\n**Evidence supporting Claimant:** [documents and passages]\n**Evidence supporting Defendant:** [documents and passages]\n**Assessment:** [preliminary view on strength]\n\nEnd with ## Overall Assessment.\n\nDOCUMENTS:\n\n${allText}`
      );
    }

    // ── CITATION CHECKER ──────────────────────────────────────────────────────
    else if (tool === "citations") {
      const byDoc = await getChunksByDoc(matterId, ["Skeleton Argument", "Pleading"]);
      const caselaw = await getChunksByDoc(matterId, ["Case Law"]);

      const skeletonText = Object.entries(byDoc).map(([n, d]) => `=== ${n} [${d.type}] ===\n${d.text}`).join("\n\n");
      const caselawText = Object.entries(caselaw).map(([n, d]) => `=== ${n} ===\n${d.text}`).join("\n\n");

      result = await runTool(
        `You are a senior litigation counsel in ${jur} checking legal citations in skeleton arguments and pleadings against the actual judgments uploaded.`,
        `Check the citations in the skeleton arguments and pleadings against the case law documents. For each citation:\n\n## Citation Check — ${matterName}\n\n### [Case name as cited]\n**Proposition cited for:** [what the document says the case stands for]\n**Found in uploaded cases:** Yes / No / Partial\n**Accuracy:** [does the judgment support the proposition?]\n**Flag:** ✓ Accurate / ⚠️ Overstated / ✗ Incorrect / ? Not uploaded\n\nSKELETON ARGUMENTS & PLEADINGS:\n\n${skeletonText || "None uploaded"}\n\nCASE LAW UPLOADED:\n\n${caselawText || "No case law uploaded — cannot verify citations"}`
      );
    }

    // ── BRIEFING NOTE ─────────────────────────────────────────────────────────
    else if (tool === "briefing") {
      const byDoc = await getChunksByDoc(matterId);
      const allText = Object.entries(byDoc).map(([n, d]) => `=== ${n} [${d.type}] ===\n${d.text}`).join("\n\n");

      result = await runTool(
        `You are a senior litigation counsel in ${jur} producing a concise briefing note on the matter "${matterName}" for a colleague who needs to get up to speed quickly.`,
        `Produce a structured briefing note. Format as:\n\n## Briefing Note — ${matterName}\n**Jurisdiction:** ${jur}\n**Date:** ${new Date().toLocaleDateString("en-GB", { day:"numeric", month:"long", year:"numeric" })}\n\n## 1. Background\n## 2. The Parties\n## 3. The Claim\n## 4. Key Facts\n## 5. Legal Issues\n## 6. Evidence Summary\n## 7. Current Procedural Position\n## 8. Key Risks\n## 9. Next Steps\n\n${instructions ? `Focus particularly on: ${instructions}\n\n` : ""}DOCUMENTS:\n\n${allText}`
      );
    }

    // ── DRAFT GENERATOR ───────────────────────────────────────────────────────
    else if (tool === "draft") {
      const byDoc = await getChunksByDoc(matterId);
      const allText = Object.entries(byDoc).map(([n, d]) => `=== ${n} [${d.type}] ===\n${d.text}`).join("\n\n");

      result = await runTool(
        `You are a senior litigation counsel in ${jur} drafting a legal document for the matter "${matterName}". Apply ${jur} law, procedure, and drafting conventions throughout.`,
        `${instructions || "Draft a skeleton argument based on the matter documents."}\n\nApply ${jur} court rules and conventions. Use proper legal drafting style. Cite specific passages from the matter documents where relevant.\n\nMATTER DOCUMENTS:\n\n${allText}\n\n⚠️ Professional Caution: AI-generated draft. Review carefully before use.`
      );
    }

    else {
      return res.status(400).json({ error: "Unknown tool: " + tool });
    }

    return res.status(200).json({ result });

  } catch (err) {
    console.error("Tools error:", err);
    return res.status(500).json({ error: err.message || "Tool failed" });
  }
}
