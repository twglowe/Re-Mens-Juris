/* EX LIBRIS JURIS v4.3a — cron-resume.js
   Vercel Cron job. Fires every 2 minutes (configured in vercel.json).

   Purpose: keep tool jobs progressing even when the user has closed the
   laptop or browser tab. Before v4.3, the frontend polling loop in tools.js
   was load-bearing — it was the only thing re-firing the worker between
   chained invocations. If the user closed the tab, the chain died and the
   job stalled in 'paused' or 'synthesising' indefinitely.

   v4.3 design:
   1. Worker writes a heartbeat (updated_at) on every updateJob() call.
   2. This cron endpoint runs every 2 minutes, finds rows in
      ('running','paused','synthesising') whose updated_at is older than
      the stale threshold (or NULL for legacy jobs), and re-fires the
      worker for each.
   3. Frontend polling continues to work as before — it's now a live UI
      nicety, not the only mechanism keeping jobs alive.

   v4.3a FIX (8 Apr 2026) — parallel-fire bug:
   v4.3 used a 60s stale threshold. A single condense Claude call takes
   ~217s (per v4.2k logs). So while a worker was mid-call, the cron at
   the next 2-minute boundary saw seconds_since_update > 60 and fired a
   second worker invocation in parallel. Both workers raced on the same
   row, both got killed at the 300s Vercel ceiling, neither persisted a
   final heartbeat, and the job appeared frozen forever.
   This is the same bug class as the v4.2k frontend over-firing problem.

   Two layers of fix, both in this file (no worker changes):

   (1) STALE_SECONDS raised from 60 to 240. A genuinely-running worker
       can be silent for up to ~217s during a single condense call. 240s
       gives a comfortable margin without being so long that a truly-dead
       job waits forever for rescue. Worst case: a dead job is re-fired
       within 240s + 120s = 6 minutes, which is fine.

   (2) After firing the worker for a job, this endpoint stamps the row's
       updated_at itself. The next cron cycle 2 minutes later will see a
       fresh updated_at and skip the row, even if the worker we just fired
       hasn't actually written anything yet. This prevents back-to-back
       refires while a real worker is still warming up. The cycle after
       that (4 minutes from now) will only refire if the worker still
       hasn't moved the job forward. Per-job effective refire interval is
       therefore ~6 minutes minimum, well above any single Claude call.

   Why stamping updated_at from the cron is safe: the worker doesn't care
   who wrote the heartbeat — only that something is trying to push the
   job forward. The cron stamping it is a "rescue attempt in progress"
   marker. If the worker then writes a real heartbeat, that overwrites
   the cron's stamp with a more recent value, which is also fine.

   Authentication: this endpoint has NO auth. Vercel Cron calls it from
   outside the application. Anyone who knows the URL could trigger it,
   but the worst they can do is cause the worker to be re-fired for jobs
   that are already running. The worker is idempotent on re-entry
   (v4.2g/h/i/j fixes), so spurious calls are wasted compute, not
   corruption. For v4.4 a shared secret in a header would tighten this. */

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  /* Allow GET (Vercel Cron sends GET) and POST (for manual testing) */
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  /* Fresh client per invocation (same reasoning as v4.2j worker — avoid
     cached schema if columns change). */
  var supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  /* v4.3a: 240s threshold instead of 60s. See header comment for reasoning. */
  var STALE_SECONDS = 240;
  var staleCutoff = new Date(Date.now() - STALE_SECONDS * 1000).toISOString();

  /* Find in-progress jobs that haven't been touched in >STALE_SECONDS, OR
     that have a NULL updated_at (legacy jobs created before the v4.3
     migration — should be picked up at least once so they get a heartbeat). */
  var resp = await supabase
    .from("tool_jobs")
    .select("id, status, updated_at, started_at, matter_id")
    .in("status", ["running", "paused", "synthesising"])
    .or("updated_at.lt." + staleCutoff + ",updated_at.is.null")
    .limit(20);

  if (resp.error) {
    console.error("v4.3a cron-resume: query failed:", resp.error.message);
    return res.status(500).json({ error: resp.error.message });
  }

  var jobs = resp.data || [];
  console.log("v4.3a cron-resume: found " + jobs.length + " stale in-progress job(s) (threshold=" + STALE_SECONDS + "s)");

  if (jobs.length === 0) {
    return res.status(200).json({ resumed: 0, jobs: [] });
  }

  /* Build the worker URL. Vercel injects VERCEL_URL at runtime (without
     scheme). We prefer an explicit PUBLIC_BASE_URL env if present. */
  var baseUrl = process.env.PUBLIC_BASE_URL
    || (process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : null);
  if (!baseUrl) {
    console.error("v4.3a cron-resume: no base URL — set PUBLIC_BASE_URL or rely on VERCEL_URL");
    return res.status(500).json({ error: "No base URL configured" });
  }

  /* Fire-and-forget worker for each stale job. Stagger by 200ms so we don't
     hammer Vercel or the Anthropic API at exactly the same instant.

     v4.3a: After firing, immediately stamp the row's updated_at so the
     next cron cycle won't refire while the just-fired worker is starting
     up. This is the per-job cooldown layer. */
  var fired = [];
  var nowIso = new Date().toISOString();
  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    var url = baseUrl + "/api/worker?jobId=" + encodeURIComponent(job.id);

    /* Fire the worker (no await — fire and forget) */
    fetch(url, { method: "POST" }).catch(function(err) {
      console.error("v4.3a cron-resume: fire failed for " + job.id + ":", err && err.message);
    });

    /* v4.3a: Stamp the row's updated_at so we don't refire on the next cycle.
       Awaited so we know the stamp landed before reporting success. If the
       stamp fails, log it but don't abort — the worker may still rescue itself. */
    try {
      var stampResp = await supabase
        .from("tool_jobs")
        .update({ updated_at: nowIso })
        .eq("id", job.id);
      if (stampResp.error) {
        console.error("v4.3a cron-resume: stamp failed for " + job.id + ": " + stampResp.error.message);
      }
    } catch (stampErr) {
      console.error("v4.3a cron-resume: stamp threw for " + job.id + ":", stampErr && stampErr.message);
    }

    fired.push({ id: job.id, status: job.status, lastUpdate: job.updated_at });
    if (i < jobs.length - 1) {
      await new Promise(function(r) { setTimeout(r, 200); });
    }
  }

  console.log("v4.3a cron-resume: fired " + fired.length + " worker invocation(s)");
  return res.status(200).json({ resumed: fired.length, jobs: fired, threshold: STALE_SECONDS });
}
