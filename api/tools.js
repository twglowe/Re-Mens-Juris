/* EX LIBRIS JURIS v5.10a — tools.js (API)
   Thin job dispatcher: creates a tool_jobs row, fires worker, returns jobId.
   NO Claude API calls happen here. All processing is in worker.js.

   v5.10a CHANGES (27 Apr 2026) — Push v5.10a (Issues focus widget):
   1. Destructure subElement, focusDocNames from req.body. These are sent
      only by the Issues launch modal in this push; harmless no-ops for
      every other tool because they default to empty. The "Question to
      develop" textarea on the frontend reuses id="toolInstructions" so
      its value already arrives on body.instructions as today.
   2. Stored on parameters JSONB so the worker can read p.subElement and
      p.focusDocNames.
   3. Version banner bumped to v5.10a. No control-flow change.

   v5.8a CHANGES (24 Apr 2026) — Push H cleanup:
   1. createClient() moved inside the handler. At module scope it caches the
      PostgREST schema on first warm invocation and any column added by a
      later migration gets silently stripped from UPDATE/PATCH payloads.
      tools.js only ever INSERTs here (no silent-drop risk for INSERT), but
      the pattern is kept consistent across all API files — api/history.js
      and api/analyse.js did the same in v5.6a/f. Defensive.
   2. Version banner bumped to v5.8a. No other behavioural change.

   v4.2e (carried forward): Worker fetch is fire-and-forget (no await, no
   AbortController). If the worker doesn't start, the frontend polling loop
   detects "pending" status and re-fires the worker itself. No server-to-
   server chaining. */

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

async function getUser(supabase, req) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error) { console.error("Auth error:", error.message); return null; }
    return user;
  } catch (e) {
    console.error("Auth exception:", e.message);
    return null;
  }
}

const SERVER_VERSION = "v5.10a";
export default async function handler(req, res) {
  console.log(SERVER_VERSION + " tools handler: " + (req.method || "?") + " " + (req.url || ""));
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  /* v5.8a: Fresh client per invocation. See header comment. */
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const user = await getUser(supabase, req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { tool, matterId, matterName, matterNature, matterIssues, jurisdiction,
          anchorDocNames, instructions, actingFor, courtHeading,
          citationSource, citationTargets,
          chronologyDateRange, chronologyEntities, chronologyCorrespondenceFilter,
          caseTypeId, docTypeId, subcatId, libraryContext,
          excludeDocNames, excludeDocTypes, includeDocNames,
          subElement, focusDocNames } = req.body;

  if (!tool || !matterId) return res.status(400).json({ error: "tool and matterId required" });

  const validTools = ["proposition", "inconsistency", "chronology", "persons", "issues", "citations", "briefing", "draft", "issueBriefing"];
  if (!validTools.includes(tool)) return res.status(400).json({ error: "Unknown tool: " + tool });

  if (tool === "proposition" && !instructions) {
    return res.status(400).json({ error: "Please state the proposition to test" });
  }

  /* Store all parameters needed by the worker */
  const parameters = {
    matterName: matterName || "",
    matterNature: matterNature || "",
    matterIssues: matterIssues || "",
    jurisdiction: jurisdiction || "Bermuda",
    anchorDocNames: anchorDocNames || [],
    actingFor: actingFor || "",
    courtHeading: courtHeading || null,
    citationSource: citationSource || null,
    citationTargets: citationTargets || null,
    chronologyDateRange: chronologyDateRange || "",
    chronologyEntities: chronologyEntities || "",
    chronologyCorrespondenceFilter: chronologyCorrespondenceFilter || false,
    caseTypeId: caseTypeId || null,
    docTypeId: docTypeId || null,
    subcatId: subcatId || null,
    libraryContext: libraryContext || null,
    excludeDocNames: excludeDocNames || [],
    excludeDocTypes: excludeDocTypes || [],
    /* v5.0: folder filter. Frontend resolves folder selection → list of doc
       names and passes them here. Worker reads p.includeDocNames and filters
       chunks to only those documents. Empty/missing = no include filter. */
    includeDocNames: includeDocNames || [],
    /* v5.10a: Issues focus widget fields. Sent only by the Issues launch
       modal in this push; empty defaults for all other tools. The worker
       weaves these into the Issues synthesis prompt fragments alongside
       the existing instructions field. The "Question to develop" textarea
       on the frontend reuses id="toolInstructions" so its value arrives
       on body.instructions as today; we don't carry it again here.
       focusDocNames is option (b): a prompt instruction, not a chunk
       filter \u2014 model is told to focus on these documents but may
       still reference others. */
    subElement: subElement || "",
    focusDocNames: focusDocNames || [],
  };

  /* Create job row */
  const { data: job, error: insertError } = await supabase
    .from("tool_jobs")
    .insert({
      matter_id: matterId,
      user_id: user.id,
      tool_name: tool,
      status: "pending",
      instructions: instructions || "",
      parameters,
    })
    .select("id")
    .single();

  if (insertError) {
    console.error("Job insert error:", insertError);
    return res.status(500).json({ error: "Failed to create job: " + insertError.message });
  }

  /* Fire the worker — fire-and-forget.
     v4.2e: No AbortController, no await. The frontend polling loop handles
     retries if the worker doesn't start. */
  const workerUrl = `https://${req.headers.host}/api/worker?jobId=${job.id}`;
  fetch(workerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  }).catch(function(e) {
    console.log("Worker fire (expected):", e.message);
  });

  /* Brief delay to let the fetch reach the network */
  await new Promise(function(r) { setTimeout(r, 500); });

  /* Return jobId to frontend */
  return res.status(200).json({ jobId: job.id });
}
