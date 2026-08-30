/* EX LIBRIS JURIS v5.19 — cron-resume.js
   Vercel Cron job. Fires every 2 minutes (configured in vercel.json).

   v5.19 CHANGES (21 Jun 2026) — Step 3 (cron-resume hardening):
   The rescue cron used to stamp updated_at after firing the worker WITHOUT
   checking whether the fire landed. A bounced fire (e.g. a 401 from Vercel
   Deployment Protection) therefore marked the job "fresh", so it was never
   retried — a silent permanent freeze that looked healthy (this is what
   froze Thalassa). The 20 Jun config fix (PUBLIC_BASE_URL) removed that
   fire's cause; this change closes the TRAP so any FUTURE bounce cannot
   freeze a job silently.
     - The fire is now awaited with a short timeout so a bounced (non-2xx)
       response is seen instead of ignored.
     - updated_at is stamped ONLY when the fire landed (fast 2xx) or the
       worker accepted the job and went busy (no reply within the timeout —
       the v4.3a warm-up cooldown case). A bounced or network-failed fire is
       left stale on purpose, so the next cron cycle retries it.
     - We must not wait for the worker's real response (worker maxDuration
       800s vs this cron's 10s). A time budget keeps the loop well under 10s;
       jobs past the budget are deferred to the next cycle (safe — the
       staleness threshold is already 240s). Aborting our wait never stops
       the worker: once Vercel has invoked it, it runs to its own
       maxDuration independently (proven by closed-laptop completions).
   No worker.js change. One logical change, confined to the fire-and-stamp loop.

   v5.10c CHANGES (27 Apr 2026) — Push v5.10c (follow-ups survive sleep):
   v5.55 (30 Aug 2026): a second query rescues jobs stuck at "pending".
   The original SELECT covers running/paused/synthesising only, so a job whose
   initial worker fire never landed stayed pending and was never picked up by
   anything server-side — it started only when the user returned to the tab and
   the frontend re-fired it. Keyed on created_at rather than updated_at so a
   healthy freshly-created job is not fired twice. See the comment at the query.

   1. SELECT now includes tool_name so we can route the resume call to
      the correct worker.
   2. Worker URL is branched by tool_name prefix. Rows with tool_name
      starting "followup:" are resumed via /api/analyseWorker; launch
      jobs continue to /api/worker. The status filter is unchanged —
      both kinds of job use the same 'running'/'paused'/'synthesising'
      statuses, so the existing stale-detection logic applies to both.
   3. Version banner bumped to v5.10c.

   v4.3a — cron-resume.js (carried forward)
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

const SERVER_VERSION = "v5.19";
export default async function handler(req, res) {
  console.log(SERVER_VERSION + " cron-resume handler: " + (req.method || "?") + " " + (req.url || ""));
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
    .select("id, status, updated_at, started_at, matter_id, tool_name")
    .in("status", ["running", "paused", "synthesising"])
    .or("updated_at.lt." + staleCutoff + ",updated_at.is.null")
    .limit(20);

  if (resp.error) {
    console.error("v4.3a cron-resume: query failed:", resp.error.message);
    return res.status(500).json({ error: resp.error.message });
  }

  var jobs = resp.data || [];

  /* v5.55: also rescue jobs still sitting at "pending".

     api/tools.js creates the row with status "pending" and fires the worker
     fire-and-forget. If that fire never lands, the job stays "pending" — and
     the query above never sees it, because "pending" is not in the status
     list. Nothing server-side ever picked such a job up. The only thing that
     started it was the frontend's own re-fire, which runs while the user sits
     on the tab polling. So a draft begun and then left alone could wait
     indefinitely, and appear to start only when the user returned.

     Deliberately a SEPARATE query keyed on created_at, not updated_at: a row
     created seconds ago may have a null or fresh updated_at, and the existing
     or-clause above would match a null immediately. Requiring created_at to be
     older than the same 240s threshold means a healthy job — where the initial
     fire did land and the frontend is polling — is never fired a second time.

     Failure mode: a job that has been pending for over 240s while the frontend
     is at that moment re-firing it could be fired twice, and api/worker.js
     only refuses jobs already "complete" or "failed", not ones already
     running. Mitigation: after four minutes without leaving "pending", the
     frontend's re-fire is demonstrably not succeeding, so firing is the
     correct action. The residual double-fire window is accepted for v5.55; a
     claim-on-start guard in worker.js is the proper fix and is a separate
     push, because worker.js is the highest blast-radius file in the codebase. */
  var pendResp = await supabase
    .from("tool_jobs")
    .select("id, status, updated_at, started_at, matter_id, tool_name")
    .eq("status", "pending")
    .lt("created_at", staleCutoff)
    .limit(20);

  if (pendResp.error) {
    /* Non-fatal: the existing rescue still runs. */
    console.error(SERVER_VERSION + " cron-resume: pending query failed:", pendResp.error.message);
  } else if (pendResp.data && pendResp.data.length) {
    console.log(SERVER_VERSION + " cron-resume: found " + pendResp.data.length + " job(s) stuck at pending for >" + STALE_SECONDS + "s");
    jobs = jobs.concat(pendResp.data).slice(0, 20);
  }
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

  /* Fire the worker for each stale job, then decide whether to stamp updated_at
     based on whether the fire actually LANDED. (v5.19 — Step 3.)

     The old code fired fire-and-forget and stamped unconditionally, so a fire
     that bounced (e.g. a 401 from Deployment Protection) still marked the job
     fresh — a silent permanent freeze. We now await the fire briefly:

       - fast 2xx          -> fire landed            -> stamp
       - fast non-2xx      -> fire BOUNCED (the trap) -> DO NOT stamp; retry next cycle
       - no reply in time  -> worker accepted & busy  -> stamp (v4.3a warm-up cooldown)
       - network error     -> fire did not land       -> DO NOT stamp; retry next cycle

     Why only a SHORT wait: a busy worker holds its connection open while it
     works (worker maxDuration 800s) but this cron's maxDuration is only 10s, so
     we must NOT wait for the worker's real response. Aborting our wait does not
     stop the worker — once Vercel has invoked it, it runs to its own
     maxDuration independently (proven by closed-laptop completions); the abort
     only ends OUR wait so we can read the status quickly.

     TIME_BUDGET_MS keeps the whole loop well under the 10s ceiling. If many
     jobs are stale at once (rare for a single user), jobs past the budget are
     left for the next cron cycle — they stay stale, so they are picked up in
     ~2 minutes. Deferring is safe: the staleness threshold is already 240s. */
  var FIRE_TIMEOUT_MS = 2000;
  var TIME_BUDGET_MS = 7500;
  var loopStart = Date.now();
  var fired = [];
  var deferred = 0;
  for (var i = 0; i < jobs.length; i++) {
    if (Date.now() - loopStart > TIME_BUDGET_MS) {
      deferred = jobs.length - i;
      console.log(SERVER_VERSION + " cron-resume: time budget reached — deferring " + deferred + " job(s) to next cycle");
      break;
    }

    var job = jobs[i];
    /* v5.10c: branch the worker URL by tool_name. Follow-up jobs
       (tool_name starts with 'followup:') go to /api/analyseWorker;
       launch jobs continue to /api/worker as before. */
    var isFollowup = typeof job.tool_name === "string" && job.tool_name.indexOf("followup:") === 0;
    var workerPath = isFollowup ? "/api/analyseWorker" : "/api/worker";
    var url = baseUrl + workerPath + "?jobId=" + encodeURIComponent(job.id);

    var shouldStamp = true;   /* default: stamp, preserving the v4.3a cooldown */
    var fireNote = "";

    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, FIRE_TIMEOUT_MS);
    try {
      var fireResp = await fetch(url, { method: "POST", signal: controller.signal });
      clearTimeout(timer);
      if (fireResp.status >= 200 && fireResp.status < 300) {
        fireNote = "fire ok (" + fireResp.status + ")";
      } else {
        /* The trap this change exists to close: a bounced fire must NOT mark
           the job fresh, or it freezes silently. Leave it stale for retry. */
        shouldStamp = false;
        fireNote = "fire BOUNCED (" + fireResp.status + ") — not stamping; will retry next cycle";
        console.error(SERVER_VERSION + " cron-resume: worker fire returned " + fireResp.status + " for job " + job.id + " at " + url + " — leaving job stale for retry");
      }
    } catch (fireErr) {
      clearTimeout(timer);
      if (fireErr && fireErr.name === "AbortError") {
        /* No reply within FIRE_TIMEOUT_MS: the worker accepted the job and is
           busy. Healthy warm-up case — stamp to apply the v4.3a cooldown. */
        fireNote = "no reply in " + FIRE_TIMEOUT_MS + "ms — worker accepted & busy; stamping";
      } else {
        /* A real network error reaching the worker: the fire did not land. */
        shouldStamp = false;
        fireNote = "fire network error (" + (fireErr && fireErr.message) + ") — not stamping; will retry next cycle";
        console.error(SERVER_VERSION + " cron-resume: worker fire network error for job " + job.id + ": " + (fireErr && fireErr.message));
      }
    }

    if (shouldStamp) {
      try {
        var stampResp = await supabase
          .from("tool_jobs")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", job.id);
        if (stampResp.error) {
          console.error(SERVER_VERSION + " cron-resume: stamp failed for " + job.id + ": " + stampResp.error.message);
        }
      } catch (stampErr) {
        console.error(SERVER_VERSION + " cron-resume: stamp threw for " + job.id + ":", stampErr && stampErr.message);
      }
    }

    console.log(SERVER_VERSION + " cron-resume: job " + job.id + " (" + job.tool_name + ") — " + fireNote);
    fired.push({ id: job.id, status: job.status, lastUpdate: job.updated_at, fire: fireNote, stamped: shouldStamp });

    if (i < jobs.length - 1) {
      await new Promise(function(r) { setTimeout(r, 200); });
    }
  }

  console.log(SERVER_VERSION + " cron-resume: fired " + fired.length + " worker invocation(s); deferred " + deferred);
  return res.status(200).json({ resumed: fired.length, deferred: deferred, jobs: fired, threshold: STALE_SECONDS });
}
