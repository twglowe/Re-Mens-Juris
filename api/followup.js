/* EX LIBRIS JURIS v5.10c — followup.js (NEW FILE)
   Thin job dispatcher for tool follow-ups: creates a tool_jobs row,
   fires analyseWorker, returns jobId.

   v5.10c PURPOSE (27 Apr 2026):
   Before this push, follow-ups went via /api/analyse — a single
   synchronous fetch. If the user closed the laptop mid-fetch, the
   browser suspended the connection and on wake the fetch died with
   "load failed". The answer never arrived and no row was written to
   conversation_history.

   This file mirrors api/tools.js for the launch flow: it INSERTs a
   tool_jobs row, fires the worker fire-and-forget, and returns the
   jobId for the frontend to poll. The actual Claude call moves to
   api/analyseWorker.js.

   tool_name convention: 'followup:issues', 'followup:briefing',
   'followup:chronology', etc. The original tool is also stored on
   parameters.originalTool for the worker's prompt assembly. The colon
   prefix is used by cron-resume.js to decide which worker URL to fire.

   parameters JSONB carries:
     - originalTool          string (e.g. 'issues')
     - matterName/Nature/Issues, jurisdiction, actingFor (matter context)
     - question              string (the user's follow-up question)
     - currentResult         string (first 8000 chars of main result for context)
     - mainRowId             uuid|null (parent conversation_history row;
                             null forces fallback to a separate insert)
     - subElement            string (Issues focus widget — empty if unset)
     - freeformFocus         string (Issues focus widget — empty if unset)
     - focusDocNames         string[] (Issues focus widget — empty if unset)

   Status convention matches launches: 'pending' -> 'running' -> 'complete'
   on success, 'failed' on error. Polling reads /api/jobs?id=... and gets
   `result` back when status === 'complete'.

   No Claude API calls happen here. createClient() is inside the handler
   per the standing rule about module-scope schema cache.
*/

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

const SERVER_VERSION = "v5.10c";
export default async function handler(req, res) {
  console.log(SERVER_VERSION + " followup handler: " + (req.method || "?") + " " + (req.url || ""));
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const user = await getUser(supabase, req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const {
    matterId, matterName, matterNature, matterIssues, jurisdiction, actingFor,
    originalTool, question, currentResult, mainRowId,
    subElement, freeformFocus, focusDocNames
  } = req.body;

  if (!matterId)     return res.status(400).json({ error: "matterId required" });
  if (!originalTool) return res.status(400).json({ error: "originalTool required" });
  if (!question || typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "question required" });
  }

  /* Build parameters JSONB — everything analyseWorker.js will need.
     Empty defaults so the worker can read fields unconditionally. */
  const parameters = {
    originalTool: String(originalTool),
    matterName:   matterName   || "",
    matterNature: matterNature || "",
    matterIssues: matterIssues || "",
    jurisdiction: jurisdiction || "Bermuda",
    actingFor:    actingFor    || "",
    question:     question,
    currentResult: typeof currentResult === "string" ? currentResult.slice(0, 8000) : "",
    mainRowId:    mainRowId || null,
    subElement:   subElement || "",
    freeformFocus: freeformFocus || "",
    focusDocNames: Array.isArray(focusDocNames) ? focusDocNames : [],
  };

  /* Create job row. tool_name = 'followup:<originalTool>' so the row is
     visibly distinct from a launch job at the database level. */
  const toolName = "followup:" + String(originalTool);
  const { data: job, error: insertError } = await supabase
    .from("tool_jobs")
    .insert({
      matter_id: matterId,
      user_id: user.id,
      tool_name: toolName,
      status: "pending",
      instructions: question,
      parameters,
    })
    .select("id")
    .single();

  if (insertError) {
    console.error("Followup job insert error:", insertError);
    return res.status(500).json({ error: "Failed to create follow-up job: " + insertError.message });
  }

  /* Fire the analyseWorker — fire-and-forget. The frontend polling loop
     handles re-firing if this fails (mirrors the launch pattern in
     api/tools.js). */
  const workerUrl = `https://${req.headers.host}/api/analyseWorker?jobId=${job.id}`;
  fetch(workerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  }).catch(function(e) {
    console.log("AnalyseWorker fire (expected):", e.message);
  });

  /* Brief delay to let the fetch reach the network */
  await new Promise(function(r) { setTimeout(r, 500); });

  return res.status(200).json({ jobId: job.id });
}
