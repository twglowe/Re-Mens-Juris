/* EX LIBRIS JURIS v5.8a — api/lib/sectioned_synth.js
   Pure helpers for the sectioned-synthesis pipeline. Extracted from worker.js
   for testability: these functions take `runTool` and `updateJob` as
   parameters so the unit tests can stub them without hitting Anthropic or
   Supabase. Production code in worker.js imports these and passes in the
   real runTool and updateJob.

   Functions exported:
     - parsePlan(text)              pure parser, no side effects
     - planSections(...)            plan phase, needs runTool injected
     - synthesiseSections(...)      section loop, needs runTool + updateJob
     - MAX_SECTIONS, MIN_SECTION_WORDS, MAX_SECTION_WORDS (constants) */

export const MAX_SECTIONS = 12;
export const MIN_SECTION_WORDS = 150;
export const MAX_SECTION_WORDS = 2500;
export const PLAN_PARSE_ATTEMPTS = 2;

/* Parse the model's plan response into a normalised array. Returns null if
   the response is unparseable so the caller can retry. Accepts either a bare
   JSON array or a JSON object with a "sections" field, and tolerates the
   model wrapping the JSON in ```json fences. */
export function parsePlan(text) {
  if (!text || typeof text !== "string") return null;
  let trimmed = text.trim();
  /* Strip ```json fences if present */
  if (trimmed.indexOf("```") === 0) {
    const firstNewline = trimmed.indexOf("\n");
    if (firstNewline !== -1) trimmed = trimmed.slice(firstNewline + 1);
    const lastFence = trimmed.lastIndexOf("```");
    if (lastFence !== -1) trimmed = trimmed.slice(0, lastFence);
    trimmed = trimmed.trim();
  }
  let parsed;
  try { parsed = JSON.parse(trimmed); }
  catch (e) { return null; }

  let arr;
  if (Array.isArray(parsed)) arr = parsed;
  else if (parsed && Array.isArray(parsed.sections)) arr = parsed.sections;
  else return null;

  if (arr.length === 0) return null;
  if (arr.length > MAX_SECTIONS) arr = arr.slice(0, MAX_SECTIONS);

  const normalised = [];
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i] || {};
    const title = (typeof s.title === "string" ? s.title : "").trim();
    const description = (typeof s.description === "string" ? s.description : "").trim();
    let targetWords = s.target_words;
    if (typeof targetWords !== "number" || !isFinite(targetWords)) targetWords = 500;
    if (targetWords < MIN_SECTION_WORDS) targetWords = MIN_SECTION_WORDS;
    if (targetWords > MAX_SECTION_WORDS) targetWords = MAX_SECTION_WORDS;
    normalised.push({
      index: i + 1,
      title: title || ("Section " + (i + 1)),
      description: description,
      target_words: Math.round(targetWords),
    });
  }
  return normalised;
}

/* Ask the model to propose a section list. `runTool` is injected for
   testability — production passes the real runTool from worker.js, tests
   pass a stub. */
export async function planSections(runTool, systemBase, toolName, instructions, synthInput, actingFor, matterName) {
  const toolDescriptions = {
    briefing: "a briefing note for senior litigation counsel. The reader will read the entire document.",
    draft: "a legal drafting document (skeleton argument, witness statement, affidavit, or similar). The draft must read as a finished work product.",
    proposition: "an evidence assessment analysing whether the available material supports a specific proposition. Output includes per-document gradings and an overall assessment.",
  };
  const what = toolDescriptions[toolName] || ("a " + toolName + " output");

  const planSystem = systemBase + "\n\nYou are now planning the STRUCTURE of " + what;

  const planPrompt =
    "You are about to produce " + what + "\n\n" +
    "Before writing the full output, plan its structure. Decide on the sections needed given the material below and the user's instructions. " +
    "Return ONLY a JSON array. No preamble, no commentary, no code fences. Each array entry must be an object with these fields:\n\n" +
    "  - title:         short section heading (string)\n" +
    "  - description:   one-line description of what this section covers (string)\n" +
    "  - target_words:  approximate target length in words for this section (integer between " + MIN_SECTION_WORDS + " and " + MAX_SECTION_WORDS + ")\n\n" +
    "Guidance:\n" +
    "  - Aim for " + (toolName === "draft" ? "5 to 10" : "4 to 8") + " sections in most cases. Maximum " + MAX_SECTIONS + ".\n" +
    "  - target_words should reflect the material weight, not a uniform default. A section covering the key disputed issues will usually be longer than a summary or procedural-stage section.\n" +
    "  - The section list must cover the full scope of the output without overlap.\n" +
    "  - Section titles should be specific to this matter, not generic. For example 'Disputed Matters: Quantum and Allocation' is better than 'The Issues'.\n\n" +
    (instructions ? "USER INSTRUCTIONS: " + instructions + "\n\n" : "") +
    (actingFor ? "ACTING FOR: " + actingFor + "\n\n" : "") +
    "MATTER: " + (matterName || "(unnamed)") + "\n\n" +
    "CONDENSED SOURCE MATERIAL:\n\n" + synthInput + "\n\n" +
    "Return the JSON array now.";

  let lastError = null;
  for (let attempt = 1; attempt <= PLAN_PARSE_ATTEMPTS; attempt++) {
    let planCall;
    try {
      planCall = await runTool(planSystem, planPrompt, 2048);
    } catch (err) {
      throw new Error("Plan phase failed at attempt " + attempt + ": " + (err.message || err));
    }
    const parsed = parsePlan(planCall.text);
    if (parsed) {
      return {
        sections: parsed,
        inputTokens: planCall.inputTokens,
        outputTokens: planCall.outputTokens,
        cost: planCall.cost,
      };
    }
    lastError = "Unparseable plan output on attempt " + attempt + " (first 200 chars: " + (planCall.text || "").slice(0, 200) + ")";
    console.log("v5.8a planSections: " + lastError);
  }
  throw new Error("Plan phase failed: " + (lastError || "no plan produced after " + PLAN_PARSE_ATTEMPTS + " attempts"));
}

/* Run one Claude call per planned section. `runTool` and `updateJob` are
   injected. `updateJob` may be null/omitted in tests that don't care about
   persistence. */
export async function synthesiseSections(runTool, updateJob, jobId, job, systemBase, toolName, instructions, synthInput, sections, actingFor, matterName, headerText) {
  const prior = Array.isArray(job.section_results) ? job.section_results : [];
  const results = prior.slice();
  while (results.length < sections.length) results.push(null);

  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;
  const failed = [];

  for (let i = 0; i < sections.length; i++) {
    if (results[i] && typeof results[i].text === "string") continue;
    const sec = sections[i];
    const sectionBudget = Math.min(MAX_SECTION_WORDS * 2, Math.max(1024, sec.target_words * 2));

    let precedingContext = "";
    for (let j = 0; j < i; j++) {
      if (results[j] && results[j].text) {
        const snippet = results[j].text.slice(0, 400);
        precedingContext += "### Section " + (j + 1) + " (" + sections[j].title + ") [first 400 chars]\n" + snippet + "\n\n";
      }
    }

    const sectionPrompt =
      "You are writing section " + sec.index + " of " + sections.length + " for " + (toolName === "briefing" ? "a briefing note" : toolName === "draft" ? "a legal drafting document" : "an evidence assessment") + ".\n\n" +
      "SECTION " + sec.index + ": " + sec.title + "\n" +
      (sec.description ? "(" + sec.description + ")\n" : "") +
      "Target length: approximately " + sec.target_words + " words.\n\n" +
      "Output ONLY the body of this section. Start with a Markdown heading '## " + sec.title + "' and then the section's content. Do not write any other section's content. Do not repeat content from earlier sections.\n\n" +
      (precedingContext ? "FOR CONTEXT — summaries of preceding sections:\n\n" + precedingContext + "\n" : "") +
      "FULL OUTLINE OF ALL SECTIONS (for context on what belongs where, so you avoid duplicating later sections):\n" +
      sections.map(function(s) { return "  " + s.index + ". " + s.title + (s.description ? " — " + s.description : ""); }).join("\n") + "\n\n" +
      (instructions ? "USER INSTRUCTIONS: " + instructions + "\n\n" : "") +
      (actingFor ? "ACTING FOR: " + actingFor + "\n\n" : "") +
      "CONDENSED SOURCE MATERIAL:\n\n" + synthInput;

    const sectionStart = Date.now();
    try {
      const r = await runTool(systemBase, sectionPrompt, sectionBudget);
      results[i] = {
        index: sec.index,
        title: sec.title,
        text: r.text,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cost: r.cost,
        elapsed_s: Math.round((Date.now() - sectionStart) / 1000),
      };
      totalInput += r.inputTokens;
      totalOutput += r.outputTokens;
      totalCost += r.cost;
    } catch (err) {
      results[i] = {
        index: sec.index,
        title: sec.title,
        text: null,
        error: err.message || String(err),
      };
      failed.push(sec.index);
    }

    if (updateJob) {
      try {
        await updateJob(jobId, { section_results: results });
      } catch (persistErr) {
        console.error("v5.8a synthesiseSections: progress persist failed for section " + sec.index + ": " + persistErr.message);
      }
    }
  }

  const pieces = [];
  if (headerText) pieces.push(headerText);
  if (failed.length > 0) {
    pieces.push(
      "> **Note:** " + failed.length + " section" + (failed.length === 1 ? "" : "s") + " failed after all retries and " + (failed.length === 1 ? "is" : "are") + " missing from the output below: section" + (failed.length === 1 ? "" : "s") + " " + failed.join(", ") + ". The remaining sections completed normally. You can regenerate this tool to retry the missing section" + (failed.length === 1 ? "" : "s") + "."
    );
  }
  for (let k = 0; k < results.length; k++) {
    const rk = results[k];
    if (rk && rk.text) {
      pieces.push(rk.text.trim());
    } else if (rk) {
      pieces.push("## " + rk.title + "\n\n*This section failed to generate. See note above.*");
    }
  }
  const assembled = pieces.join("\n\n");

  return {
    text: assembled,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cost: totalCost,
    failedSections: failed,
    sectionsCompleted: sections.length - failed.length,
  };
}
