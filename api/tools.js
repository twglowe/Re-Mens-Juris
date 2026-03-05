import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

export const config = { maxDuration: 300 };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Pricing per million tokens (claude-sonnet-4-6)
const INPUT_COST_PER_M  = 3.00;
const OUTPUT_COST_PER_M = 15.00;

async function getUser(req) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  return error ? null : user;
}

// Fetch ALL chunks with no artificial cap, paginated in batches of 1000
async function getAllChunks(matterId, docTypes = null) {
  let allChunks = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let query = supabase.from("chunks")
      .select("content, document_name, doc_type, chunk_index")
      .eq("matter_id", matterId)
      .order("document_name")
      .order("chunk_index")
      .range(from, from + pageSize - 1);
    if (docTypes && docTypes.length > 0) query = query.in("doc_type", docTypes);
    const { data, error } = await query;
    if (error || !data || data.length === 0) break;
    allChunks = allChunks.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return allChunks;
}

function chunksToDocMap(chunks) {
  const byDoc = {};
  for (const c of chunks) {
    if (!byDoc[c.document_name]) byDoc[c.document_name] = { type: c.doc_type, text: "" };
    byDoc[c.document_name].text += c.content + "\n\n";
  }
  return byDoc;
}

// Split docs into batches of ~80k chars to stay within context limits
function batchDocs(byDoc, maxChars = 80000) {
  const batches = [];
  let current = {};
  let currentSize = 0;
  for (const [name, data] of Object.entries(byDoc)) {
    const docSize = data.text.length + name.length + 50;
    if (currentSize + docSize > maxChars && Object.keys(current).length > 0) {
      batches.push(current);
      current = {};
      currentSize = 0;
    }
    current[name] = data;
    currentSize += docSize;
  }
  if (Object.keys(current).length > 0) batches.push(current);
  return batches;
}

function docsToText(byDoc) {
  return Object.entries(byDoc).map(([n, d]) => `=== ${n} [${d.type}] ===\n${d.text}`).join("\n\n");
}

async function runTool(system, userPrompt) {
  const response = await anthropic.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 8192,
    system,
    messages: [{ role: "user", content: userPrompt }],
  });
  const text = response.content?.find(b => b.type === "text")?.text || "";
  const inputTokens  = response.usage?.input_tokens  || 0;
  const outputTokens = response.usage?.output_tokens || 0;
  const cost = (inputTokens * INPUT_COST_PER_M / 1_000_000) + (outputTokens * OUTPUT_COST_PER_M / 1_000_000);
  return { text, inputTokens, outputTokens, cost };
}

// Two-pass batched processing: extract then synthesise
async function runBatched(systemBase, extractPromptFn, synthPromptFn, byDoc) {
  const batches = batchDocs(byDoc);
  let totalInput = 0, totalOutput = 0, totalCost = 0;

  if (batches.length === 1) {
    const r = await runTool(systemBase, synthPromptFn(docsToText(batches[0]), null));
    return { text: r.text, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cost: r.cost };
  }

  // Extraction pass
  const extracts = [];
  for (let i = 0; i < batches.length; i++) {
    const batchText = docsToText(batches[i]);
    const r = await runTool(systemBase, extractPromptFn(batchText, i + 1, batches.length));
    extracts.push(r.text);
    totalInput  += r.inputTokens;
    totalOutput += r.outputTokens;
    totalCost   += r.cost;
  }

  // Synthesis pass
  const combinedExtracts = extracts.map((e, i) => `=== BATCH ${i+1} FINDINGS ===\n${e}`).join("\n\n");
  const r = await runTool(systemBase, synthPromptFn(combinedExtracts, batches.length));
  totalInput  += r.inputTokens;
  totalOutput += r.outputTokens;
  totalCost   += r.cost;

  return { text: r.text, inputTokens: totalInput, outputTokens: totalOutput, cost: totalCost };
}

async function logUsage(matterId, userId, toolName, inputTokens, outputTokens, cost) {
  try {
    await supabase.from("usage_log").insert({
      matter_id: matterId,
      user_id: userId,
      tool_name: toolName,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: cost,
    });
  } catch (e) {
    console.error("Usage log error:", e);
  }
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
    let inputTokens = 0, outputTokens = 0, cost = 0;

    // ── PROPOSITION EVIDENCE FINDER ───────────────────────────────────────────
    if (tool === "proposition") {
      if (!instructions) return res.status(400).json({ error: "Please state the proposition to test" });
      const chunks = await getAllChunks(matterId);
      const byDoc = chunksToDocMap(chunks);
      const systemBase = `You are a senior litigation counsel in ${jur} conducting an evidence assessment for the matter "${matterName}".\n${matterContext}`;
      const r = await runBatched(
        systemBase,
        (batchText, batchNum, total) =>
          `PROPOSITION: "${instructions}"\n\nBatch ${batchNum} of ${total}. Extract ALL relevant passages — supporting, contradicting, or neutral.\n\nFor each:\n### [Document] — [Brief description]\nGRADE: [1-5]\n[Relevant passage]\n**Analysis:** [Relevance to proposition]\n\nGrading: 5=strong direct, 4=good supportive, 3=moderate indirect, 2=weak tangential, 1=contrary\n\nDOCUMENTS:\n\n${batchText}`,
        (combined, numBatches) => numBatches
          ? `PROPOSITION: "${instructions}"\n\nSynthesise findings from ${numBatches} batches into a single evidence assessment.\n\nRetain format:\n### [Document] — [Description]\nGRADE: [1-5]\n[Passage]\n**Analysis:** [Relevance]\n\nThen:\n## Overall Assessment\nStrength of evidence for/against and view on balance of probabilities.\n\n⚠️ Professional Caution: AI-generated analysis. Verify all passages before reliance.\n\nFINDINGS:\n\n${combined}`
          : `PROPOSITION: "${instructions}"\n\nFind ALL evidence — supporting, contradicting, or neutral.\n\n### [Document] — [Description]\nGRADE: [1-5] (5=strong direct, 4=good supportive, 3=moderate indirect, 2=weak tangential, 1=contrary)\n[Relevant passage]\n**Analysis:** [Relevance]\n\n## Overall Assessment\nSummary and preliminary view.\n\n⚠️ Professional Caution: AI-generated. Verify all passages before reliance.\n\nDOCUMENTS:\n\n${combined}`,
        byDoc
      );
      result = r.text; inputTokens = r.inputTokens; outputTokens = r.outputTokens; cost = r.cost;
    }

    // ── INCONSISTENCY TRACKER ─────────────────────────────────────────────────
    else if (tool === "inconsistency") {
      const chunks = await getAllChunks(matterId);
      const byDoc = chunksToDocMap(chunks);
      let anchorDocs = {};
      let otherDocs  = {};
      for (const [name, data] of Object.entries(byDoc)) {
        if (anchorDocNames?.includes(name)) anchorDocs[name] = data;
        else otherDocs[name] = data;
      }
      if (Object.keys(anchorDocs).length === 0) {
        const entries = Object.entries(byDoc);
        const mid = Math.ceil(entries.length / 2);
        anchorDocs = Object.fromEntries(entries.slice(0, mid));
        otherDocs  = Object.fromEntries(entries.slice(mid));
      }
      const systemBase = `You are a senior litigation counsel conducting forensic inconsistency analysis for "${matterName}" in ${jur}.\n${matterContext}`;
      const anchorText = docsToText(anchorDocs);
      const otherBatches = batchDocs(otherDocs);
      let allFindings = [];
      let totalInput = 0, totalOutput = 0, totalCost = 0;
      for (let i = 0; i < otherBatches.length; i++) {
        const r = await runTool(systemBase,
          `Find every inconsistency between ANCHOR DOCUMENTS and this batch.\n\n### [N]. [Description]\n**Anchor:** [Document and passage]\n**Contradiction:** [Document and passage]\n**Significance:** CRITICAL / SIGNIFICANT / MINOR\n**Tactical note:** [How to use or address]\n\nANCHOR:\n\n${anchorText}\n\nOTHER (batch ${i+1}/${otherBatches.length}):\n\n${docsToText(otherBatches[i])}\n\n${instructions ? `Instructions: ${instructions}` : ""}`
        );
        allFindings.push(r.text);
        totalInput += r.inputTokens; totalOutput += r.outputTokens; totalCost += r.cost;
      }
      if (allFindings.length === 1) {
        result = allFindings[0] + "\n\n⚠️ Professional Caution: AI-generated analysis. Verify quotations before reliance.";
      } else {
        const synth = await runTool(systemBase,
          `Consolidate these inconsistency findings, remove duplicates, sort by significance (CRITICAL first).\n\nEnd with:\n## Summary\nOverall factual assessment.\n\n⚠️ Professional Caution: AI-generated. Verify quotations before reliance.\n\nFINDINGS:\n\n${allFindings.map((f,i)=>`=== BATCH ${i+1} ===\n${f}`).join("\n\n")}`
        );
        result = synth.text;
        totalInput += synth.inputTokens; totalOutput += synth.outputTokens; totalCost += synth.cost;
      }
      inputTokens = totalInput; outputTokens = totalOutput; cost = totalCost;
    }

    // ── CHRONOLOGY ────────────────────────────────────────────────────────────
    else if (tool === "chronology") {
      const chunks = await getAllChunks(matterId);
      const byDoc = chunksToDocMap(chunks);
      const systemBase = `You are a senior litigation counsel constructing a comprehensive chronology for "${matterName}" in ${jur}.\n${matterContext}`;
      const r = await runBatched(
        systemBase,
        (batchText, batchNum, total) =>
          `Extract EVERY date and event from batch ${batchNum} of ${total}. Be exhaustive — include all date formats: DD/MM/YYYY, Month Year, year-only, relative references ("three months later"), approximate dates ("early 2022", "Q1 2023").\n\n**[DATE]** — [Event] *(Source: [document])*\n\nFlag conflicts: **[DATE] (DISPUTED)** — [both versions with sources]\n\n${instructions ? `Focus: ${instructions}\n\n` : ""}DOCUMENTS:\n\n${batchText}`,
        (combined, numBatches) => numBatches
          ? `Synthesise chronology extracts from ${numBatches} batches into a single complete de-duplicated chronology sorted by date.\n\n## Chronology — ${matterName}\n\n**[DATE]** — [Event] *(Source: [document])*\n\nGroup by year if spanning multiple years. Note all sources where same event appears in multiple documents. Flag disputed dates.\n\n## Key Dates Summary\nThe 10–15 most significant dates.\n\n⚠️ Professional Caution: AI-generated chronology. Verify all dates before reliance.\n\nEXTRACTS:\n\n${combined}`
          : `Construct a complete chronology. Extract EVERY date and event — be exhaustive.\n\n## Chronology — ${matterName}\n\n**[DATE]** — [Event] *(Source: [document])*\n\nAll date formats. Group by year if applicable. Flag disputed dates.\n\n## Key Dates Summary\nThe 10–15 most significant dates.\n\n⚠️ Professional Caution: AI-generated. Verify all dates before reliance.\n\n${instructions ? `Focus: ${instructions}\n\n` : ""}DOCUMENTS:\n\n${combined}`,
        byDoc
      );
      result = r.text; inputTokens = r.inputTokens; outputTokens = r.outputTokens; cost = r.cost;
    }

    // ── PERSONS INDEX ─────────────────────────────────────────────────────────
    else if (tool === "persons") {
      const chunks = await getAllChunks(matterId);
      const byDoc = chunksToDocMap(chunks);
      const systemBase = `You are a senior litigation counsel compiling a persons and entities index for "${matterName}" in ${jur}.\n${matterContext}`;
      const r = await runBatched(
        systemBase,
        (batchText, batchNum, total) =>
          `Extract EVERY person and entity from batch ${batchNum} of ${total}. Include everyone — individuals, companies, trusts, funds, partnerships — even those mentioned only once.\n\n### [Name]\n**Role:** [role]\n**Also known as:** [aliases, titles]\n**Mentioned in:** [documents]\n**Key facts:** [what this batch reveals]\n\n${instructions ? `Focus: ${instructions}\n\n` : ""}DOCUMENTS:\n\n${batchText}`,
        (combined, numBatches) => numBatches
          ? `Synthesise persons and entities from ${numBatches} batches into a single comprehensive index. Merge entries for the same person/entity. Sort alphabetically.\n\n## Persons & Entities Index — ${matterName}\n\n### [Full Name]\n**Role:** [role]\n**Also known as:** [all aliases and titles]\n**Mentioned in:** [all documents]\n**Key facts:** [comprehensive summary including any conflicts between accounts]\n\n⚠️ Professional Caution: AI-generated. Verify all attributions before reliance.\n\nEXTRACTS:\n\n${combined}`
          : `Compile a complete persons and entities index. Include EVERYONE mentioned — even passing references.\n\n## Persons & Entities Index — ${matterName}\n\n### [Full Name]\n**Role:** [role]\n**Also known as:** [aliases, titles]\n**Mentioned in:** [documents]\n**Key facts:** [all the evidence reveals, including conflicts between accounts]\n\nSort alphabetically.\n\n⚠️ Professional Caution: AI-generated. Verify all attributions before reliance.\n\n${instructions ? `Focus: ${instructions}\n\n` : ""}DOCUMENTS:\n\n${combined}`,
        byDoc
      );
      result = r.text; inputTokens = r.inputTokens; outputTokens = r.outputTokens; cost = r.cost;
    }

    // ── ISSUE TRACKER ─────────────────────────────────────────────────────────
    else if (tool === "issues") {
      const chunks = await getAllChunks(matterId);
      const byDoc = chunksToDocMap(chunks);
      const systemBase = `You are a senior litigation counsel in ${jur} mapping issues for "${matterName}".\n${matterContext}`;
      const r = await runBatched(
        systemBase,
        (batchText, batchNum, total) =>
          `From batch ${batchNum} of ${total}, identify every legal and factual issue and relevant evidence.\n\n### Issue: [description]\n**Type:** Legal / Factual / Mixed\n**Evidence for Claimant:** [documents and passages]\n**Evidence for Defendant:** [documents and passages]\n\n${instructions ? `Focus: ${instructions}\n\n` : ""}DOCUMENTS:\n\n${batchText}`,
        (combined, numBatches) => numBatches
          ? `Synthesise issue findings from ${numBatches} batches. Merge duplicates, add all evidence.\n\n## Issue Tracker — ${matterName}\n\n### Issue [N]: [description]\n**Type:** Legal / Factual / Mixed\n**Raised by:** [party]\n**Evidence for Claimant:** [documents and passages]\n**Evidence for Defendant:** [documents and passages]\n**Assessment:** [preliminary view]\n\n## Overall Assessment\nIssues ranked by importance with preliminary view on merits.\n\n⚠️ Professional Caution: AI-generated. Verify before reliance.\n\nFINDINGS:\n\n${combined}`
          : `Produce a complete issue tracker.\n\n## Issue Tracker — ${matterName}\n\n### Issue [N]: [description]\n**Type:** Legal / Factual / Mixed\n**Raised by:** [party]\n**Evidence for Claimant:** [documents and passages]\n**Evidence for Defendant:** [documents and passages]\n**Assessment:** [preliminary view]\n\n## Overall Assessment\n\n⚠️ Professional Caution: AI-generated. Verify before reliance.\n\n${instructions ? `Focus: ${instructions}\n\n` : ""}DOCUMENTS:\n\n${combined}`,
        byDoc
      );
      result = r.text; inputTokens = r.inputTokens; outputTokens = r.outputTokens; cost = r.cost;
    }

    // ── CITATION CHECKER ──────────────────────────────────────────────────────
    else if (tool === "citations") {
      const skeletonChunks = await getAllChunks(matterId, ["Skeleton Argument", "Pleading"]);
      const caselawChunks  = await getAllChunks(matterId, ["Case Law"]);
      const skeletonText = docsToText(chunksToDocMap(skeletonChunks)) || "None uploaded";
      const caselawText  = docsToText(chunksToDocMap(caselawChunks))  || "No case law uploaded";
      const r = await runTool(
        `You are a senior litigation counsel in ${jur} checking citations for "${matterName}".\n${matterContext}`,
        `Check every citation in skeleton arguments and pleadings against uploaded case law.\n\n## Citation Check — ${matterName}\n\n### [Case name]\n**Cited for:** [proposition]\n**Found in uploads:** Yes / No / Partial\n**Accuracy:** [does the judgment support the proposition?]\n**Flag:** ✓ Accurate / ⚠️ Overstated / ✗ Incorrect / ? Not uploaded\n**Notes:** [any concern]\n\nSKELETONS:\n\n${skeletonText}\n\nCASE LAW:\n\n${caselawText}`
      );
      result = r.text; inputTokens = r.inputTokens; outputTokens = r.outputTokens; cost = r.cost;
    }

    // ── BRIEFING NOTE ─────────────────────────────────────────────────────────
    else if (tool === "briefing") {
      const chunks = await getAllChunks(matterId);
      const byDoc = chunksToDocMap(chunks);
      const systemBase = `You are a senior litigation counsel in ${jur} producing a briefing note for "${matterName}".\n${matterContext}`;
      const r = await runBatched(
        systemBase,
        (batchText, batchNum, total) =>
          `Extract key facts, legal issues, evidence and procedural information from batch ${batchNum} of ${total} for a briefing note on "${matterName}".\n\nDOCUMENTS:\n\n${batchText}`,
        (combined, numBatches) => numBatches
          ? `Using findings from ${numBatches} batches, produce a complete structured briefing note.\n\n## Briefing Note — ${matterName}\n**Jurisdiction:** ${jur}\n**Date:** ${new Date().toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"})}\n\n## 1. Background\n## 2. The Parties\n## 3. The Claim\n## 4. Key Facts\n## 5. Legal Issues\n## 6. Evidence Summary\n## 7. Current Procedural Position\n## 8. Key Risks\n## 9. Next Steps\n\n${instructions ? `Focus: ${instructions}\n\n` : ""}FINDINGS:\n\n${combined}`
          : `Produce a structured briefing note.\n\n## Briefing Note — ${matterName}\n**Jurisdiction:** ${jur}\n**Date:** ${new Date().toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"})}\n\n## 1. Background\n## 2. The Parties\n## 3. The Claim\n## 4. Key Facts\n## 5. Legal Issues\n## 6. Evidence Summary\n## 7. Current Procedural Position\n## 8. Key Risks\n## 9. Next Steps\n\n${instructions ? `Focus: ${instructions}\n\n` : ""}DOCUMENTS:\n\n${combined}`,
        byDoc
      );
      result = r.text; inputTokens = r.inputTokens; outputTokens = r.outputTokens; cost = r.cost;
    }

    // ── DRAFT GENERATOR ───────────────────────────────────────────────────────
    else if (tool === "draft") {
      const chunks = await getAllChunks(matterId);
      const byDoc = chunksToDocMap(chunks);
      const systemBase = `You are a senior litigation counsel in ${jur} drafting a legal document for "${matterName}". Apply ${jur} law, procedure, and drafting conventions.\n${matterContext}`;
      const r = await runBatched(
        systemBase,
        (batchText, batchNum, total) =>
          `Extract all facts, legal points, and arguments from batch ${batchNum} of ${total} relevant to: ${instructions || "Draft a skeleton argument"}\n\nDOCUMENTS:\n\n${batchText}`,
        (combined, numBatches) => numBatches
          ? `Using source material from ${numBatches} batches, produce:\n\n${instructions || "Draft a skeleton argument."}\n\nApply ${jur} court rules and drafting conventions.\n\n⚠️ Professional Caution: AI-generated draft. Review carefully before use.\n\nSOURCE MATERIAL:\n\n${combined}`
          : `${instructions || "Draft a skeleton argument based on the matter documents."}\n\nApply ${jur} court rules and conventions.\n\n⚠️ Professional Caution: AI-generated draft. Review carefully before use.\n\nDOCUMENTS:\n\n${combined}`,
        byDoc
      );
      result = r.text; inputTokens = r.inputTokens; outputTokens = r.outputTokens; cost = r.cost;
    }

    else {
      return res.status(400).json({ error: "Unknown tool: " + tool });
    }

    await logUsage(matterId, user.id, tool, inputTokens, outputTokens, cost);
    return res.status(200).json({ result, usage: { inputTokens, outputTokens, costUsd: cost } });

  } catch (err) {
    console.error("Tools error:", err);
    return res.status(500).json({ error: err.message || "Tool failed" });
  }
}    max_tokens: 8192,
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
