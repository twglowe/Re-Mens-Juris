/* EX LIBRIS JURIS v5.9c — jobs.js
   Job status polling endpoint.
   GET   /api/jobs?id=xxx        — single job status (for polling)
   GET   /api/jobs?matterId=xxx  — all recent jobs for a matter (for resume on page load)
   PATCH /api/jobs?id=xxx        — update mutable job fields (currently only deferred_focus)

   v5.9c CHANGES (26 Apr 2026) — Push I Part B:
   1. Single-job SELECT now also returns deferred_focus (JSONB, nullable). The
      frontend follow-up widget reads this on tool completion and pre-populates
      itself if the user chose "Run standard analysis, apply focus after" at
      launch time.
   2. New PATCH handler accepts a JSON body with {deferred_focus: null} (or
      with a replacement object) and updates the matching row. PATCH only;
      GET and POST behaviour unchanged. Auth enforced — user must own the
      matching row.
   3. createClient() moved inside handler (defensive — same pattern as
      api/history.js v5.6f and api/tools.js v5.8a).

   v5.8b CHANGES (25 Apr 2026):
   1. Single-job SELECT now also includes section_plan and section_results so
      the frontend can render the per-section progress widget for sectioned
      tools (Briefing, Draft, Proposition). Both columns are nullable JSONB
      and pass through to the response unchanged. Non-sectioned tools have
      both as null and are unaffected.
   2. No other changes.

   v4.5c CHANGES (12 Apr 2026):
   1. Single-job SELECT now includes condensed_extracts, condense_done, extracts,
      and synth_attempts so the frontend polling loop can show condense progress
      and retry counts. condensed_extracts and extracts are arrays — to save
      bandwidth, we expose only their lengths (condensedCount, extractsCount),
      not the array contents themselves. condense_done and synth_attempts are
      small integers and are exposed directly.
   2. The matter-list endpoint is unchanged — those fields are not needed for
      the resume-on-load list.
   3. No changes to auth, structure, or anything else. */

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

/* v5.9c: createClient moved inside handler. At module scope it caches the
   PostgREST schema on the first warm invocation, and any column added by a
   later migration gets silently stripped from PATCH/UPDATE payloads. The
   v5.9c migration adds deferred_focus to tool_jobs — exactly the shape of
   the bug we hit in api/history.js. Defensive. */

async function getUser(supabase, req) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error) return null;
    return user;
  } catch (e) { return null; }
}

const SERVER_VERSION = "v5.9c";
export default async function handler(req, res) {
  console.log(SERVER_VERSION + " jobs handler: " + (req.method || "?") + " " + (req.url || ""));

  /* v5.9c: fresh client per invocation. See header comment. */
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const user = await getUser(supabase, req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  /* ── PATCH: update mutable fields on a job row ─────────────────────────
     Currently only deferred_focus is mutable post-insert. Auth enforced via
     the user_id eq filter; if the row doesn't belong to this user the
     update silently affects zero rows and we return a 404. */
  if (req.method === "PATCH") {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "id query parameter required" });

    const body = req.body || {};
    const update = {};
    /* v5.9c: only deferred_focus is patchable today. Accept null (clear) or
       an object (replace). Anything else is ignored. */
    if (body.hasOwnProperty("deferred_focus")) {
      if (body.deferred_focus === null || typeof body.deferred_focus === "object") {
        update.deferred_focus = body.deferred_focus;
      } else {
        return res.status(400).json({ error: "deferred_focus must be an object or null" });
      }
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: "No patchable fields supplied" });
    }

    const { data, error } = await supabase
      .from("tool_jobs")
      .update(update)
      .eq("id", id)
      .eq("user_id", user.id)
      .select("id")
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Job not found or update failed" });
    }
    return res.status(200).json({ ok: true, id: data.id });
  }

  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { id, matterId } = req.query;

  /* Single job by ID — used for polling */
  if (id) {
    const { data: job, error } = await supabase
      .from("tool_jobs")
      .select("id, matter_id, tool_name, status, result, error, batches_total, batches_done, input_tokens, output_tokens, cost_usd, created_at, started_at, completed_at, instructions, condensed_extracts, condense_done, extracts, synth_attempts, section_plan, section_results, deferred_focus")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (error || !job) return res.status(404).json({ error: "Job not found" });

    /* v4.5c: expose array lengths rather than arrays themselves to save bandwidth */
    var extractsCount = (job.extracts && Array.isArray(job.extracts)) ? job.extracts.length : 0;
    var condensedCount = (job.condensed_extracts && Array.isArray(job.condensed_extracts)) ? job.condensed_extracts.length : 0;

    return res.status(200).json({
      id: job.id,
      matterId: job.matter_id,
      toolName: job.tool_name,
      status: job.status,
      result: (job.status === "complete") ? job.result : null,
      error: (job.status === "failed") ? job.error : null,
      batchesTotal: job.batches_total,
      batchesDone: job.batches_done,
      /* v4.5c: condense progress fields */
      extractsCount: extractsCount,
      condensedCount: condensedCount,
      condenseDone: job.condense_done || 0,
      synthAttempts: job.synth_attempts || 0,
      /* v5.8b: sectioned-synthesis fields. Both nullable JSONB; pass through
         as-is so the frontend widget can decide how to render them.
         section_plan: array of {index,title,description,target_words} once the
         plan phase completes (Briefing/Draft/Proposition only).
         section_results: array of {index,status,result,error} populated as each
         section synthesis completes. */
      sectionPlan: job.section_plan || null,
      sectionResults: job.section_results || null,
      /* v5.9c: deferred focus stash. Set when user picked "Run standard
         analysis, apply focus after" at launch. Read by the follow-up
         widget on tool completion to pre-populate the three fields.
         Cleared via PATCH once consumed. */
      deferredFocus: job.deferred_focus || null,
      usage: {
        inputTokens: job.input_tokens,
        outputTokens: job.output_tokens,
        costUsd: parseFloat(job.cost_usd) || 0,
      },
      createdAt: job.created_at,
      startedAt: job.started_at,
      completedAt: job.completed_at,
      instructions: job.instructions,
    });
  }

  /* All recent jobs for a matter — used on page load to resume polling */
  if (matterId) {
    const { data: jobs, error } = await supabase
      .from("tool_jobs")
      .select("id, tool_name, status, batches_total, batches_done, created_at, started_at, completed_at, instructions")
      .eq("matter_id", matterId)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({
      jobs: (jobs || []).map(function(j) {
        return {
          id: j.id,
          toolName: j.tool_name,
          status: j.status,
          batchesTotal: j.batches_total,
          batchesDone: j.batches_done,
          createdAt: j.created_at,
          startedAt: j.started_at,
          completedAt: j.completed_at,
          instructions: j.instructions,
        };
      }),
    });
  }

  return res.status(400).json({ error: "Provide id or matterId" });
}
