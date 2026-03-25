/* EX LIBRIS JURIS v3.4.1 — tools.js
   Thin job dispatcher: creates a tool_jobs row, fires worker, returns jobId.
   NO Claude API calls happen here. All processing is in worker.js.

   v3.4.1 FIX: The worker fetch is now awaited with a 5-second timeout.
   Previously the non-awaited fetch was killed when Vercel terminated the
   tools.js function after sending its response. The AbortController timeout
   ensures we wait long enough for the worker to receive the request, but
   still return the jobId quickly to the frontend. */

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
          excludeDocNames, excludeDocTypes } = req.body;

  if (!tool || !matterId) return res.status(400).json({ error: "tool and matterId required" });

  const validTools = ["proposition", "inconsistency", "chronology", "persons", "issues", "citations", "briefing", "draft"];
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

  /* Fire the worker with a 5-second timeout.
     We AWAIT this so Vercel doesn't kill the in-flight request.
     The AbortController ensures we don't wait for the full worker run.
     The worker responds quickly with { ok: true } then continues processing
     because it defers its real work via its own internal logic. */
  const workerUrl = `https://${req.headers.host}/api/worker?jobId=${job.id}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    await fetch(workerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (e) {
    /* Timeout or network error — worker may still be starting.
       This is not fatal; the worker runs independently once started. */
    console.log("Worker fire (expected timeout or abort):", e.message);
  }

  /* Return jobId to frontend */
  return res.status(200).json({ jobId: job.id });
}
