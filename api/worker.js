/* EX LIBRIS JURIS v4.2k — worker.js
   Background tool processor. Called by tools.js (fire-and-forget).
   Frontend-driven chaining: worker pauses with status="paused" or "synthesising"
   when time runs out. Frontend polls /api/jobs and re-fires /api/worker.

   v4.2k FIXES (7 Apr 2026):
   1. Final synthesis max_tokens reduced from 16000 to 10000. The 16000 ceiling
      allowed Claude to stream for >300s on dense legal content with 6+
      condensed summaries as input, blowing the Vercel function ceiling.
      10000 tokens is still ~30 pages, plenty for any Chronology output.
   2. Final synthesis call now logs start and end with elapsed time and token
      counts, so we can see if it gets close to the ceiling on future runs.

   v4.2k NOTE: This must be deployed alongside the v4.2k tools.js, which fixes
   the frontend over-firing bug. Without that fix, parallel worker invocations
   continue to waste Anthropic spend even though the chain works.

   v4.2j FIXES (carried forward) — the real fix:
   1. Supabase client created fresh per handler invocation (fresh schema cache).
   2. updateJob throws on error and verifies critical fields persisted.

   v4.2i FIXES (carried forward):
   - SYNTH_GROUP = 3, condense max_tokens = 10000.
   - Heavy console.log instrumentation around every condense call.

   v4.2h FIXES (carried forward):
   - Per-group DB persistence in condense loop.
   - Re-entry condition checks condense_done < extracts.length.
   - Condense time guard at 150s.

   v4.2g FIXES (carried forward):
   - Handler doesn't clobber status="synthesising"/"paused" on re-entry.
   - Condense pause path explicitly writes status="synthesising".

   PRECONDITION: tool_jobs table must have these columns:
     - condensed_extracts jsonb
     - condense_done integer DEFAULT 0
     - synthesis_phase text */

import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

export const config = { maxDuration: 300 };

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

/* v4.2j: Supabase client is created per-invocation inside the handler, not at
   module scope. Module-scope clients persist across invocations on warm Vercel
   functions, and supabase-js caches the PostgREST schema on first use. If the
   first invocation happened before a schema migration, the cached schema lacks
   the new columns and supabase-js silently strips them from UPDATE payloads
   with no error — which is exactly what bit us through v4.2g/h/i.

   The `supabase` binding is `let` so the handler can overwrite it at the start
   of every invocation. All helper functions read the current value, so they
   automatically use the fresh client. */
let supabase = createClient(supabaseUrl, supabaseKey);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const INPUT_COST_PER_M = 3.00;
const OUTPUT_COST_PER_M = 15.00;
const TIME_LIMIT_MS = 250000;
const PARALLEL = 6;

/* ══════════════════════════════════════════════════════════════════════════
   SHARED HELPERS (moved from tools.js v3.3 — identical logic)
   ══════════════════════════════════════════════════════════════════════════ */

async function getAllChunks(matterId, docTypes, limit) {
  docTypes = docTypes || null;
  limit = limit || 1500;
  var query = supabase.from("chunks")
    .select("content, document_name, doc_type, chunk_index, page_number")
    .eq("matter_id", matterId)
    .order("chunk_index", { ascending: true })
    .limit(limit);
  if (docTypes && docTypes.length > 0) query = query.in("doc_type", docTypes);
  var resp = await query;
  if (resp.error) throw new Error("Chunk fetch failed: " + resp.error.message);
  return resp.data || [];
}

/* v3.4: Filter out excluded documents */
function filterExcluded(chunks, excludeDocNames) {
  if (!excludeDocNames || excludeDocNames.length === 0) return chunks;
  return chunks.filter(function(c) { return excludeDocNames.indexOf(c.document_name) === -1; });
}

function chunksToDocMap(chunks) {
  var byDoc = {};
  for (var i = 0; i < chunks.length; i++) {
    var c = chunks[i];
    if (!byDoc[c.document_name]) byDoc[c.document_name] = { type: c.doc_type, text: "", pages: [] };
    byDoc[c.document_name].text += c.content + "\n\n";
    if (c.page_number != null) {
      byDoc[c.document_name].pages.push({ chunkIndex: c.chunk_index, page: c.page_number, snippet: c.content.slice(0, 80) });
    }
  }
  return byDoc;
}

function batchDocs(byDoc, maxChars) {
  maxChars = maxChars || 100000;
  var batches = [];
  var current = {};
  var currentSize = 0;
  var entries = Object.entries(byDoc);
  for (var i = 0; i < entries.length; i++) {
    var name = entries[i][0];
    var data = entries[i][1];
    var truncated = data.text.length > 80000 ? data.text.slice(0, 80000) + "\n[...truncated for processing...]" : data.text;
    var docData = { type: data.type, text: truncated, pages: data.pages };
    var docSize = truncated.length + name.length + 50;
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
  return Object.entries(byDoc).map(function(entry) {
    var n = entry[0];
    var d = entry[1];
    var header = "=== " + n + " [" + d.type + "] ===";
    if (d.pages && d.pages.length > 0) {
      var pageRange = d.pages.map(function(p) { return p.page; });
      header += " (pages " + Math.min.apply(null, pageRange) + "\u2013" + Math.max.apply(null, pageRange) + ")";
    }
    return header + "\n" + d.text;
  }).join("\n\n");
}

function buildPageIndex(byDoc) {
  var lines = [];
  var entries = Object.entries(byDoc);
  for (var i = 0; i < entries.length; i++) {
    var name = entries[i][0];
    var data = entries[i][1];
    if (data.pages && data.pages.length > 0) {
      var grouped = {};
      for (var j = 0; j < data.pages.length; j++) {
        var p = data.pages[j];
        if (!grouped[p.page]) grouped[p.page] = [];
        grouped[p.page].push(p.chunkIndex + 1);
      }
      var refs = Object.entries(grouped).map(function(e) { return "p." + e[0] + " (\u00b6" + e[1].join(",") + ")"; }).join(", ");
      lines.push(name + ": " + refs);
    }
  }
  return lines.length > 0 ? "\n\nPAGE REFERENCE INDEX:\n" + lines.join("\n") : "";
}

async function runTool(system, userPrompt, maxTokens) {
  /* v4.1: raised from 8192 to API max — synthesis of large matters was truncating */
  /* v4.1b: switched to streaming to avoid Anthropic 10-minute timeout on large outputs */
  maxTokens = maxTokens || 64000;
  var stream = anthropic.messages.stream({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: maxTokens,
    system: system,
    messages: [{ role: "user", content: userPrompt }],
  });
  var finalMessage = await stream.finalMessage();
  var text = "";
  if (finalMessage.content) {
    for (var i = 0; i < finalMessage.content.length; i++) {
      if (finalMessage.content[i].type === "text") { text = finalMessage.content[i].text; break; }
    }
  }
  var inputTokens = (finalMessage.usage && finalMessage.usage.input_tokens) || 0;
  var outputTokens = (finalMessage.usage && finalMessage.usage.output_tokens) || 0;
  var cost = (inputTokens * INPUT_COST_PER_M / 1000000) + (outputTokens * OUTPUT_COST_PER_M / 1000000);
  return { text: text, inputTokens: inputTokens, outputTokens: outputTokens, cost: cost };
}

async function logUsage(matterId, userId, toolName, inputTokens, outputTokens, cost) {
  try {
    await supabase.from("usage_log").insert({
      matter_id: matterId, user_id: userId, tool_name: toolName,
      input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: cost,
    });
  } catch (e) { console.error("Usage log error:", e); }
}

async function saveHistory(matterId, userId, question, answer, toolName) {
  try {
    await supabase.from("conversation_history").insert({
      matter_id: matterId, user_id: userId,
      question: question, answer: answer, tool_name: toolName,
    });
  } catch (e) { console.error("History save error:", e); }
}

function formatCourtHeading(h) {
  if (!h || (!h.court && !h.party1)) return "";
  var lines = [];
  if (h.court) lines.push(h.court);
  if (h.caseNo) lines.push(h.caseNo);
  lines.push("");
  lines.push("BETWEEN:");
  lines.push("");
  if (h.party1) lines.push(h.party1 + (h.party1Role ? "          " + h.party1Role : ""));
  lines.push("\u2014 and \u2014");
  if (h.party2) lines.push(h.party2 + (h.party2Role ? "          " + h.party2Role : ""));
  if (h.docTitle) {
    lines.push("");
    lines.push("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
    lines.push(h.docTitle);
    lines.push("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
  }
  lines.push("");
  return lines.join("\n");
}

/* ══════════════════════════════════════════════════════════════════════════
   JOB MANAGEMENT
   ══════════════════════════════════════════════════════════════════════════ */

/* v4.2j: updateJob now throws on error instead of swallowing. It also chains
   .select() to force a round-trip that returns the updated row, so we can
   verify critical fields actually persisted. Previously updateJob logged errors
   to console.error but returned normally, so a silent failure (stale schema
   cache stripping columns, for example) looked identical to success.

   Strict field verification is limited to a whitelist of fields where a
   mismatch would be catastrophic. Timestamp and numeric fields are omitted
   because Postgres normalises them on return and the string comparison would
   report false positives. */
var CRITICAL_FIELDS = {
  condensed_extracts: true,
  condense_done: true,
  status: true,
  batches_done: true,
};

async function updateJob(jobId, fields) {
  var resp = await supabase
    .from("tool_jobs")
    .update(fields)
    .eq("id", jobId)
    .select();
  if (resp.error) {
    console.error("Job update error for " + jobId + ":", resp.error.message);
    throw new Error("updateJob failed: " + resp.error.message);
  }
  if (!resp.data || resp.data.length === 0) {
    console.error("Job update returned no rows for " + jobId + " — row missing or RLS blocking");
    throw new Error("updateJob returned no rows for " + jobId);
  }
  /* Verify critical fields actually persisted. If supabase-js silently strips
     an unknown column from the payload (stale schema cache), the returned row
     will still have the old value — this check catches that. */
  var returned = resp.data[0];
  var mismatch = [];
  for (var k in fields) {
    if (fields.hasOwnProperty(k) && CRITICAL_FIELDS[k]) {
      var expected = JSON.stringify(fields[k]);
      var actual = JSON.stringify(returned[k]);
      if (expected !== actual) {
        var expectedShort = expected.length > 80 ? expected.slice(0, 80) + "..." : expected;
        var actualShort = actual.length > 80 ? actual.slice(0, 80) + "..." : actual;
        mismatch.push(k + " expected=" + expectedShort + " got=" + actualShort);
      }
    }
  }
  if (mismatch.length > 0) {
    console.error("Job update critical fields did not persist for " + jobId + ": " + mismatch.join("; "));
    throw new Error("updateJob field mismatch: " + mismatch.join("; "));
  }
  return returned;
}

async function failJob(jobId, errorMsg) {
  await updateJob(jobId, { status: "failed", error: errorMsg, completed_at: new Date().toISOString() });
}

/* ══════════════════════════════════════════════════════════════════════════
   BATCHED RUNNER (v4.2e: frontend-driven chaining)
   Processes extraction batches within time limit. If time runs out, saves
   progress and sets status to "paused". Frontend polls, detects "paused",
   and calls /api/worker again. No server-to-server chaining.
   Returns null if paused/synthesising (caller should return response and stop).
   ══════════════════════════════════════════════════════════════════════════ */

async function runBatchedChained(jobId, job, systemBase, extractPromptFn, synthPromptFn, byDoc, hostUrl) {
  var batches = batchDocs(byDoc);
  var startTime = Date.now();

  /* Resume from previous invocation */
  var batchesDone = job.batches_done || 0;
  var extracts = [];
  try {
    if (job.extracts && Array.isArray(job.extracts)) extracts = job.extracts;
  } catch (e) { extracts = []; }
  var totalInput = job.input_tokens || 0;
  var totalOutput = job.output_tokens || 0;
  var totalCost = parseFloat(job.cost_usd) || 0;

  /* v4.2e: If status is "synthesising", skip extraction — go straight to synthesis */
  if (job.status === "synthesising") {
    console.log("Worker: running synthesis for " + jobId + " (" + extracts.length + " extracts)");

    /* v4.2f: Two-stage synthesis for large jobs.
       v4.2i: SYNTH_GROUP reduced from 5 to 3 and condense max_tokens reduced
       from 16000 to 10000. Diagnostic data from v4.2h showed that a single
       condense call on 5 dense extracts was exceeding the 300s Vercel ceiling
       before any per-group save could happen, so condensed_extracts stayed null
       and condense_done stayed at 0 forever. Smaller groups + smaller output
       ceiling should make each call complete in 30-60s. */
    var SYNTH_GROUP = 3;
    var CONDENSE_MAX_TOKENS = 10000;
    var condensed = job.condensed_extracts || null;
    var condenseDoneFromDb = job.condense_done || 0;
    var needsCondense = extracts.length > SYNTH_GROUP && condenseDoneFromDb < extracts.length;

    if (needsCondense) {
      /* Stage 1: condense extracts in groups.
         v4.2h: re-entry safe — uses condense_done from DB to know where to resume.
         The previous version (`if !condensed`) skipped the loop entirely on re-entry,
         leaving final synthesis to run with only the partial condensed array. */
      if (!condensed) condensed = [];
      var condenseDone = condenseDoneFromDb;
      console.log("v4.2i Worker: condensing " + extracts.length + " extracts in groups of " + SYNTH_GROUP + " (starting from group " + condenseDone + ", " + condensed.length + " already done)");

      /* v4.2h: Tightened time guard. A single condense call should now take
         30-60s. Allow at most ~150s elapsed before pausing — leaves a 150s
         safety margin for the in-flight call to finish before Vercel's 300s kill. */
      var CONDENSE_TIME_LIMIT_MS = 150000;

      for (var gi = condenseDone; gi < extracts.length; gi += SYNTH_GROUP) {
        var elapsedSec = Math.round((Date.now() - startTime) / 1000);
        if (Date.now() - startTime > CONDENSE_TIME_LIMIT_MS) {
          console.log("v4.2i Worker: condense paused at group " + gi + " (" + elapsedSec + "s elapsed)");
          await updateJob(jobId, {
            condensed_extracts: condensed,
            condense_done: gi,
            status: "synthesising",
            input_tokens: totalInput,
            output_tokens: totalOutput,
            cost_usd: totalCost,
          });
          return null; /* v4.2g: status explicitly set to synthesising — frontend will re-fire */
        }

        var group = extracts.slice(gi, gi + SYNTH_GROUP);
        var groupText = group.map(function(e, idx) { return "=== BATCH " + (gi + idx + 1) + " FINDINGS ===\n" + e; }).join("\n\n");

        console.log("v4.2i Worker: starting condense call for group " + gi + " (" + group.length + " extracts, " + groupText.length + " chars input, " + elapsedSec + "s elapsed)");
        var condenseCallStart = Date.now();

        var condenseResult;
        try {
          condenseResult = await runTool(systemBase,
            "Condense these extraction findings into a comprehensive summary. Preserve ALL key facts, dates, names, document references, and evidence. Do not omit anything significant.\n\nFINDINGS:\n\n" + groupText,
            CONDENSE_MAX_TOKENS
          );
        } catch (condenseErr) {
          console.log("v4.2i Worker: CONDENSE CALL FAILED at group " + gi + " after " + Math.round((Date.now() - condenseCallStart) / 1000) + "s: " + condenseErr.message);
          /* Save what we have so far so the next invocation can resume */
          await updateJob(jobId, {
            condensed_extracts: condensed,
            condense_done: gi,
            status: "synthesising",
            input_tokens: totalInput,
            output_tokens: totalOutput,
            cost_usd: totalCost,
            error: "Condense group " + gi + " failed: " + condenseErr.message,
          });
          throw condenseErr;
        }

        var condenseCallSec = Math.round((Date.now() - condenseCallStart) / 1000);
        console.log("v4.2i Worker: condense call for group " + gi + " returned in " + condenseCallSec + "s, output " + (condenseResult.text ? condenseResult.text.length : 0) + " chars, " + condenseResult.outputTokens + " tokens");

        condensed.push(condenseResult.text);
        totalInput += condenseResult.inputTokens;
        totalOutput += condenseResult.outputTokens;
        totalCost += condenseResult.cost;

        /* v4.2h: Persist progress after EVERY successful group. If Vercel kills
           the function during the next iteration's condense call, the work
           already completed survives and the next invocation resumes from here. */
        console.log("v4.2i Worker: writing progress to DB after group " + gi + " (condense_done=" + (gi + SYNTH_GROUP) + ", condensed.length=" + condensed.length + ")");
        await updateJob(jobId, {
          condensed_extracts: condensed,
          condense_done: gi + SYNTH_GROUP,
          status: "synthesising",
          input_tokens: totalInput,
          output_tokens: totalOutput,
          cost_usd: totalCost,
        });
        console.log("v4.2i Worker: DB write complete for group " + gi + ", total elapsed " + Math.round((Date.now() - startTime) / 1000) + "s");
      }

      /* Save condensed extracts — if time is short, set synthesising and chain */
      if (Date.now() - startTime > TIME_LIMIT_MS) {
        console.log("Worker: condense done, setting synthesising before final synthesis");
        await updateJob(jobId, {
          condensed_extracts: condensed,
          condense_done: extracts.length,
          input_tokens: totalInput,
          output_tokens: totalOutput,
          cost_usd: totalCost,
          status: "synthesising",
        });
        fetch(hostUrl + "/api/worker?jobId=" + jobId, {
          method: "POST", headers: { "Content-Type": "application/json" }
        }).catch(function(ce) { console.log("Chain attempt:", ce.message); });
        await new Promise(function(r) { setTimeout(r, 2000); });
        return null;
      }
    }

    /* Stage 2 (or single stage for small jobs): final synthesis */
    var synthInput;
    if (condensed && condensed.length > 0) {
      synthInput = condensed.map(function(e, idx) { return "=== SUMMARY " + (idx + 1) + " ===\n" + e; }).join("\n\n");
      console.log("Worker: final synthesis from " + condensed.length + " condensed summaries");
    } else {
      synthInput = extracts.map(function(e, idx) { return "=== BATCH " + (idx + 1) + " FINDINGS ===\n" + e; }).join("\n\n");
      console.log("Worker: direct synthesis from " + extracts.length + " extracts");
    }

    /* Stage 2 (or single stage for small jobs): final synthesis.
       v4.2k: max_tokens lowered from 16000 to 10000. The 16000 ceiling allowed
       Claude to stream for >300s on dense legal content with 6 condensed
       summaries as input, blowing the Vercel function ceiling. 10000 tokens is
       still ~30 pages of output, which should comfortably cover any Chronology. */
    var synthCallStart = Date.now();
    console.log("v4.2k Worker: starting final synthesis call");
    var synthResult = await runTool(systemBase, synthPromptFn(synthInput, batches.length), 10000);
    console.log("v4.2k Worker: final synthesis returned in " + Math.round((Date.now() - synthCallStart) / 1000) + "s, output " + (synthResult.text ? synthResult.text.length : 0) + " chars, " + synthResult.outputTokens + " tokens");
    totalInput += synthResult.inputTokens;
    totalOutput += synthResult.outputTokens;
    totalCost += synthResult.cost;
    return { text: synthResult.text, inputTokens: totalInput, outputTokens: totalOutput, cost: totalCost, done: true };
  }

  await updateJob(jobId, {
    batches_total: batches.length,
    batches_done: batchesDone,
    status: "running",
    started_at: job.started_at || new Date().toISOString(),
  });

  /* Single-batch shortcut: no extraction phase needed */
  if (batches.length === 1 && batchesDone === 0) {
    var r = await runTool(systemBase, synthPromptFn(docsToText(batches[0]), null));
    return {
      text: r.text,
      inputTokens: totalInput + r.inputTokens,
      outputTokens: totalOutput + r.outputTokens,
      cost: totalCost + r.cost,
      done: true,
    };
  }

  /* Multi-batch: extraction phase — process from where we left off */
  for (var i = batchesDone; i < batches.length; i += PARALLEL) {
    /* Time guard: save progress and chain to next invocation */
    if (Date.now() - startTime > TIME_LIMIT_MS) {
      console.log("Worker chain: processed batches 1-" + i + " of " + batches.length + ", chaining (" + Math.round((Date.now() - startTime) / 1000) + "s elapsed)");
      await updateJob(jobId, {
        batches_done: i,
        extracts: extracts,
        input_tokens: totalInput,
        output_tokens: totalOutput,
        cost_usd: totalCost,
      });
      /* v4.2f: Hybrid chaining — try server-side chain first (works with laptop closed),
         frontend polling is backup if the chain fetch gets killed by Vercel. */
      await updateJob(jobId, { status: "paused" });
      console.log("Worker: paused at batch " + i + " of " + batches.length);
      fetch(hostUrl + "/api/worker?jobId=" + jobId, {
        method: "POST", headers: { "Content-Type": "application/json" }
      }).catch(function(ce) { console.log("Chain attempt (frontend will retry if needed):", ce.message); });
      await new Promise(function(r) { setTimeout(r, 2000); });
      return null; /* null means paused, not done */
    }

    var slice = batches.slice(i, i + PARALLEL);
    var results = await Promise.all(slice.map(function(batch, j) {
      var batchText = docsToText(batch);
      return runTool(systemBase, extractPromptFn(batchText, i + j + 1, batches.length), 4096);
    }));
    for (var ri = 0; ri < results.length; ri++) {
      extracts.push(results[ri].text);
      totalInput += results[ri].inputTokens;
      totalOutput += results[ri].outputTokens;
      totalCost += results[ri].cost;
    }
    batchesDone = Math.min(i + PARALLEL, batches.length);

    /* Update progress so frontend polling can show it */
    await updateJob(jobId, {
      batches_done: batchesDone,
      input_tokens: totalInput,
      output_tokens: totalOutput,
      cost_usd: totalCost,
    });
  }

  /* v4.2f: All extraction done. Set "synthesising" and try server-side chain.
     Frontend polling is backup if the chain fetch gets killed. */
  if (Date.now() - startTime > 10000) {
    console.log("Worker: extraction done (" + batches.length + " batches, " + Math.round((Date.now() - startTime) / 1000) + "s elapsed), setting synthesising");
    await updateJob(jobId, {
      batches_done: batches.length,
      extracts: extracts,
      input_tokens: totalInput,
      output_tokens: totalOutput,
      cost_usd: totalCost,
      status: "synthesising",
    });
    fetch(hostUrl + "/api/worker?jobId=" + jobId, {
      method: "POST", headers: { "Content-Type": "application/json" }
    }).catch(function(ce) { console.log("Chain attempt (frontend will retry if needed):", ce.message); });
    await new Promise(function(r) { setTimeout(r, 2000); });
    return null;
  }

  /* Enough time remaining — run synthesis directly.
     v4.2k: max_tokens lowered from 16000 to 10000 to ensure single-call completion
     within Vercel's 300s ceiling. */
  var combinedExtracts = extracts.map(function(e, idx) { return "=== BATCH " + (idx + 1) + " FINDINGS ===\n" + e; }).join("\n\n");
  var synthResult = await runTool(systemBase, synthPromptFn(combinedExtracts, batches.length), 10000);
  totalInput += synthResult.inputTokens;
  totalOutput += synthResult.outputTokens;
  totalCost += synthResult.cost;

  return { text: synthResult.text, inputTokens: totalInput, outputTokens: totalOutput, cost: totalCost, done: true };
}

/* ══════════════════════════════════════════════════════════════════════════
   MAIN HANDLER
   v3.4.1 FIX: Response is sent AFTER processing, not before. Vercel keeps
   the function alive as long as the response has not been sent.
   ══════════════════════════════════════════════════════════════════════════ */

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  var jobId = req.query.jobId;
  if (!jobId) return res.status(400).json({ error: "jobId required" });

  /* v4.2j: Fresh Supabase client for this invocation. Overwrites the module-level
     binding so every helper in this file uses the new client without needing a
     signature change. Fresh client = fresh PostgREST schema cache. */
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log("v4.2j Worker: fresh supabase client created for job " + jobId);

  try {
    /* Load job */
    var jobResp = await supabase.from("tool_jobs").select("*").eq("id", jobId).single();
    if (jobResp.error || !jobResp.data) {
      console.error("Job load error:", jobResp.error && jobResp.error.message);
      return res.status(404).json({ error: "Job not found" });
    }
    var job = jobResp.data;

    if (job.status === "complete" || job.status === "failed") {
      console.log("Job already finished: " + jobId);
      return res.status(200).json({ ok: true, status: "already_done" });
    }
    /* v4.2e: "paused" and "synthesising" are valid — worker should continue */

    var hostUrl = "https://" + req.headers.host;
    var matterId = job.matter_id;
    var userId = job.user_id;
    var tool = job.tool_name;
    var instructions = job.instructions || "";
    var p = job.parameters || {};
    var jur = p.jurisdiction || "Bermuda";
    var matterName = p.matterName || "";
    var actingFor = p.actingFor || "";
    var excludeDocNames = p.excludeDocNames || [];

    var matterContext = [
      p.matterNature ? "Nature of the dispute: " + p.matterNature : "",
      p.matterIssues ? "Key issues: " + p.matterIssues : "",
      actingFor ? "Acting for: " + actingFor : "",
    ].filter(Boolean).join("\n");

    /* Get court heading */
    var heading = p.courtHeading || null;
    if (!heading) {
      try {
        var matterResp = await supabase.from("matters").select("heading_data").eq("id", matterId).single();
        if (matterResp.data && matterResp.data.heading_data && (matterResp.data.heading_data.court || matterResp.data.heading_data.party1)) {
          heading = matterResp.data.heading_data;
        }
      } catch (e) { /* no heading */ }
    }
    var headingText = heading ? formatCourtHeading(heading) : "";

    /* v4.2g: Do not clobber an in-progress synthesising/paused status on re-entry.
       The worker is re-fired by the frontend when status is "paused" or "synthesising";
       overwriting it back to "running" here would prevent the next pause from being
       visible to the frontend, breaking the chain. */
    var statusUpdate = { started_at: job.started_at || new Date().toISOString() };
    if (job.status !== "synthesising" && job.status !== "paused") {
      statusUpdate.status = "running";
    }
    await updateJob(jobId, statusUpdate);

    var result = "";
    var inputTokens = 0;
    var outputTokens = 0;
    var cost = 0;

    /* ── PROPOSITION EVIDENCE FINDER ───────────────────────────────────── */
    if (tool === "proposition") {
      var chunks = filterExcluded(await getAllChunks(matterId), excludeDocNames);
      var byDoc = chunksToDocMap(chunks);
      var pageIndex = buildPageIndex(byDoc);
      var systemBase = "You are a senior litigation counsel in " + jur + " conducting an evidence assessment for the matter \"" + matterName + "\".\n" + matterContext;
      var r = await runBatchedChained(jobId, job, systemBase,
        function(batchText, batchNum, total) { return "PROPOSITION: \"" + instructions + "\"\n\nBatch " + batchNum + " of " + total + ". Extract ALL relevant passages \u2014 supporting, contradicting, or neutral.\n\nFor each:\n### [Document] \u2014 [Brief description]\nGRADE: [1-5]\n[Relevant passage]\n**Analysis:** [Relevance to proposition]\n**Reference:** [page and paragraph if available]\n\nGrading: 5=strong direct, 4=good supportive, 3=moderate indirect, 2=weak tangential, 1=contrary" + pageIndex + "\n\nDOCUMENTS:\n\n" + batchText; },
        function(combined, numBatches) { return numBatches ? "PROPOSITION: \"" + instructions + "\"\n\nSynthesise findings from " + numBatches + " batches into a single evidence assessment.\n\nRetain format:\n### [Document] \u2014 [Description]\nGRADE: [1-5]\n[Passage]\n**Analysis:** [Relevance]\n**Reference:** [page and paragraph]\n\nThen:\n## Overall Assessment\nStrength of evidence for/against and view on balance of probabilities.\n\n\u26A0\uFE0F Professional Caution: AI-generated analysis. Verify all passages before reliance.\n\nFINDINGS:\n\n" + combined : "PROPOSITION: \"" + instructions + "\"\n\nFind ALL evidence \u2014 supporting, contradicting, or neutral.\n\n### [Document] \u2014 [Description]\nGRADE: [1-5] (5=strong direct, 4=good supportive, 3=moderate indirect, 2=weak tangential, 1=contrary)\n[Relevant passage]\n**Analysis:** [Relevance]\n**Reference:** [page and paragraph if available]\n\n## Overall Assessment\nSummary and preliminary view.\n\n\u26A0\uFE0F Professional Caution: AI-generated. Verify all passages before reliance." + pageIndex + "\n\nDOCUMENTS:\n\n" + combined; },
        byDoc, hostUrl
      );
      if (r === null) return res.status(200).json({ ok: true, status: "continuing" });
      result = r.text; inputTokens = r.inputTokens; outputTokens = r.outputTokens; cost = r.cost;
    }

    /* ── INCONSISTENCY TRACKER ─────────────────────────────────────────── */
    else if (tool === "inconsistency") {
      var chunks = filterExcluded(await getAllChunks(matterId), excludeDocNames);
      var byDoc = chunksToDocMap(chunks);
      var anchorDocs = {};
      var otherDocs = {};
      var anchorDocNames = p.anchorDocNames || [];
      var entries = Object.entries(byDoc);
      for (var ei = 0; ei < entries.length; ei++) {
        if (anchorDocNames.indexOf(entries[ei][0]) !== -1) anchorDocs[entries[ei][0]] = entries[ei][1];
        else otherDocs[entries[ei][0]] = entries[ei][1];
      }
      if (Object.keys(anchorDocs).length === 0) {
        var mid = Math.ceil(entries.length / 2);
        anchorDocs = Object.fromEntries(entries.slice(0, mid));
        otherDocs = Object.fromEntries(entries.slice(mid));
      }
      var systemBase = "You are a senior litigation counsel conducting forensic inconsistency analysis for \"" + matterName + "\" in " + jur + ".\n" + matterContext;
      var anchorText = docsToText(anchorDocs);
      if (anchorText.length > 40000) anchorText = anchorText.slice(0, 40000) + "\n[...anchor truncated...]";
      var otherBatches = batchDocs(otherDocs);
      var allFindings = [];
      var totalInput = job.input_tokens || 0;
      var totalOutput = job.output_tokens || 0;
      var totalCost = parseFloat(job.cost_usd) || 0;
      var startTime = Date.now();

      /* Resume support */
      var batchesDone = job.batches_done || 0;
      try { if (job.extracts && Array.isArray(job.extracts)) allFindings = job.extracts; } catch (e) {}

      await updateJob(jobId, { batches_total: otherBatches.length + 1, batches_done: batchesDone, status: "running", started_at: job.started_at || new Date().toISOString() });

      var INCON_PARALLEL = 2;
      for (var ii = batchesDone; ii < otherBatches.length; ii += INCON_PARALLEL) {
        if (Date.now() - startTime > TIME_LIMIT_MS) {
          await updateJob(jobId, { batches_done: ii, extracts: allFindings, input_tokens: totalInput, output_tokens: totalOutput, cost_usd: totalCost, status: "paused" });
          console.log("Worker: inconsistency paused at batch " + ii);
          fetch(hostUrl + "/api/worker?jobId=" + jobId, { method: "POST", headers: { "Content-Type": "application/json" } }).catch(function(ce) { console.log("Chain attempt:", ce.message); });
          await new Promise(function(r) { setTimeout(r, 2000); });
          return res.status(200).json({ ok: true, status: "paused" });
        }
        var slice = otherBatches.slice(ii, ii + INCON_PARALLEL);
        var results = await Promise.all(slice.map(function(batch, j) {
          return runTool(systemBase,
            "Find every inconsistency between ANCHOR DOCUMENTS and this batch.\n\n### [N]. [Description]\n**Anchor:** [Document and passage, with page reference if available]\n**Contradiction:** [Document and passage, with page reference if available]\n**Significance:** CRITICAL / SIGNIFICANT / MINOR\n**Tactical note:** [How to use or address]\n\nANCHOR:\n\n" + anchorText + "\n\nOTHER (batch " + (ii + j + 1) + "/" + otherBatches.length + "):\n\n" + docsToText(batch) + "\n\n" + (instructions ? "Instructions: " + instructions : ""),
            4096
          );
        }));
        for (var ri = 0; ri < results.length; ri++) {
          allFindings.push(results[ri].text);
          totalInput += results[ri].inputTokens; totalOutput += results[ri].outputTokens; totalCost += results[ri].cost;
        }
        batchesDone = Math.min(ii + INCON_PARALLEL, otherBatches.length);
        await updateJob(jobId, { batches_done: batchesDone, input_tokens: totalInput, output_tokens: totalOutput, cost_usd: totalCost });
      }

      if (allFindings.length === 1) {
        result = allFindings[0] + "\n\n\u26A0\uFE0F Professional Caution: AI-generated analysis. Verify quotations before reliance.";
      } else {
        if (Date.now() - startTime > TIME_LIMIT_MS) {
          await updateJob(jobId, { batches_done: otherBatches.length, extracts: allFindings, input_tokens: totalInput, output_tokens: totalOutput, cost_usd: totalCost, status: "synthesising" });
          console.log("Worker: inconsistency extraction done, set synthesising");
          fetch(hostUrl + "/api/worker?jobId=" + jobId, { method: "POST", headers: { "Content-Type": "application/json" } }).catch(function(ce) { console.log("Chain attempt:", ce.message); });
          await new Promise(function(r) { setTimeout(r, 2000); });
          return res.status(200).json({ ok: true, status: "synthesising" });
        }
        var synth = await runTool(systemBase,
          "Consolidate these inconsistency findings, remove duplicates, sort by significance (CRITICAL first).\n\nEnd with:\n## Summary\nOverall factual assessment.\n\n\u26A0\uFE0F Professional Caution: AI-generated. Verify quotations before reliance.\n\nFINDINGS:\n\n" + allFindings.map(function(f, fi) { return "=== BATCH " + (fi + 1) + " ===\n" + f; }).join("\n\n")
        );
        result = synth.text;
        totalInput += synth.inputTokens; totalOutput += synth.outputTokens; totalCost += synth.cost;
      }
      inputTokens = totalInput; outputTokens = totalOutput; cost = totalCost;
    }

    /* ── CHRONOLOGY ────────────────────────────────────────────────────── */
    else if (tool === "chronology") {
      var chunks = filterExcluded(await getAllChunks(matterId), excludeDocNames);
      var byDoc = chunksToDocMap(chunks);
      var pageIndex = buildPageIndex(byDoc);

      var chronoInstructions = instructions || "";
      if (p.chronologyDateRange) chronoInstructions += "\n\nDATE RANGE FILTER: Only include events within the date range: " + p.chronologyDateRange + ". Exclude all events outside this range.";
      if (p.chronologyEntities && p.chronologyEntities.trim()) chronoInstructions += "\n\nENTITY FOCUS: Focus specifically on these individuals or entities: " + p.chronologyEntities + ". Include only events directly involving or relevant to them. Title the output \"Documents Relevant to " + p.chronologyEntities + "\".";
      if (p.chronologyCorrespondenceFilter) chronoInstructions += "\n\nCORRESPONDENCE FILTER: Only include correspondence (letters, emails) if the letter or email is specifically referred to, quoted, or exhibited in a pleading, petition, or affidavit in the matter. Exclude correspondence that is not referenced in a sworn statement or pleading.";

      var focusBlock = chronoInstructions.trim() ? "Focus/Filters: " + chronoInstructions.trim() + "\n\n" : "";
      var entityTitle = (p.chronologyEntities && p.chronologyEntities.trim()) ? "Documents Relevant to " + p.chronologyEntities.trim() : "Chronology \u2014 " + matterName;

      var systemBase = "You are a senior litigation counsel constructing a comprehensive chronology for \"" + matterName + "\" in " + jur + ".\n" + matterContext;
      var r = await runBatchedChained(jobId, job, systemBase,
        function(batchText, batchNum, total) { return "Extract EVERY date and event from batch " + batchNum + " of " + total + ". Be exhaustive.\n\n**[DATE]** \u2014 [Event] *(Source: [document], p.[page number] \u00b6[paragraph])* \n\nInclude page and paragraph references where available. Flag conflicts: **[DATE] (DISPUTED)**\n\n" + focusBlock + "DOCUMENTS:\n\n" + batchText + pageIndex; },
        function(combined, numBatches) { return numBatches ? "Synthesise chronology from " + numBatches + " batches into a single de-duplicated chronology sorted by date.\n\n## " + entityTitle + "\n\n**[DATE]** \u2014 [Event] *(Source: [document], p.[page] \u00b6[paragraph])*\n\nGroup by year. Flag disputed dates. Include page and paragraph references.\n\n## Key Dates Summary\nThe 10-15 most significant dates.\n\n\u26A0\uFE0F Professional Caution: AI-generated chronology. Verify all dates before reliance.\n\n" + focusBlock + "EXTRACTS:\n\n" + combined : "Construct a complete chronology. Be exhaustive.\n\n## " + entityTitle + "\n\n**[DATE]** \u2014 [Event] *(Source: [document], p.[page] \u00b6[paragraph])*\n\nAll date formats. Flag disputed dates. Include page and paragraph references where available.\n\n## Key Dates Summary\n\n\u26A0\uFE0F Professional Caution: AI-generated. Verify all dates before reliance.\n\n" + focusBlock + "DOCUMENTS:\n\n" + combined + pageIndex; },
        byDoc, hostUrl
      );
      if (r === null) return res.status(200).json({ ok: true, status: "continuing" });
      result = r.text; inputTokens = r.inputTokens; outputTokens = r.outputTokens; cost = r.cost;
    }

    /* ── DRAMATIS PERSONAE ─────────────────────────────────────────────── */
    else if (tool === "persons") {
      var chunks = filterExcluded(await getAllChunks(matterId), excludeDocNames);
      var byDoc = chunksToDocMap(chunks);
      var pageIndex = buildPageIndex(byDoc);
      var systemBase = "You are a senior litigation counsel compiling a dramatis personae for \"" + matterName + "\" in " + jur + ".\n" + matterContext;
      var r = await runBatchedChained(jobId, job, systemBase,
        function(batchText, batchNum, total) { return "Extract EVERY person and entity from batch " + batchNum + " of " + total + ".\n\nEXCLUDE: Do NOT include attorneys, counsel, solicitors, barristers or legal representatives acting in the proceedings. Do NOT include the Judge, Master, Registrar, or Justices of Appeal.\n\nFor each person or entity:\n### [Name]\n**Description:** [A concise description of who this person/entity is and their relevance to the proceedings]\n**References in pleadings/petitions:** [List each reference with document name, page and paragraph]\n**References in affidavits:** [List each reference with document name, page and paragraph]\n**References in other documents:** [List each reference with document name, page and paragraph]\n\n" + (instructions ? "Focus: " + instructions + "\n\n" : "") + "DOCUMENTS:\n\n" + batchText + pageIndex; },
        function(combined, numBatches) { return numBatches ? "Synthesise persons from " + numBatches + " batches. Merge entries for the same person/entity. Sort alphabetically.\n\n## Dramatis Personae \u2014 " + matterName + "\n\nEXCLUDE: Do NOT include attorneys, counsel, solicitors, barristers or legal representatives acting in the proceedings. Do NOT include the Judge, Master, Registrar, or Justices of Appeal.\n\nFor each person or entity:\n### [Full Name]\n**Description:** [Concise description of who they are and their relevance]\n**References in pleadings/petitions:** [document, page, paragraph \u2014 listed first]\n**References in affidavits:** [document, page, paragraph \u2014 listed second]\n**References in other documents:** [document, page, paragraph \u2014 listed third]\n\n\u26A0\uFE0F Professional Caution: AI-generated. Verify before reliance.\n\nEXTRACTS:\n\n" + combined : "Compile a complete dramatis personae. Include EVERY person and entity.\n\n## Dramatis Personae \u2014 " + matterName + "\n\nEXCLUDE: Do NOT include attorneys, counsel, solicitors, barristers or legal representatives acting in the proceedings. Do NOT include the Judge, Master, Registrar, or Justices of Appeal.\n\nFor each person or entity:\n### [Full Name]\n**Description:** [Concise description of who they are and their relevance to the proceedings]\n**References in pleadings/petitions:** [document, page, paragraph \u2014 listed first]\n**References in affidavits:** [document, page, paragraph \u2014 listed second]\n**References in other documents:** [document, page, paragraph \u2014 listed third]\n\nSort alphabetically.\n\n\u26A0\uFE0F Professional Caution: AI-generated. Verify before reliance.\n\n" + (instructions ? "Focus: " + instructions + "\n\n" : "") + "DOCUMENTS:\n\n" + combined + pageIndex; },
        byDoc, hostUrl
      );
      if (r === null) return res.status(200).json({ ok: true, status: "continuing" });
      result = r.text; inputTokens = r.inputTokens; outputTokens = r.outputTokens; cost = r.cost;
    }

    /* ── ISSUE TRACKER ─────────────────────────────────────────────────── */
    else if (tool === "issues") {
      var chunks = filterExcluded(await getAllChunks(matterId), excludeDocNames);
      var byDoc = chunksToDocMap(chunks);
      var pageIndex = buildPageIndex(byDoc);
      var systemBase = "You are a senior litigation counsel in " + jur + " mapping issues for \"" + matterName + "\".\n" + matterContext;
      var r = await runBatchedChained(jobId, job, systemBase,
        function(batchText, batchNum, total) { return "Identify every legal and factual issue from batch " + batchNum + " of " + total + ".\n\n### Issue: [description]\n**Type:** Legal / Factual / Mixed\n**Evidence for Claimant:** [documents, passages, page and paragraph references]\n**Evidence for Defendant:** [documents, passages, page and paragraph references]\n\n" + (instructions ? "Focus: " + instructions + "\n\n" : "") + "DOCUMENTS:\n\n" + batchText + pageIndex; },
        function(combined, numBatches) { return numBatches ? "Synthesise issues from " + numBatches + " batches. Merge duplicates.\n\n## Issue Tracker \u2014 " + matterName + "\n\n### Issue [N]: [description]\n**Type:** Legal / Factual / Mixed\n**Raised by:** [party]\n**Evidence for Claimant:** [documents, passages, page and paragraph references]\n**Evidence for Defendant:** [documents, passages, page and paragraph references]\n**Assessment:** [preliminary view]\n\n## Overall Assessment\n\n\u26A0\uFE0F Professional Caution: AI-generated. Verify before reliance.\n\nFINDINGS:\n\n" + combined : "Produce a complete issue tracker.\n\n## Issue Tracker \u2014 " + matterName + "\n\n### Issue [N]: [description]\n**Type:** Legal / Factual / Mixed\n**Raised by:** [party]\n**Evidence for Claimant:** [documents, passages, page and paragraph references]\n**Evidence for Defendant:** [documents, passages, page and paragraph references]\n**Assessment:** [preliminary view]\n\n## Overall Assessment\n\n\u26A0\uFE0F Professional Caution: AI-generated. Verify before reliance.\n\n" + (instructions ? "Focus: " + instructions + "\n\n" : "") + "DOCUMENTS:\n\n" + combined + pageIndex; },
        byDoc, hostUrl
      );
      if (r === null) return res.status(200).json({ ok: true, status: "continuing" });
      result = r.text; inputTokens = r.inputTokens; outputTokens = r.outputTokens; cost = r.cost;
    }

    /* ── CITATION CHECKER ──────────────────────────────────────────────── */
    else if (tool === "citations") {
      var allChunks = filterExcluded(await getAllChunks(matterId), excludeDocNames);
      var skeletonChunks, caselawChunks;
      if (p.citationSource) {
        skeletonChunks = allChunks.filter(function(c) { return c.document_name === p.citationSource; });
      } else {
        skeletonChunks = allChunks.filter(function(c) { return c.doc_type === "Skeleton Argument" || c.doc_type === "Pleading"; });
      }
      if (p.citationTargets && p.citationTargets.length > 0) {
        caselawChunks = allChunks.filter(function(c) { return p.citationTargets.indexOf(c.document_name) !== -1; });
      } else {
        caselawChunks = allChunks.filter(function(c) { return c.doc_type === "Case Law"; });
      }
      var skeletonText = docsToText(chunksToDocMap(skeletonChunks)) || "None uploaded";
      var caselawText = docsToText(chunksToDocMap(caselawChunks)) || "No case law uploaded";

      await updateJob(jobId, { batches_total: 1, batches_done: 0, status: "running", started_at: job.started_at || new Date().toISOString() });

      var r = await runTool(
        "You are a senior litigation counsel in " + jur + " checking citations for \"" + matterName + "\".\n" + matterContext,
        "Check every citation in the source document against the target case law.\n\n## Citation Check \u2014 " + matterName + "\n\n### [Case name]\n**Cited for:** [proposition]\n**Found in uploads:** Yes / No / Partial\n**Accuracy:** [does the judgment support the proposition?]\n**Flag:** \u2713 Accurate / \u26A0\uFE0F Overstated / \u2717 Incorrect / ? Not uploaded\n**Notes:** [any concern]\n\nSOURCE DOCUMENT:\n\n" + skeletonText + "\n\nTARGET CASE LAW:\n\n" + caselawText
      );
      result = r.text; inputTokens = r.inputTokens; outputTokens = r.outputTokens; cost = r.cost;
    }

    /* ── BRIEFING NOTE ─────────────────────────────────────────────────── */
    else if (tool === "briefing") {
      var chunks = filterExcluded(await getAllChunks(matterId), excludeDocNames);
      var byDoc = chunksToDocMap(chunks);
      var pageIndex = buildPageIndex(byDoc);
      var systemBase = "You are a senior litigation counsel in " + jur + " producing a briefing note for \"" + matterName + "\".\n" + matterContext;
      var r = await runBatchedChained(jobId, job, systemBase,
        function(batchText, batchNum, total) { return "Extract key facts, legal issues, evidence, admissions, common ground, and procedural information from batch " + batchNum + " of " + total + " for a briefing note.\n\nPay particular attention to:\n- What issues are raised in the proceedings\n- What facts or matters are admitted or agreed (common ground)\n- What facts or matters are in dispute and what evidence supports each side\n\nDOCUMENTS:\n\n" + batchText + pageIndex; },
        function(combined, numBatches) { return numBatches ? "Using findings from " + numBatches + " batches, produce a complete briefing note.\n\n## Briefing Note \u2014 " + matterName + "\n**Jurisdiction:** " + jur + "\n**Date:** " + new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) + "\n\n## 1. Summary of the Proceedings\nBrief overview of the nature and status of the proceedings.\n\n## 2. The Issues\nSet out each issue that arises in the proceedings \u2014 both legal and factual. Reference the pleadings or other documents where each issue is raised.\n\n## 3. Common Ground and Admissions\nSet out all facts, matters, or legal points that are admitted or agreed between the parties. These may appear in pleadings, witness statements, correspondence, or skeleton arguments. Distinguish between formal admissions and matters that appear to be common ground.\n\n## 4. The Case on Disputed Matters\nFor each disputed issue identified in section 2, set out:\n- The case for the " + (actingFor || "client") + ": what evidence and arguments support the position\n- The opposing case: what evidence and arguments the other side relies on\n- Assessment: preliminary view on the strength of each side\u2019s position\n\n## 5. Key Evidence\nSummary of the most important evidence, with page and paragraph references where available.\n\n## 6. Procedural Position and Next Steps\nCurrent procedural stage, upcoming deadlines, and recommended next steps.\n\n## 7. Key Risks\nSignificant risks to be aware of.\n\n" + (instructions ? "Focus: " + instructions + "\n\n" : "") + "FINDINGS:\n\n" + combined : "Produce a structured briefing note.\n\n## Briefing Note \u2014 " + matterName + "\n**Jurisdiction:** " + jur + "\n**Date:** " + new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) + "\n\n## 1. Summary of the Proceedings\nBrief overview of the nature and status of the proceedings.\n\n## 2. The Issues\nSet out each issue that arises in the proceedings \u2014 both legal and factual. Reference the pleadings or other documents where each issue is raised.\n\n## 3. Common Ground and Admissions\nSet out all facts, matters, or legal points that are admitted or agreed between the parties. Distinguish between formal admissions and matters that appear to be common ground.\n\n## 4. The Case on Disputed Matters\nFor each disputed issue, set out the case for the " + (actingFor || "client") + ", the opposing case, and a preliminary assessment.\n\n## 5. Key Evidence\nSummary of the most important evidence, with page and paragraph references.\n\n## 6. Procedural Position and Next Steps\n\n## 7. Key Risks\n\n" + (instructions ? "Focus: " + instructions + "\n\n" : "") + "DOCUMENTS:\n\n" + combined + pageIndex; },
        byDoc, hostUrl
      );
      if (r === null) return res.status(200).json({ ok: true, status: "continuing" });
      result = r.text; inputTokens = r.inputTokens; outputTokens = r.outputTokens; cost = r.cost;
    }

    /* ── DRAFT GENERATOR ───────────────────────────────────────────────── */
    else if (tool === "draft") {
      /* Draft has special logic: library context, precedents, learning from past drafts */
      var libraryContext = p.libraryContext || null;
      var caseTypeId = p.caseTypeId || null;
      var docTypeId = p.docTypeId || null;
      var subcatId = p.subcatId || null;
      var libraryText = "";

      var allPrecedentIds = [];
      if (libraryContext && libraryContext.selectedPrecedentIds) {
        allPrecedentIds = libraryContext.selectedPrecedentIds.slice();
      }

      if (caseTypeId && allPrecedentIds.length === 0) {
        var autoQuery = supabase.from("precedent_docs").select("id").eq("user_id", userId).eq("case_type_id", caseTypeId);
        if (docTypeId) autoQuery = autoQuery.eq("doc_type_id", docTypeId);
        var autoResp = await autoQuery.limit(5);
        if (autoResp.data) allPrecedentIds = autoResp.data.map(function(pp) { return pp.id; });
      }

      if (allPrecedentIds.length > 0) {
        var ownTexts = [];
        var thirdTexts = [];
        for (var pi = 0; pi < allPrecedentIds.length; pi++) {
          var docId = allPrecedentIds[pi];
          var pChunksResp = await supabase.from("precedent_chunks").select("content, chunk_index").eq("precedent_doc_id", docId).order("chunk_index").limit(80);
          var precMetaResp = await supabase.from("precedent_docs").select("name, context_relationship, context_doc_id, ai_instructions, is_own_style, commentary").eq("id", docId).single();
          var pChunks = pChunksResp.data;
          var precMeta = precMetaResp.data;
          if (pChunks && pChunks.length > 0) {
            var label = precMeta ? precMeta.name : docId;
            var precEntry = "=== PRECEDENT: " + label + " ===\n";
            if (precMeta && precMeta.ai_instructions) precEntry += "[Author instructions: " + precMeta.ai_instructions + "]\n\n";
            if (precMeta && precMeta.commentary) precEntry += "[Commentary \u2014 read carefully and apply: " + precMeta.commentary + "]\n\n";
            precEntry += pChunks.map(function(c) { return c.content; }).join("\n\n");
            if (precMeta && precMeta.context_doc_id) {
              var ctxResp = await supabase.from("precedent_chunks").select("content, chunk_index").eq("precedent_doc_id", precMeta.context_doc_id).order("chunk_index").limit(40);
              if (ctxResp.data && ctxResp.data.length > 0) {
                var rel = precMeta.context_relationship || "relates to";
                precEntry += "\n\n--- CONTEXT: this precedent " + rel + " the following ---\n" + ctxResp.data.map(function(c) { return c.content; }).join("\n\n");
              }
            }
            if (precMeta && precMeta.is_own_style) ownTexts.push(precEntry);
            else thirdTexts.push(precEntry);
          }
        }
        var precTexts = [];
        if (ownTexts.length > 0) precTexts.push("### MY DRAFTING STYLE\nStudy these documents carefully. Learn and replicate: the document structure, heading hierarchy, argument sequence, paragraph style, tone, and language. Your draft must follow this style closely:\n\n" + ownTexts.join("\n\n"));
        if (thirdTexts.length > 0) precTexts.push("### THIRD PARTY PRECEDENTS\nUse these as benchmarks for structure, legal argument, and completeness. Adapt their approach to our client's position:\n\n" + thirdTexts.join("\n\n"));
        if (precTexts.length > 0) {
          var ctLabel = [libraryContext && libraryContext.caseTypeName, libraryContext && libraryContext.subcategoryName, libraryContext && libraryContext.docTypeName].filter(Boolean).join(" \u2014 ") || "Auto-matched";
          libraryText = "\n\n# PRECEDENT LIBRARY (" + ctLabel + ")\n\nYou MUST study these precedents before drafting. Learn from their structure, standard sections, argument methods, and language. Apply what you learn to the current draft.\n\n" + precTexts.join("\n\n---\n\n");
        }
      }

      if (libraryContext && libraryContext.selectedSections && libraryContext.selectedSections.length > 0) {
        var secText = libraryContext.selectedSections.map(function(s) { return "=== STANDARD SECTION: " + s.title + " ===\n" + s.content; }).join("\n\n");
        libraryText += "\n\n## STANDARD SECTIONS TO INCORPORATE\n\nIncorporate these sections with only minor contextual adaptation:\n\n" + secText;
      }

      var learningText = "";
      try {
        var pastResp = await supabase.from("conversation_history").select("question, answer, created_at").eq("matter_id", matterId).eq("user_id", userId).eq("tool_name", "draft").order("created_at", { ascending: false }).limit(3);
        if (pastResp.data && pastResp.data.length > 0) {
          var pastSummaries = pastResp.data.map(function(d) { return "--- Previous draft (" + new Date(d.created_at).toLocaleDateString("en-GB") + ") ---\nInstructions: " + d.question.slice(0, 200) + "\nDraft excerpt: " + d.answer.slice(0, 800) + "..."; }).join("\n\n");
          learningText = "\n\n# PREVIOUS DRAFTS FOR THIS MATTER\n\nLearn from these earlier drafts \u2014 maintain consistency in style, terminology, and argument structure:\n\n" + pastSummaries;
        }
      } catch (e) { console.log("Past drafts fetch skipped:", e.message); }

      var chunks = filterExcluded(await getAllChunks(matterId), excludeDocNames);
      var byDoc = chunksToDocMap(chunks);

      var headingInstruction = heading && (heading.court || heading.party1)
        ? "\n\nIMPORTANT: Begin the document with this exact court heading (do not alter the heading itself):\n\n" + headingText + "\n\nThen continue with the body of the document."
        : "";

      var systemBase = "You are a senior litigation counsel in " + jur + " drafting a legal document for \"" + matterName + "\". Apply " + jur + " law, procedure, and drafting conventions." + (actingFor ? " You are acting for the " + actingFor + "." : "") + "\n\nCRITICAL INSTRUCTIONS:\n1. If precedent documents are provided below, you MUST study them first. Learn their structure, standard sections, argument methods, heading hierarchy, and language style. Replicate this approach in your draft.\n2. If commentary or AI instructions are attached to a precedent, follow them precisely \u2014 they contain the author\u2019s specific guidance on how to use that document.\n3. If previous drafts for this matter exist, maintain consistency with their style, terminology, and argument structure.\n4. Apply " + jur + " court rules and conventions throughout.\n\n" + matterContext + libraryText + learningText + headingInstruction;

      var r = await runBatchedChained(jobId, job, systemBase,
        function(batchText, batchNum, total) { return "Extract all facts, legal points, and arguments from batch " + batchNum + " of " + total + " relevant to: " + (instructions || "Draft a skeleton argument") + "\n\nDOCUMENTS:\n\n" + batchText; },
        function(combined, numBatches) { return numBatches ? "Using source material from " + numBatches + " batches, produce:\n\n" + (instructions || "Draft a skeleton argument.") + "\n\nApply " + jur + " court rules and conventions.\n\n\u26A0\uFE0F Professional Caution: AI-generated draft. Review carefully before use.\n\nSOURCE MATERIAL:\n\n" + combined : (instructions || "Draft a skeleton argument based on the matter documents.") + "\n\nApply " + jur + " court rules and conventions.\n\n\u26A0\uFE0F Professional Caution: AI-generated draft. Review carefully before use.\n\nDOCUMENTS:\n\n" + combined; },
        byDoc, hostUrl
      );
      if (r === null) return res.status(200).json({ ok: true, status: "continuing" });
      result = r.text; inputTokens = r.inputTokens; outputTokens = r.outputTokens; cost = r.cost;
    }

    /* ── ISSUE BRIEFING (detailed analysis of selected issues) ─────────── */
    else if (tool === "issueBriefing") {
      var selectedIssues = p.selectedIssues || [];
      var issuesText = p.issuesText || "";
      if (selectedIssues.length === 0 && !instructions) {
        await failJob(jobId, "No issues selected for briefing");
        return res.status(200).json({ ok: false, error: "No issues selected" });
      }

      var chunks = filterExcluded(await getAllChunks(matterId), excludeDocNames);
      var byDoc = chunksToDocMap(chunks);
      var pageIndex = buildPageIndex(byDoc);

      var issuesList = selectedIssues.length > 0
        ? selectedIssues.map(function(iss, idx) { return (idx + 1) + ". " + iss; }).join("\n")
        : instructions;

      var systemBase = "You are a senior litigation counsel in " + jur + " producing a detailed issue briefing for \"" + matterName + "\"." + (actingFor ? " You are acting for the " + actingFor + "." : "") + "\n" + matterContext
        + "\n\nYou have been asked to produce a detailed briefing on specific issues from the matter. For each issue you MUST:\n"
        + "1. Provide a detailed commentary on the issue — what it involves, why it matters, and how it arises in the proceedings.\n"
        + "2. Cite specific document references in the format: [Document Name, p.X \u00b6Y] for every factual assertion.\n"
        + "3. Set out the STRENGTHS of the " + (actingFor || "client") + "'s position on this issue, with document references.\n"
        + "4. Set out the WEAKNESSES of the " + (actingFor || "client") + "'s position on this issue, with document references.\n"
        + "5. Set out the STRENGTHS of the opposing party's position, with document references.\n"
        + "6. Set out the WEAKNESSES of the opposing party's position, with document references.\n"
        + "7. Provide a preliminary assessment of the likely outcome on this issue.\n"
        + "\nIMPORTANT: Every factual claim must be supported by a reference to a specific document, page, and paragraph where available. Use the format [Document Name, p.X \u00b6Y]. Do not make assertions without references.";

      if (issuesText) {
        systemBase += "\n\nPREVIOUS ISSUE TRACKER OUTPUT (for context — the user has selected specific issues from this list):\n" + issuesText.slice(0, 15000);
      }

      var r = await runBatchedChained(jobId, job, systemBase,
        function(batchText, batchNum, total) {
          return "Extract ALL evidence relevant to the following issues from batch " + batchNum + " of " + total + ". For each piece of evidence, note:\n- Which issue it relates to\n- Whether it supports or undermines each party's position\n- The exact document reference [Document Name, p.X \u00b6Y]\n\nISSUES TO ANALYSE:\n" + issuesList + "\n\nDOCUMENTS:\n\n" + batchText + pageIndex;
        },
        function(combined, numBatches) {
          var header = "## Detailed Issue Briefing \u2014 " + matterName + "\n**Jurisdiction:** " + jur + "\n**Date:** " + new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) + (actingFor ? "\n**Acting for:** " + actingFor : "") + "\n\n";
          var format = "For EACH of the following issues, produce a detailed briefing with these sections:\n\n"
            + "### Issue [N]: [Issue description]\n\n"
            + "#### Commentary\n[Detailed discussion of the issue — what it involves, why it matters, how it arises. Cite document references throughout.]\n\n"
            + "#### " + (actingFor || "Client") + "'s Position\n**Strengths:**\n[Each strength with document references in the format [Document Name, p.X \u00b6Y]]\n\n"
            + "**Weaknesses:**\n[Each weakness with document references]\n\n"
            + "#### Opposing Party's Position\n**Strengths:**\n[Each strength with document references]\n\n"
            + "**Weaknesses:**\n[Each weakness with document references]\n\n"
            + "#### Assessment\n[Preliminary view on the likely outcome, with reasoning]\n\n---\n\n"
            + "After all issues:\n\n## Overall Assessment\n[Summary view across all issues]\n\n"
            + "\u26A0\uFE0F Professional Caution: AI-generated analysis. Verify all references and assertions before reliance.\n\n";

          if (numBatches) {
            return header + format + "ISSUES TO ANALYSE:\n" + issuesList + "\n\nEVIDENCE FROM " + numBatches + " BATCHES:\n\n" + combined;
          }
          return header + format + "ISSUES TO ANALYSE:\n" + issuesList + "\n\nDOCUMENTS:\n\n" + combined + pageIndex;
        },
        byDoc, hostUrl
      );
      if (r === null) return res.status(200).json({ ok: true, status: "continuing" });
      result = r.text; inputTokens = r.inputTokens; outputTokens = r.outputTokens; cost = r.cost;
    }

    else {
      await failJob(jobId, "Unknown tool: " + tool);
      return res.status(200).json({ ok: false, error: "Unknown tool" });
    }

    /* Prepend court heading to result if heading exists (except draft which handles it in prompt) */
    if (headingText && tool !== "draft") {
      result = headingText + "\n" + result;
    }

    /* Save result */
    await logUsage(matterId, userId, tool, inputTokens, outputTokens, cost);
    await saveHistory(matterId, userId, (toolLabels[tool] || tool) + (instructions ? ": " + instructions : ""), result, tool);
    await updateJob(jobId, {
      status: "complete",
      result: result,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: cost,
      completed_at: new Date().toISOString(),
    });
    console.log("Job complete: " + jobId + " (" + tool + ") " + inputTokens + "/" + outputTokens + " tokens, $" + cost.toFixed(4));
    return res.status(200).json({ ok: true, status: "complete" });

  } catch (err) {
    console.error("Worker error for job " + jobId + ":", err);
    try { await failJob(jobId, err.message || "Worker failed"); } catch (e) { /* nothing */ }
    return res.status(200).json({ ok: false, error: err.message });
  }
}

/* Tool label lookup for history saving */
var toolLabels = {
  proposition: "Proposition Evidence Finder",
  inconsistency: "Inconsistency Tracker",
  chronology: "Chronology",
  persons: "Dramatis Personae",
  issues: "Issue Tracker",
  issueBriefing: "Issue Briefing",
  citations: "Citation Checker",
  briefing: "Briefing Note",
  draft: "Draft",
};
