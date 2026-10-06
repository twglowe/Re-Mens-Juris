/* EX LIBRIS JURIS v5.81 (Push 2) — authoritiesWorker.js (NEW FILE)
   LIST OF AUTHORITIES. Background processor for tool_jobs rows with
   tool_name = 'authorities'. Fired by api/tools.js, re-fired by itself when
   it runs out of time, and rescued by api/cron-resume.js like every job.

   Why a file of its own: the Citation Checker lives inside api/worker.js,
   which is frozen (Tom, 25 Sep 2026; enforced by worker_frozen.test.js).
   This follows the analyseWorker.js precedent — its own worker, routed by
   tool name — and imports nothing from worker.js.

   THE JOB, in three stages, each resumable:
     1. extract — each chosen skeleton is rebuilt from its chunks (the
        upload overlap stripped), cut into ~40k-character parts at page
        breaks, and every case and textbook citation in each part listed,
        with its paragraph, footnote and the proposition it is cited for.
     2. merge   — one call groups the citations into authorities and gives
        each its jurisdiction and its report citations. The code then drops
        any report citation that is not in the skeletons' own text.
     3. verify  — for each authority, other documents that name it are
        found (this matter's documents and the Library, never the skeletons
        under review, never the decision itself), and each proposition is
        checked against those passages only.
   Then the three orders are built (api/lib/authorities.js) and saved as
   the result and as a History row.

   STATE: tool_jobs.extracts holds ONE string, the JSON of the job's state —
   a string because worker.js stores strings there, so the column type is
   known to take one. Saved after every wave of model calls, so a stopped
   invocation loses at most one wave.

   CLAIM: two invocations must never run one job (the double-fire window
   cron-resume.js records as accepted for worker.js). A lease in the state
   carries an expiry past this function's maxDuration, and taking it is a
   conditional update on updated_at: of two simultaneous fires, one wins and
   the other leaves. A self-re-fire releases the lease before it fires.

   createClient() is inside the handler, per the standing rule about the
   module-scope schema cache. */

import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import {
  SYSTEM_PROMPT, extractPrompt, mergePrompt, verifyPrompt,
  rebuildText, batchText, skeletonLabel, parseJsonBlock,
  cleanInstances, dedupeInstances, mergeEntries, applyMerge, fallbackMerge,
  searchTerms, websearchQuery, isSameDecision, passageWindow, applyVerify,
  relatedPropositions, buildViews, embedViews,
} from "./lib/authorities.js";

export const config = { maxDuration: 800 };

const SERVER_VERSION = "v5.81";
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const INPUT_COST_PER_M = 3.00;
const OUTPUT_COST_PER_M = 15.00;
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.10;

const PARALLEL = 6;                 /* model calls per wave */
const EXTRACT_BATCH_CHARS = 40000;  /* ~10k tokens of skeleton per call */
const VERIFY_GROUP = 6;             /* authorities per verification call */
const MAX_PASSAGES = 6;             /* per authority */
const MAX_PASSAGES_PER_SOURCE = 2;
const TIME_BUDGET_MS = 540000;      /* start no new wave after 9 minutes */
const LEASE_MS = 830000;            /* past maxDuration, so a crash frees it */
const FETCH_PAGE = 1000;

/* ── model ───────────────────────────────────────────────────────────── */

function isRetryable(err) {
  if (!err) return false;
  if (err.status === 529 || err.status === 429 || err.status === 500 || err.status === 503) return true;
  var t = (err.error && (err.error.type || (err.error.error && err.error.error.type))) || "";
  if (t === "overloaded_error" || t === "rate_limit_error" || t === "api_error") return true;
  var msg = String(err.message || "");
  return /overloaded|rate_limit|Overloaded/.test(msg);
}

/* Same contract as worker.js runTool: streaming, retry on overload, cached
   system prompt, cache-aware cost. */
async function runModel(userPrompt, maxTokens) {
  var BACKOFF = [5000, 15000, 45000];
  for (var attempt = 1; ; attempt++) {
    try {
      var stream = anthropic.messages.stream({
        model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
        max_tokens: maxTokens || 32000,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userPrompt }],
      });
      var msg = await stream.finalMessage();
      var text = "";
      (msg.content || []).forEach(function (b) { if (b.type === "text" && !text) text = b.text; });
      var u = msg.usage || {};
      var fresh = u.input_tokens || 0, cw = u.cache_creation_input_tokens || 0, cr = u.cache_read_input_tokens || 0, out = u.output_tokens || 0;
      var cost = ((fresh + cw * CACHE_WRITE_MULTIPLIER + cr * CACHE_READ_MULTIPLIER) * INPUT_COST_PER_M + out * OUTPUT_COST_PER_M) / 1e6;
      return { text: text, inputTokens: fresh + cw + cr, outputTokens: out, cost: cost, truncated: msg.stop_reason === "max_tokens" };
    } catch (err) {
      if (!isRetryable(err) || attempt > BACKOFF.length) throw err;
      console.log(SERVER_VERSION + " authorities: retryable model error (" + String(err.message || "").slice(0, 120) + "), retry in " + BACKOFF[attempt - 1] / 1000 + "s");
      await new Promise(function (r) { setTimeout(r, BACKOFF[attempt - 1]); });
    }
  }
}

/* A model call whose answer must be JSON: one retry on unreadable output. */
async function runJson(prompt, maxTokens, usage) {
  var lastErr = null;
  for (var attempt = 1; attempt <= 2; attempt++) {
    var r = await runModel(attempt === 1 ? prompt : prompt + "\n\nYour previous answer could not be read as JSON. Return ONLY valid JSON inside <json></json> tags.", maxTokens);
    usage.input += r.inputTokens; usage.output += r.outputTokens; usage.cost += r.cost;
    try { return parseJsonBlock(r.text); }
    catch (e) { lastErr = new Error((r.truncated ? "output too long" : "unreadable output") + ": " + e.message); }
  }
  throw lastErr;
}

/* ── state ───────────────────────────────────────────────────────────── */

function loadState(job) {
  try {
    if (Array.isArray(job.extracts) && typeof job.extracts[0] === "string") {
      var s = JSON.parse(job.extracts[0]);
      if (s && s.v === 1) return s;
    }
  } catch (e) { console.error(SERVER_VERSION + " authorities: unreadable state, starting again:", e.message); }
  return { v: 1, stage: "extract", lease: null, extracted: {}, failedBatches: [], authorities: null, verified: {}, warnings: [], usage: { input: 0, output: 0, cost: 0 } };
}

/* ── data ────────────────────────────────────────────────────────────── */

async function fetchSkeletonChunks(supabase, matterId, names) {
  var all = [];
  for (var offset = 0; ; offset += FETCH_PAGE) {
    var r = await supabase.from("chunks")
      .select("content, document_name, chunk_index, page_number, document_id")
      .eq("matter_id", matterId)
      .in("document_name", names)
      .order("document_id", { ascending: true })
      .order("chunk_index", { ascending: true })
      .range(offset, offset + FETCH_PAGE - 1);
    if (r.error) throw new Error("Could not read the skeletons: " + r.error.message);
    all = all.concat(r.data || []);
    if (!r.data || r.data.length < FETCH_PAGE) break;
  }
  return all;
}

/* The chosen skeletons in date order, each with its batches. Rebuilt on
   every invocation rather than stored: it is deterministic and cheap, and
   keeps the saved state small. */
async function loadSkeletons(supabase, matterId, names) {
  var docsResp = await supabase.from("documents").select("name, doc_date, created_at").eq("matter_id", matterId).in("name", names);
  var dates = {};
  ((docsResp && docsResp.data) || []).forEach(function (d) { dates[d.name] = d.doc_date || d.created_at || ""; });
  var chunks = await fetchSkeletonChunks(supabase, matterId, names);
  var byName = {};
  chunks.forEach(function (c) { (byName[c.document_name] = byName[c.document_name] || []).push(c); });
  var ordered = names.slice().sort(function (a, b) { return String(dates[a] || "").localeCompare(String(dates[b] || "")) || a.localeCompare(b); });
  return ordered.map(function (n) {
    var d = dates[n] ? new Date(dates[n]) : null;
    return {
      name: n,
      label: skeletonLabel(n),
      date: d && !isNaN(d.getTime()) ? d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "",
      batches: byName[n] ? batchText(rebuildText(byName[n]), EXTRACT_BATCH_CHARS) : [],
    };
  });
}

/* Other documents naming the authority: this matter's documents and the
   Library. Never the skeletons under review; never the decision itself. */
async function findPassages(supabase, job, a, skeletonNames) {
  var terms = searchTerms(a);
  if (!terms.length) return [];
  var q = websearchQuery(terms);
  var found = [];

  var m = await supabase.from("chunks").select("content, document_name, page_number")
    .eq("matter_id", job.matter_id)
    .textSearch("content", q, { type: "websearch", config: "english" })
    .limit(40);
  if (!m.error) (m.data || []).forEach(function (c) {
    if (skeletonNames.indexOf(c.document_name) !== -1) return;
    if (isSameDecision(a, c.document_name)) return;
    found.push({ source: "m:" + c.document_name, label: c.document_name + " (matter document" + (c.page_number != null ? ", p." + c.page_number : "") + ")", text: c.content });
  });
  else console.log(SERVER_VERSION + " authorities: matter search failed for " + a.key + ": " + m.error.message);

  var lib = null;
  try {
    var rpc = await supabase.rpc("case_law_search", { p_user_id: job.user_id, p_query: q, p_doc_ids: null, p_limit: 30 });
    if (!rpc.error && rpc.data) lib = rpc.data;
  } catch (e) { /* fall through to the unranked search */ }
  if (!lib) {
    var f = await supabase.from("case_law_chunks").select("case_law_id, content")
      .eq("user_id", job.user_id)
      .textSearch("content", q, { type: "websearch", config: "english" })
      .limit(30);
    lib = f.error ? [] : (f.data || []);
  }
  if (lib.length) {
    var ids = [];
    lib.forEach(function (c) { if (ids.indexOf(c.case_law_id) === -1) ids.push(c.case_law_id); });
    var docs = await supabase.from("case_law_docs").select("id, name, citation, doc_type").in("id", ids);
    var byId = {};
    ((docs && docs.data) || []).forEach(function (d) { byId[d.id] = d; });
    lib.forEach(function (c) {
      var d = byId[c.case_law_id];
      if (!d) return;
      if (isSameDecision(a, (d.name || "") + " " + (d.citation || ""))) return;
      found.push({ source: "l:" + d.id, label: [d.name, d.citation].filter(Boolean).join(" ") + " (Library" + (d.doc_type === "textbook" ? ", textbook" : "") + ")", text: c.content, library: true });
    });
  }

  /* Library first (curated judgments and textbooks), then the matter's own
     documents; at most two passages from any one source. */
  found.sort(function (x, y) { return (y.library ? 1 : 0) - (x.library ? 1 : 0); });
  var perSource = {};
  var out = [];
  for (var i = 0; i < found.length && out.length < MAX_PASSAGES; i++) {
    var p = found[i];
    perSource[p.source] = (perSource[p.source] || 0) + 1;
    if (perSource[p.source] > MAX_PASSAGES_PER_SOURCE) continue;
    out.push({ pid: "P" + (out.length + 1), label: p.label, text: passageWindow(p.text, terms, 1400) });
  }
  return out;
}

/* ── handler ─────────────────────────────────────────────────────────── */

export default async function handler(req, res) {
  console.log(SERVER_VERSION + " authoritiesWorker: " + (req.method || "?") + " " + (req.url || ""));
  if (req.method !== "POST" && req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const jobId = req.query && req.query.jobId;
  if (!jobId) return res.status(400).json({ error: "jobId required" });

  var jr = await supabase.from("tool_jobs")
    .select("id, matter_id, user_id, tool_name, status, parameters, extracts, updated_at, started_at")
    .eq("id", jobId).single();
  var job = jr.data;
  if (jr.error || !job) return res.status(404).json({ error: "Job not found" });
  if (job.tool_name !== "authorities") return res.status(400).json({ error: "Not a List of Authorities job" });
  if (job.status === "complete" || job.status === "failed") return res.status(200).json({ ok: true, status: job.status });

  /* ── claim ── */
  var state = loadState(job);
  var now = Date.now();
  if (state.lease && state.lease.until > now) {
    console.log(SERVER_VERSION + " authorities: job " + jobId + " is held by " + state.lease.id + " — leaving it");
    return res.status(200).json({ ok: true, status: "busy" });
  }
  var leaseId = Math.random().toString(36).slice(2, 10);
  state.lease = { id: leaseId, until: now + LEASE_MS };
  var claim = { status: "running", extracts: [JSON.stringify(state)], updated_at: new Date().toISOString() };
  if (!job.started_at) claim.started_at = claim.updated_at;
  var cq = supabase.from("tool_jobs").update(claim).eq("id", jobId);
  cq = job.updated_at ? cq.eq("updated_at", job.updated_at) : cq.is("updated_at", null);
  var cr = await cq.select("id");
  if (cr.error) return res.status(500).json({ error: "Could not claim the job: " + cr.error.message });
  if (!cr.data || !cr.data.length) {
    console.log(SERVER_VERSION + " authorities: job " + jobId + " was claimed by another invocation");
    return res.status(200).json({ ok: true, status: "busy" });
  }

  var startedAt = Date.now();
  var p = job.parameters || {};
  var skeletonNames = Array.isArray(p.authoritySkeletons) ? p.authoritySkeletons.filter(Boolean) : [];

  async function save(extra) {
    var patch = Object.assign({
      extracts: [JSON.stringify(state)],
      input_tokens: state.usage.input,
      output_tokens: state.usage.output,
      cost_usd: state.usage.cost,
      updated_at: new Date().toISOString(),
    }, extra || {});
    var r = await supabase.from("tool_jobs").update(patch).eq("id", jobId).select("id");
    if (r.error || !r.data || !r.data.length) throw new Error("Could not save progress: " + ((r.error && r.error.message) || "no row"));
  }
  function outOfTime() { return Date.now() - startedAt > TIME_BUDGET_MS; }
  async function continueLater() {
    state.lease = null;
    await save();
    var base = process.env.PUBLIC_BASE_URL || ("https://" + req.headers.host);
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, 2000);
    try { await fetch(base + "/api/authoritiesWorker?jobId=" + encodeURIComponent(jobId), { method: "POST", signal: ctl.signal }); }
    catch (e) { /* an abort means it landed and is busy; a failure is left to cron-resume */ }
    clearTimeout(t);
    return res.status(200).json({ ok: true, status: "continuing" });
  }

  try {
    if (!skeletonNames.length) throw new Error("No skeleton arguments were chosen.");
    var skeletons = await loadSkeletons(supabase, job.matter_id, skeletonNames);
    var missing = skeletons.filter(function (s) { return !s.batches.length; }).map(function (s) { return s.label; });
    if (missing.length === skeletons.length) throw new Error("No text was found for the chosen skeleton arguments.");
    var allBatches = [];
    skeletons.forEach(function (s, d) { s.batches.forEach(function (b, bi) { allBatches.push({ doc: d, bi: bi, key: d + ":" + bi, batch: b }); }); });

    /* ── 1. extract ── */
    if (state.stage === "extract") {
      if (!state.skeletonsNoted) {
        missing.forEach(function (l) { state.warnings.push("No text was found for “" + l + "”; it was not reviewed."); });
        state.skeletonsNoted = true;
      }
      var pending = allBatches.filter(function (b) { return !state.extracted[b.key] && state.failedBatches.indexOf(b.key) === -1; });
      await save({ batches_total: allBatches.length + 1, batches_done: allBatches.length - pending.length });
      while (pending.length) {
        if (outOfTime()) return await continueLater();
        var wave = pending.splice(0, PARALLEL);
        var results = await Promise.all(wave.map(function (b) {
          return runJson(extractPrompt(skeletons[b.doc].label, b.batch), 32000, state.usage)
            .then(function (parsed) { return { b: b, parsed: parsed }; })
            .catch(function (e) { return { b: b, error: e }; });
        }));
        results.forEach(function (r) {
          if (r.error) {
            console.error(SERVER_VERSION + " authorities: extraction failed for " + r.b.key + ": " + r.error.message);
            state.failedBatches.push(r.b.key);
            state.warnings.push("Pages " + (r.b.batch.pages || "?") + " of “" + skeletons[r.b.doc].label + "” could not be read by the model; authorities cited there are missing from this list.");
          } else {
            state.extracted[r.b.key] = cleanInstances(r.parsed, r.b.doc, r.b.bi, 0);
          }
        });
        await save({ batches_done: allBatches.length - pending.length });
      }
      state.stage = "merge";
      await save();
    }

    /* Instances, numbered in document order — the same every invocation. */
    var instances = [];
    allBatches.forEach(function (b) { (state.extracted[b.key] || []).forEach(function (x) { instances.push(x); }); });
    instances.sort(function (x, y) { return x.order - y.order; });
    instances.forEach(function (x, i) { x.id = "i" + (i + 1); });
    instances = dedupeInstances(instances);
    var instancesById = {};
    instances.forEach(function (x) { instancesById[x.id] = x; });

    /* ── 2. merge ── */
    if (state.stage === "merge") {
      if (outOfTime()) return await continueLater();
      var entries = mergeEntries(instances);
      if (!entries.length) {
        state.authorities = [];
      } else {
        try {
          state.authorities = applyMerge(await runJson(mergePrompt(entries), 64000, state.usage), entries);
        } catch (e) {
          console.error(SERVER_VERSION + " authorities: merge failed, grouping by name: " + e.message);
          state.authorities = fallbackMerge(entries);
          state.warnings.push("The citations could not be grouped by the model, so they are grouped by name alone: a short form (“Baosheng”) may appear as a separate entry from the full name, and jurisdictions are not identified.");
        }
      }
      state.stage = "verify";
      await save({ batches_done: allBatches.length + 1 });
    }

    /* ── 3. verify ── */
    /* Related judgments are cited for their findings: nothing of law to
       check, so they are never sent. */
    state.authorities.forEach(function (a) { if (a.kind === "related") relatedPropositions(a, instancesById); });
    var checkable = state.authorities.filter(function (a) { return a.kind !== "related"; });
    var groups = [];
    for (var gi = 0; gi < checkable.length; gi += VERIFY_GROUP) groups.push(checkable.slice(gi, gi + VERIFY_GROUP));
    var total = allBatches.length + 1 + groups.length;
    if (state.stage === "verify") {
      var todo = [];
      groups.forEach(function (g, i) { if (!state.verified[i]) todo.push(i); });
      await save({ batches_total: total, batches_done: total - todo.length });
      while (todo.length) {
        if (outOfTime()) return await continueLater();
        var vwave = todo.splice(0, PARALLEL);
        await Promise.all(vwave.map(async function (i) {
          var g = groups[i];
          var passagesByKey = {};
          for (var k = 0; k < g.length; k++) {
            try { passagesByKey[g[k].key] = await findPassages(supabase, job, g[k], skeletonNames); }
            catch (e) { passagesByKey[g[k].key] = []; console.error(SERVER_VERSION + " authorities: search failed for " + g[k].key + ": " + e.message); }
          }
          var parsed = null;
          try { parsed = await runJson(verifyPrompt(g, passagesByKey, instancesById, skeletons), 32000, state.usage); }
          catch (e) {
            console.error(SERVER_VERSION + " authorities: verification failed for group " + i + ": " + e.message);
            state.warnings.push("The check could not be completed for: " + g.map(function (a) { return a.name; }).join("; ") + ". Their propositions are shown as stated in the skeletons, unchecked.");
          }
          applyVerify(parsed, g, passagesByKey, instancesById);
          state.verified[i] = true;
        }));
        await save({ batches_done: total - todo.length });
      }
      state.stage = "done";
    }

    /* ── assemble ── */
    var views = buildViews({
      matterName: p.matterName || "",
      skeletons: skeletons.map(function (s) { return { label: s.label, date: s.date }; }),
      authorities: state.authorities,
      instances: instancesById,
      warnings: state.warnings,
    });
    var result = embedViews(views);
    state.lease = null;
    await save({ status: "complete", result: result, completed_at: new Date().toISOString(), batches_done: total });

    try {
      await supabase.from("conversation_history").insert({
        matter_id: job.matter_id, user_id: job.user_id,
        question: "List of Authorities — " + skeletons.length + " skeleton" + (skeletons.length === 1 ? "" : "s"),
        answer: result, tool_name: "authorities",
      });
    } catch (e) { console.error(SERVER_VERSION + " authorities: history save failed:", e && e.message); }
    try {
      await supabase.from("usage_log").insert({
        matter_id: job.matter_id, user_id: job.user_id, tool_name: "authorities",
        input_tokens: state.usage.input, output_tokens: state.usage.output, cost_usd: state.usage.cost,
      });
    } catch (e) { console.error(SERVER_VERSION + " authorities: usage log failed:", e && e.message); }

    return res.status(200).json({ ok: true, status: "complete" });
  } catch (err) {
    console.error(SERVER_VERSION + " authorities: job " + jobId + " failed:", err);
    try {
      state.lease = null;
      await save({ status: "failed", error: (err && err.message) || "List of Authorities failed", completed_at: new Date().toISOString() });
    } catch (e2) { console.error(SERVER_VERSION + " authorities: could not record the failure:", e2 && e2.message); }
    return res.status(500).json({ error: (err && err.message) || "failed" });
  }
}
