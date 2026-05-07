/* EX LIBRIS JURIS v5.17 — tools.js (API)
   Thin job dispatcher: creates a tool_jobs row, fires worker, returns jobId.
   NO Claude API calls happen here. All processing is in worker.js.

   v5.17 CHANGES (07 May 2026) — Push C (server-side draft persistence):
   1. When tool === 'draft', create a drafts row in the drafts table BEFORE
      firing the worker. The row is created with empty draft_content; the
      worker UPDATEs it on completion. This eliminates the lost-draft bug:
      the row exists regardless of whether the browser polling loop is alive
      when the worker finishes.
   2. The new row's id is stored on parameters.draftRowId so the worker can
      find it. Backward compatibility: jobs started before this push lack
      draftRowId; the worker falls back to the old behaviour for those.
   3. Response now returns { jobId, draftRowId } for draft jobs, just
      { jobId } for every other tool. Frontend uses draftRowId to populate
      currentDraftId immediately, before the worker runs.
   4. If the drafts row insert fails, the whole request fails (500) BEFORE
      the tool_jobs row or worker fire. Cleaner failure mode than creating
      a tool_jobs row whose work would be lost.
   5. Version banner bumped to v5.17. No control-flow change for any other
      tool.

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

const SERVER_VERSION = "v5.17";
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

  /* v5.17 Push C: for draft jobs, create the drafts row FIRST so the worker
     can write to it on completion. If this insert fails, we fail the whole
     request before creating a tool_jobs row \u2014 cleaner than creating a
     tool_jobs row whose result would be lost. The row is created with empty
     draft_content; worker UPDATEs it on completion. */
  let draftRowId = null;
  if (tool === "draft") {
    const draftInsert = await supabase
      .from("drafts")
      .insert({
        matter_id: matterId,
        owner_id: user.id,
        case_type_id: caseTypeId || null,
        subcat_id: subcatId || null,
        doc_type_id: docTypeId || null,
        heading_data: courtHeading || {},
        instructions: instructions || "",
        draft_content: "",
        conversation: []
      })
      .select("id")
      .single();
    if (draftInsert.error) {
      console.error("Draft row insert error:", draftInsert.error);
      return res.status(500).json({ error: "Failed to create draft row: " + draftInsert.error.message });
    }
    draftRowId = draftInsert.data.id;
    console.log("v5.17 created drafts row " + draftRowId + " for upcoming worker run");
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
    /* v5.17 Push C: for draft jobs only, the id of the drafts row created
       above. Worker UPDATEs this row on completion. Null for non-draft
       tools and for draft jobs started before v5.17 deploys. The worker
       falls back to old behaviour when this is null/missing. */
    draftRowId: draftRowId,
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
    /* v5.17: if we created a drafts row above, clean it up so we don't leave
       an orphan empty row in the drafts table. Best-effort \u2014 if cleanup
       itself fails, log and move on; the user retries and gets a fresh row. */
    if (draftRowId) {
      try {
        await supabase.from("drafts").delete().eq("id", draftRowId).eq("owner_id", user.id);
        console.log("v5.17 cleaned up orphan drafts row " + draftRowId + " after tool_jobs insert failure");
      } catch (cleanupErr) {
        console.error("Orphan drafts row cleanup failed for " + draftRowId + ":", cleanupErr.message);
      }
    }
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

  /* v5.17 Push C: response now includes draftRowId for draft jobs so the
     frontend can attach currentDraftId immediately. null/absent for every
     other tool. */
  return res.status(200).json({ jobId: job.id, draftRowId: draftRowId });
}
