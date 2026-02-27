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
  let query = supabase.from("chunks").select("content, document_name, doc_type, chunk_index")
    .eq("matter_id", matterId).order("document_name").order("chunk_index");
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

  const { tool, matterId, matterName, matterNature, matterIssues, jurisdiction, anchorDocNames, instructions } = req.body;
  if (!tool || !matterId) return res.status(400).json({ error: "tool and matterId required" });

  const jur = jurisdiction || "Bermuda";
  const matterContext = [
    matterNature ? `Nature of the dispute: ${matterNature}` : "",
    matterIssues ? `Key issues: ${matterIssues}` : "",
  ].filter(Boolean).join("\n");

  try {
    let result = "";

    // ── PROPOSITION EVIDENCE FINDER ───────────────────────────────────────────
    if (tool === "proposition") {
      if (!instructions) return res.status(400).json({ error: "Please state the proposition to test" });
      const byDoc = await getChunksByDoc(matterId);
      const allText = Object.entries(byDoc).map(([n, d]) => `=== ${n} [${d.type}] ===\n${d.text}`).join("\n\n");

      result = await runTool(
        `You are a senior litigation counsel in ${jur} conducting an evidence assessment for the matter "${matterName}".
${matterContext}

Your task is to find ALL references across the matter documents that are relevant to the stated proposition — whether supporting, contradicting, or neutral — and grade each reference by its evidentiary strength.

For each relevant passage found, output it in exactly this format:

### [Document name] — [Brief description of the reference]
GRADE: [1-5]
[Quote or description of the relevant passage]
**Analysis:** [Why this is or is not good evidence for the proposition, and how it would be used or countered in argument]

Grading scale:
GRADE: 5 = Strong direct evidence — clearly establishes or directly contradicts the proposition
GRADE: 4 = Good supportive evidence — strongly consistent with or against the proposition  
GRADE: 3 = Moderate — relevant but indirect, requires inference
GRADE: 2 = Weak — tangentially relevant, limited probative value
GRADE: 1 = Contrary — directly contradicts or undermines the proposition

After all references, provide:
## Overall Assessment
A summary of the overall strength of evidence for and against the proposition, and a preliminary view on whether it can be established on the balance of probabilities.

⚠️ Professional Caution: AI-generated analysis. Verify all passages against source documents before reliance.`,
        `PROPOSITION TO TEST: "${instructions}"\n\nSearch all documents for relevant evidence.\n\nDOCUMENTS:\n\n${allText}`
      );
    }

    // ── INCONSISTENCY TRACKER ─────────────────────────────────────────────────
    else if (tool === "inconsistency") {
      const byDoc = await getChunksByDoc(matterId);
      let anchorText = "";
      let otherText = "";
      for (const [name, data] of Object.entries(byDoc)) {
        if (anchorDocNames?.includes(name)) {
          anchorText += `=== ANCHOR: ${name} [${data.type}] ===\n${data.text}\n\n`;
        } else {
          otherText += `=== ${name} [${data.type}] ===\n${data.text}\n\n`;
        }
      }
      if (!anchorText) {
        const entries = Object.entries(byDoc);
        anchorText = entries.slice(0, Math.ceil(entries.length/2)).map(([n,d])=>`=== ${n} [${d.type}] ===\n${d.text}`).join("\n\n");
        otherText = entries.slice(Math.ceil(entries.length/2)).map(([n,d])=>`=== ${n} [${d.type}] ===\n${d.text}`).join("\n\n");
      }

      result = await runTool(
        `You are a senior litigation counsel conducting forensic inconsistency analysis for the matter "${matterName}" in ${jur}.
${matterContext}

Identify every factual inconsistency, contradiction, and conflict between the anchor documents and other documents.

Inconsistencies include: direct contradictions, conflicting accounts of the same event, facts in pleadings contradicted by evidence, witness statements contradicting exhibits or other witnesses, admissions undermining positions taken elsewhere, and material omissions.

For each inconsistency:
### [N]. [Brief description]
**Anchor:** [Document name and exact or paraphrased quote]
**Contradiction:** [Document name and exact or paraphrased quote]
**Significance:** CRITICAL / SIGNIFICANT / MINOR
**Tactical note:** [How this can be used or needs to be addressed]

End with:
## Summary
Overall assessment of the factual landscape and the most significant inconsistencies.

⚠️ Professional Caution: AI-generated analysis. Verify all quotations against source documents before reliance.`,
        `ANCHOR DOCUMENTS:\n\n${anchorText}\n\nOTHER DOCUMENTS:\n\n${otherText||"(comparing anchor documents internally)"}\n\n${instructions?`Additional instructions: ${instructions}`:""}`
      );
    }

    // ── CHRONOLOGY ────────────────────────────────────────────────────────────
    else if (tool === "chronology") {
      const byDoc = await getChunksByDoc(matterId);
      const allText = Object.entries(byDoc).map(([n,d])=>`=== ${n} [${d.type}] ===\n${d.text}`).join("\n\n");
      result = await runTool(
        `You are a senior litigation counsel constructing a chronology for the matter "${matterName}" in ${jur}.\n${matterContext}`,
        `Extract a full chronology. Format:\n\n## Chronology — ${matterName}\n\n**[DATE]** — [Event] *(Source: [document])*\n\nFlag disputed dates as DISPUTED with both versions. Group by year if spanning multiple years.\n\nEnd with ## Key Dates Summary.\n\n${instructions?`Focus: ${instructions}\n\n`:""}DOCUMENTS:\n\n${allText}`
      );
    }

    // ── PERSONS INDEX ─────────────────────────────────────────────────────────
    else if (tool === "persons") {
      const byDoc = await getChunksByDoc(matterId);
      const allText = Object.entries(byDoc).map(([n,d])=>`=== ${n} [${d.type}] ===\n${d.text}`).join("\n\n");
      result = await runTool(
        `You are a senior litigation counsel compiling a persons and entities index for the matter "${matterName}" in ${jur}.\n${matterContext}`,
        `Compile a persons and entities index.\n\n## Persons & Entities Index — ${matterName}\n\n### [Name]\n**Role:** [role]\n**Mentioned in:** [documents]\n**Key facts:** [what documents reveal, including conflicting accounts]\n\n${instructions?`Focus: ${instructions}\n\n`:""}DOCUMENTS:\n\n${allText}`
      );
    }

    // ── ISSUE TRACKER ─────────────────────────────────────────────────────────
    else if (tool === "issues") {
      const byDoc = await getChunksByDoc(matterId);
      const allText = Object.entries(byDoc).map(([n,d])=>`=== ${n} [${d.type}] ===\n${d.text}`).join("\n\n");
      result = await runTool(
        `You are a senior litigation counsel in ${jur} mapping issues for the matter "${matterName}".\n${matterContext}`,
        `Produce an issue tracker.\n\n## Issue Tracker — ${matterName}\n\n### Issue [N]: [description]\n**Type:** Legal / Factual / Mixed\n**Raised by:** [party]\n**Evidence for Claimant:** [documents and passages]\n**Evidence for Defendant:** [documents and passages]\n**Assessment:** [preliminary view]\n\nEnd with ## Overall Assessment.\n\n${instructions?`Focus: ${instructions}\n\n`:""}DOCUMENTS:\n\n${allText}`
      );
    }

    // ── CITATION CHECKER ──────────────────────────────────────────────────────
    else if (tool === "citations") {
      const skeletonDocs = await getChunksByDoc(matterId, ["Skeleton Argument", "Pleading"]);
      const caselaw = await getChunksByDoc(matterId, ["Case Law"]);
      const skeletonText = Object.entries(skeletonDocs).map(([n,d])=>`=== ${n} ===\n${d.text}`).join("\n\n");
      const caselawText = Object.entries(caselaw).map(([n,d])=>`=== ${n} ===\n${d.text}`).join("\n\n");
      result = await runTool(
        `You are a senior litigation counsel in ${jur} checking citations for the matter "${matterName}".\n${matterContext}`,
        `Check citations in skeleton arguments and pleadings against uploaded case law.\n\n## Citation Check — ${matterName}\n\n### [Case name]\n**Cited for:** [proposition]\n**Found in uploads:** Yes / No / Partial\n**Accuracy:** [does the judgment support the proposition?]\n**Flag:** ✓ Accurate / ⚠️ Overstated / ✗ Incorrect / ? Not uploaded\n\nSKELETON ARGUMENTS:\n\n${skeletonText||"None"}\n\nCASE LAW:\n\n${caselawText||"No case law uploaded"}`
      );
    }

    // ── BRIEFING NOTE ─────────────────────────────────────────────────────────
    else if (tool === "briefing") {
      const byDoc = await getChunksByDoc(matterId);
      const allText = Object.entries(byDoc).map(([n,d])=>`=== ${n} [${d.type}] ===\n${d.text}`).join("\n\n");
      result = await runTool(
        `You are a senior litigation counsel in ${jur} producing a briefing note for the matter "${matterName}".\n${matterContext}`,
        `Produce a structured briefing note.\n\n## Briefing Note — ${matterName}\n**Jurisdiction:** ${jur}\n**Date:** ${new Date().toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"})}\n\n## 1. Background\n## 2. The Parties\n## 3. The Claim\n## 4. Key Facts\n## 5. Legal Issues\n## 6. Evidence Summary\n## 7. Current Procedural Position\n## 8. Key Risks\n## 9. Next Steps\n\n${instructions?`Focus: ${instructions}\n\n`:""}DOCUMENTS:\n\n${allText}`
      );
    }

    // ── DRAFT GENERATOR ───────────────────────────────────────────────────────
    else if (tool === "draft") {
      const byDoc = await getChunksByDoc(matterId);
      const allText = Object.entries(byDoc).map(([n,d])=>`=== ${n} [${d.type}] ===\n${d.text}`).join("\n\n");
      result = await runTool(
        `You are a senior litigation counsel in ${jur} drafting a legal document for the matter "${matterName}". Apply ${jur} law, procedure, and drafting conventions throughout.\n${matterContext}`,
        `${instructions||"Draft a skeleton argument based on the matter documents."}\n\nApply ${jur} court rules and conventions. Use proper legal drafting style.\n\nDOCUMENTS:\n\n${allText}\n\n⚠️ Professional Caution: AI-generated draft. Review carefully before use.`
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
