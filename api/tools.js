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

// Fetch chunks — limit to 3000 per call to avoid memory issues
async function getAllChunks(matterId, docTypes = null, limit = 3000) {
  let query = supabase.from("chunks")
    .select("content, document_name, doc_type")
    .eq("matter_id", matterId)
    .order("chunk_index", { ascending: true })
    .limit(limit);
  if (docTypes && docTypes.length > 0) query = query.in("doc_type", docTypes);
  const { data, error } = await query;
  if (error) throw new Error("Chunk fetch failed: " + error.message);
  return data || [];
}

function chunksToDocMap(chunks) {
  const byDoc = {};
  for (const c of chunks) {
    if (!byDoc[c.document_name]) byDoc[c.document_name] = { type: c.doc_type, text: "" };
    byDoc[c.document_name].text += c.content + "\n\n";
  }
  return byDoc;
}

// Split docs into batches of ~30k chars to keep each Claude call fast
function batchDocs(byDoc, maxChars = 30000) {
  const batches = [];
  let current = {};
  let currentSize = 0;
  for (const [name, data] of Object.entries(byDoc)) {
    // Truncate very large individual docs to 60k chars to avoid single-doc overflow
    const truncated = data.text.length > 60000 ? data.text.slice(0, 60000) + '\n[...truncated for processing...]' : data.text;
    const docData = { ...data, text: truncated };
    const docSize = truncated.length + name.length + 50;
    if (currentSize + docSize > maxChars && Object.keys(current).length > 0) {
      batches.push(current);
      current = {};
      currentSize = 0;
    }
    current[name] = docData;
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
    max_tokens: 4096,
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

  // Extraction pass — run batches in parallel (max 3 at once to avoid rate limits)
  const extracts = [];
  const PARALLEL = 3;
  for (let i = 0; i < batches.length; i += PARALLEL) {
    const slice = batches.slice(i, i + PARALLEL);
    const results = await Promise.all(slice.map((batch, j) => {
      const batchText = docsToText(batch);
      return runTool(systemBase, extractPromptFn(batchText, i + j + 1, batches.length));
    }));
    for (const r of results) {
      extracts.push(r.text);
      totalInput  += r.inputTokens;
      totalOutput += r.outputTokens;
      totalCost   += r.cost;
    }
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
          `Extract EVERY person and entity from batch ${batchNum} of ${total}. Include everyone — individuals, companies, trusts, funds, partnerships — even those mentioned only once.\n\nFor each:\n### [Name]\n**Also known as:** [all aliases, shortened names, titles used in documents]\n**Organisational roles:** [e.g. director, shareholder, limited partner, general partner, trustee, protector, beneficiary, noteholder, officer — auto-detect from documents]\n**Procedural role:** [e.g. claimant, defendant, petitioner, respondent, witness, deponent, third party — auto-detect from documents]\n**Mentioned in:** [document names]\n**Key facts:** [what this batch reveals including share percentages, appointment dates, resignation dates, any adverse findings]\n\n${instructions ? `Focus: ${instructions}\n\n` : ""}DOCUMENTS:\n\n${batchText}`,
        (combined, numBatches) => numBatches
          ? `Synthesise persons and entities from ${numBatches} batches into a single comprehensive index. Merge entries for the same person/entity. Sort alphabetically by surname/entity name.\n\n## Persons & Entities Index — ${matterName}\n\n### [Full Name]\n**Also known as:** [all aliases and titles]\n**Organisational roles:** [director, shareholder, partner, trustee, etc. with details e.g. percentage shareholding, date appointed/resigned]\n**Procedural role:** [claimant, defendant, witness, etc.]\n**Mentioned in:** [all documents]\n**Key facts:** [comprehensive summary including any conflicts between accounts, significant dates, financial interests]\n\n⚠️ Professional Caution: AI-generated. Verify all attributions before reliance.\n\nEXTRACTS:\n\n${combined}`
          : `Compile a complete persons and entities index. Include EVERYONE mentioned — even passing references.\n\n## Persons & Entities Index — ${matterName}\n\n### [Full Name]\n**Also known as:** [aliases, titles]\n**Organisational roles:** [director, shareholder, limited partner, general partner, trustee, protector, beneficiary, noteholder, officer — with details such as percentage shareholding, date appointed/resigned]\n**Procedural role:** [claimant, defendant, petitioner, respondent, witness, deponent, third party — auto-detect from documents]\n**Mentioned in:** [documents]\n**Key facts:** [all the evidence reveals including financial interests, significant dates, any conflicts between accounts]\n\nSort alphabetically by surname/entity name.\n\n⚠️ Professional Caution: AI-generated. Verify all attributions before reliance.\n\n${instructions ? `Focus: ${instructions}\n\n` : ""}DOCUMENTS:\n\n${combined}`,
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
      const libraryContext = req.body?.libraryContext || null;
      let libraryText = '';
      if (libraryContext) {
        const libParts = [];
        if (libraryContext.selectedSections && libraryContext.selectedSections.length > 0) {
          const secText = libraryContext.selectedSections
            .map(s => '=== STANDARD SECTION: ' + s.title + ' ===\n' + s.content)
            .join('\n\n');
          libParts.push('## STANDARD SECTIONS TO INCORPORATE\n\nIncorporate these sections with only minor contextual adaptation:\n\n' + secText);
        }
        if (libraryContext.selectedPrecedentIds && libraryContext.selectedPrecedentIds.length > 0) {
          const precTexts = [];
          for (const docId of libraryContext.selectedPrecedentIds) {
            // Fetch the precedent itself
            const { data: pChunks } = await supabase
              .from('precedent_chunks')
              .select('content, chunk_index')
              .eq('precedent_doc_id', docId)
              .order('chunk_index')
              .limit(80);
            // Fetch metadata to get context doc relationship
            const { data: precMeta } = await supabase
              .from('precedent_docs')
              .select('name, context_relationship, context_doc_id, context_description')
              .eq('id', docId)
              .single();
            let precEntry = '';
            if (pChunks && pChunks.length > 0) {
              const label = precMeta ? precMeta.name : docId;
              precEntry = '=== PRECEDENT: ' + label + ' ===\n' + pChunks.map(c => c.content).join('\n\n');
              // Fetch context document if present
              if (precMeta && precMeta.context_doc_id) {
                const { data: ctxChunks } = await supabase
                  .from('precedent_chunks')
                  .select('content, chunk_index')
                  .eq('precedent_doc_id', precMeta.context_doc_id)
                  .order('chunk_index')
                  .limit(40);
                if (ctxChunks && ctxChunks.length > 0) {
                  const rel = precMeta.context_relationship || 'relates to';
                  const ctxDesc = precMeta.context_description || 'context document';
                  precEntry += '\n\n--- CONTEXT: this precedent ' + rel + ' the following document (' + ctxDesc + ') ---\n'
                    + ctxChunks.map(c => c.content).join('\n\n');
                }
              }
              precTexts.push(precEntry);
            }
          }
          if (precTexts.length > 0) {
            libParts.push('## PRECEDENT DOCUMENTS\n\nUse these precedents for structure, style and legal arguments. Where a context document is shown, understand how the precedent responds to or relates to that document and apply the same approach:\n\n' + precTexts.join('\n\n---\n\n'));
          }
        }
        if (libParts.length > 0) {
          const ctLabel = [libraryContext.caseTypeName, libraryContext.subcategoryName, libraryContext.docTypeName].filter(Boolean).join(' — ');
          libraryText = '\n\n# LIBRARY CONTEXT (' + ctLabel + ')\n\n' + libParts.join('\n\n');
        }
      }
      const chunks = await getAllChunks(matterId);
      const byDoc = chunksToDocMap(chunks);
      const systemBase = `You are a senior litigation counsel in ${jur} drafting a legal document for "${matterName}". Apply ${jur} law, procedure, and drafting conventions.\n${matterContext}${libraryText}`;
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
}
