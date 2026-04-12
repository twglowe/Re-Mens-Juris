/* EX LIBRIS JURIS v4.5c — jobs.js
   Job status polling endpoint.
   GET /api/jobs?id=xxx        — single job status (for polling)
   GET /api/jobs?matterId=xxx  — all recent jobs for a matter (for resume on page load)

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

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function getUser(req) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error) return null;
    return user;
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { id, matterId } = req.query;

  /* Single job by ID — used for polling */
  if (id) {
    const { data: job, error } = await supabase
      .from("tool_jobs")
      .select("id, matter_id, tool_name, status, result, error, batches_total, batches_done, input_tokens, output_tokens, cost_usd, created_at, started_at, completed_at, instructions, condensed_extracts, condense_done, extracts, synth_attempts")
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
