/* EX LIBRIS JURIS v4.3 — cron-resume.js
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
      60 seconds (or NULL for legacy jobs), and re-fires the worker for each.
   3. Frontend polling continues to work as before — it's now a live UI
      nicety, not the only mechanism keeping jobs alive.

   Authentication: this endpoint has NO auth. Vercel Cron calls it from
   outside the application. Anyone who knows the URL could trigger it, but
   the worst they can do is cause the worker to be re-fired for jobs that
   are already running. The worker is idempotent on re-entry (v4.2g/h/i/j
   fixes), so spurious calls are wasted compute, not corruption.
   For v4.4 a shared secret in a header would tighten this. */

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

  var STALE_SECONDS = 60;
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
    console.error("v4.3 cron-resume: query failed:", resp.error.message);
    return res.status(500).json({ error: resp.error.message });
  }

  var jobs = resp.data || [];
  console.log("v4.3 cron-resume: found " + jobs.length + " stale in-progress job(s)");

  if (jobs.length === 0) {
    return res.status(200).json({ resumed: 0, jobs: [] });
  }

  /* Build the worker URL. Vercel injects VERCEL_URL at runtime (without
     scheme). We prefer an explicit PUBLIC_BASE_URL env if present. */
  var baseUrl = process.env.PUBLIC_BASE_URL
    || (process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : null);
  if (!baseUrl) {
    console.error("v4.3 cron-resume: no base URL — set PUBLIC_BASE_URL or rely on VERCEL_URL");
    return res.status(500).json({ error: "No base URL configured" });
  }

  /* Fire-and-forget worker for each stale job. Stagger by 200ms so we don't
     hammer Vercel or the Anthropic API at exactly the same instant. */
  var fired = [];
  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    var url = baseUrl + "/api/worker?jobId=" + encodeURIComponent(job.id);
    /* No await — fire and forget. Capture promise just to avoid unhandled
       rejection warnings in the function logs. */
    fetch(url, { method: "POST" }).catch(function(err) {
      console.error("v4.3 cron-resume: fire failed for " + job.id + ":", err && err.message);
    });
    fired.push({ id: job.id, status: job.status, lastUpdate: job.updated_at });
    if (i < jobs.length - 1) {
      await new Promise(function(r) { setTimeout(r, 200); });
    }
  }

  console.log("v4.3 cron-resume: fired " + fired.length + " worker invocation(s)");
  return res.status(200).json({ resumed: fired.length, jobs: fired });
}
