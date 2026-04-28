/* EX LIBRIS JURIS v5.10c — analyseWorker.js (NEW FILE)
   Background follow-up processor. Called by api/followup.js
   (fire-and-forget) AND by api/cron-resume.js (every 2 minutes, for
   laptop-closed processing).

   v5.10c PURPOSE (27 Apr 2026):
   Self-contained follow-up worker. Mirrors what api/analyse.js does
   today (auth, retrieval, prompt assembly with focus notes, single
   Anthropic call, cost accounting, usage log) but is triggered by a
   tool_jobs row of tool_name = 'followup:<originalTool>' and writes
   results back to that row plus PATCHes the parent conversation_history
   row's followups[] array.

   This file deliberately does NOT import or modify api/worker.js. The
   worker.js refactor is a separate v5.11+ project. analyseWorker.js
   carries only the small subset of worker.js's machinery that
   follow-ups actually need: a single Anthropic call, no extraction,
   no condense, no sectioned synthesis.

   PRECONDITIONS (no migration needed):
     - tool_jobs table has matter_id, user_id, tool_name, status,
       instructions, parameters, result, error, input_tokens,
       output_tokens, cost_usd, started_at, completed_at, updated_at.
       All present as of v5.8a.

   STATUS CONVENTION (matches launches):
     'pending' -> 'running' -> 'complete' on success
                            \-> 'failed'   on error
   api/jobs.js returns `result` when status === 'complete' and `error`
   when status === 'failed'. The frontend reads exactly those.

   HEARTBEAT: updated_at is stamped on every status write so
   cron-resume.js can spot a stuck follow-up the same way it spots a
   stuck launch.

   createClient() is inside the handler per the standing rule about
   module-scope schema cache.
*/

import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

export const config = { maxDuration: 800 };

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const INPUT_COST_PER_M  = 3.00;
const OUTPUT_COST_PER_M = 15.00;

/* ─── helpers ─────────────────────────────────────────────────────── */

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
    return query.split(/\s+/).filter(w => w.length > 3).slice(0, 8);
  }
}

async function searchChunks(supabase, matterId, query, limit, focusDocNames) {
  limit = limit || 30;
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

/* PATCH the follow-up onto the parent conversation_history row's
   followups[] array. Mirrors what /api/history?id=...&PATCH does today
   when called from the frontend (sendToolFollowUpV2 v5.10b). The PATCH
   endpoint reads {question, answer, cost_usd, focus_doc_names} and
   appends an object to the row's followups JSONB.

   This implementation reads the row, appends, writes back. A race
   between two simultaneous follow-ups on the same parent row is
   theoretically possible but extremely rare (would require two
   workers completing within ms of each other for the same parent),
   and last-write-wins is acceptable per the project's broader rules.

   On any failure we fall back to inserting a fresh conversation_history
   row, mirroring the frontend's PATCH-then-POST fallback. The follow-up
   is never silently lost. */
async function appendFollowupToParent(supabase, mainRowId, fu, matterId, userId, toolLabelForFallback) {
  try {
    const { data: parent, error: selectErr } = await supabase
      .from("conversation_history")
      .select("id, followups")
      .eq("id", mainRowId)
      .single();
    if (selectErr || !parent) throw selectErr || new Error("parent row not found");

    const existing = Array.isArray(parent.followups) ? parent.followups : [];
    const next = existing.concat([{
      question:        fu.question,
      answer:          fu.answer,
      cost_usd:        fu.cost_usd,
      focus_doc_names: fu.focus_doc_names || [],
      sub_element:     fu.sub_element || "",
      freeform_focus:  fu.freeform_focus || "",
      created_at:      new Date().toISOString(),
    }]);

    const { error: updateErr } = await supabase
      .from("conversation_history")
      .update({ followups: next })
      .eq("id", mainRowId);
    if (updateErr) throw updateErr;
    return { saved: true, via: "patch" };
  } catch (e) {
    console.error("analyseWorker: PATCH fallback to insert. Reason:", e && e.message);
    try {
      await supabase.from("conversation_history").insert({
        matter_id: matterId,
        user_id:   userId,
        question:  toolLabelForFallback + " follow-up: " + (fu.question || "").slice(0, 80),
        answer:    fu.answer,
        tool_name: null,
      });
      return { saved: true, via: "insert-fallback" };
    } catch (e2) {
      console.error("analyseWorker: insert fallback ALSO failed:", e2 && e2.message);
      return { saved: false, via: null };
    }
  }
}

async function setStatus(supabase, jobId, patch) {
  /* updated_at is set on every status write so cron-resume.js sees a
     heartbeat and skips re-firing while we're alive. */
  patch.updated_at = new Date().toISOString();
  const { error } = await supabase
    .from("tool_jobs")
    .update(patch)
    .eq("id", jobId);
  if (error) console.error("analyseWorker setStatus error:", error.message);
}

/* ─── handler ─────────────────────────────────────────────────────── */

const SERVER_VERSION = "v5.10c";
export default async function handler(req, res) {
  console.log(SERVER_VERSION + " analyseWorker handler: " + (req.method || "?") + " " + (req.url || ""));
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const jobId = req.query?.jobId;
  if (!jobId) return res.status(400).json({ error: "jobId required" });

  /* Load the job row. Refuse to act on rows that are already complete or
     failed — that signals a duplicate fire (e.g. cron-resume after the
     first invocation already finished). */
  const { data: job, error: jobErr } = await supabase
    .from("tool_jobs")
    .select("id, matter_id, user_id, tool_name, status, instructions, parameters")
    .eq("id", jobId)
    .single();
  if (jobErr || !job) return res.status(404).json({ error: "Job not found" });
  if (job.status === "complete" || job.status === "failed") {
    console.log("analyseWorker: job " + jobId + " already in terminal status " + job.status + " — no-op");
    return res.status(200).json({ ok: true, status: job.status });
  }

  /* Mark running and stamp started_at if not already stamped. */
  const startPatch = { status: "running" };
  if (!job.started_at) startPatch.started_at = new Date().toISOString();
  await setStatus(supabase, jobId, startPatch);

  const p = job.parameters || {};
  const matterId    = job.matter_id;
  const userId      = job.user_id;
  const question    = p.question || job.instructions || "";
  const originalTool = p.originalTool || "";
  const focusDocNames = Array.isArray(p.focusDocNames) ? p.focusDocNames : [];
  const subElement    = p.subElement || "";
  const freeformFocus = p.freeformFocus || "";
  const mainRowId     = p.mainRowId || null;
  const currentResult = p.currentResult || "";
  const jurisdiction  = p.jurisdiction || "Bermuda";

  try {
    /* ─── retrieval (matches analyse.js v5.9a) ───────────────────── */
    let contextText = "";
    if (matterId) {
      const chunks = await searchChunks(supabase, matterId, question, 30, focusDocNames);
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

    /* ─── focus notes (matches analyse.js v5.9a) ─────────────────── */
    var focusDocNote = "";
    if (focusDocNames && focusDocNames.length > 0) {
      focusDocNote = "\nThe user has specifically asked you to focus your answer on the following documents: " + focusDocNames.join(", ") + ". Draw your answer primarily from passages in these documents, citing them by name.\n";
    }

    var subElementNote = "";
    if (subElement && typeof subElement === "string" && subElement.trim().length > 0) {
      subElementNote = "\nThe user has specifically asked you to narrow the analysis to the following sub-element of the parent result: " + subElement.trim() + ". Treat that sub-element as the focus of your answer rather than producing a broad survey.\n";
    }

    var freeformFocusNote = "";
    if (freeformFocus && typeof freeformFocus === "string" && freeformFocus.trim().length > 0) {
      freeformFocusNote = "\nThe user has provided the following additional focus instruction for this answer: " + freeformFocus.trim() + ". Honour this instruction in shaping the depth, scope, and emphasis of your response.\n";
    }

    const matterContext = [
      p.matterNature ? `Nature of the dispute: ${p.matterNature}` : "",
      p.matterIssues ? `Key issues in this matter: ${p.matterIssues}` : "",
      p.actingFor    ? `Acting for: ${p.actingFor}` : "",
    ].filter(Boolean).join("\n");

    /* ─── tool-context preamble appended to the user message ─────── */
    const toolLabel = originalTool ? originalTool.charAt(0).toUpperCase() + originalTool.slice(1) : "tool";
    const userMessage = question
      + "\n\n[Context: The user is viewing the " + toolLabel + " output for this matter. Answer their follow-up question in that context.]"
      + (currentResult ? "\n\n[Previous tool output summary (first 8000 chars):\n" + currentResult + "]" : "");

    /* ─── system prompt (matches analyse.js v5.9a) ───────────────── */
    const system = `You are a senior litigation counsel specialising in ${jurisdiction} offshore common law litigation. You have deep expertise in Bermuda, Cayman Islands and BVI law, court rules (RSC Bermuda, GCR Cayman, CPR BVI), statutes, company law, trust law, insolvency, and English common law precedent as applied offshore.

Matter: "${p.matterName || "Current Matter"}"
${matterContext ? `\n${matterContext}\n` : ""}${focusDocNote}${subElementNote}${freeformFocusNote}
${contextText ? `The following passages are retrieved from the matter documents as most relevant to this question. Refer to them specifically, quoting where helpful:\n\n${contextText}` : "No documents uploaded yet. Answer based on your legal knowledge."}

In every response:
1. Apply ${jurisdiction}-specific law — cite local statutes, court rules, and leading authority by name
2. Refer to document passages specifically, identifying which document they come from
3. Flag where ${jurisdiction} law diverges from English law or other offshore jurisdictions
4. Be precise — identify unsettled points and flag litigation risk
5. Use clear ## headings. Do not truncate your response.`;

    /* ─── single Anthropic call ──────────────────────────────────── */
    const response = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 16384,
      system,
      messages: [{ role: "user", content: userMessage }],
    });

    const resultText   = response.content?.find(b => b.type === "text")?.text || "";
    const inputTokens  = response.usage?.input_tokens  || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    const costUsd = (inputTokens * INPUT_COST_PER_M / 1_000_000) + (outputTokens * OUTPUT_COST_PER_M / 1_000_000);

    /* ─── persist result to tool_jobs ────────────────────────────── */
    await setStatus(supabase, jobId, {
      status: "complete",
      result: resultText,
      input_tokens:  inputTokens,
      output_tokens: outputTokens,
      cost_usd:      costUsd,
      completed_at:  new Date().toISOString(),
    });

    /* ─── PATCH parent conversation_history row (or fallback) ────── */
    if (mainRowId) {
      await appendFollowupToParent(supabase, mainRowId, {
        question:        question,
        answer:          resultText,
        cost_usd:        costUsd,
        focus_doc_names: focusDocNames,
        sub_element:     subElement,
        freeform_focus:  freeformFocus,
      }, matterId, userId, toolLabel);
    } else {
      /* No parent row id — write a separate history row so the work is
         not lost. Same shape as the frontend's old fallback. */
      try {
        await supabase.from("conversation_history").insert({
          matter_id: matterId,
          user_id:   userId,
          question:  toolLabel + " follow-up: " + question.slice(0, 80),
          answer:    resultText,
          tool_name: null,
        });
      } catch (e) {
        console.error("analyseWorker: separate history insert failed:", e && e.message);
      }
    }

    if (matterId) await logUsage(supabase, matterId, userId, "qa", inputTokens, outputTokens, costUsd);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("analyseWorker error:", err);
    await setStatus(supabase, jobId, {
      status: "failed",
      error: err && err.message ? err.message : "Follow-up processing failed",
      completed_at: new Date().toISOString(),
    });
    return res.status(500).json({ error: err && err.message ? err.message : "Follow-up failed" });
  }
}
