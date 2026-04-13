/* EX LIBRIS JURIS v4.2e — tools.js (API)
   Thin job dispatcher: creates a tool_jobs row, fires worker, returns jobId.
   NO Claude API calls happen here. All processing is in worker.js.

   v4.2e: Worker fetch is fire-and-forget (no await, no AbortController).
   If the worker doesn't start, the frontend polling loop detects "pending"
   status and re-fires the worker itself. No server-to-server chaining. */

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function getUser(req) {
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

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { tool, matterId, matterName, matterNature, matterIssues, jurisdiction,
          anchorDocNames, instructions, actingFor, courtHeading,
          citationSource, citationTargets,
          chronologyDateRange, chronologyEntities, chronologyCorrespondenceFilter,
          caseTypeId, docTypeId, subcatId, libraryContext,
          excludeDocNames, excludeDocTypes, includeDocNames } = req.body;

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
