/* EX LIBRIS JURIS v5.76 — api/lib/sectioned_synth.js
   Pure helpers for the sectioned-synthesis pipeline. Extracted from worker.js
   for testability: these functions take `runTool` and `updateJob` as
   parameters so the unit tests can stub them without hitting Anthropic or
   Supabase. Production code in worker.js imports these and passes in the
   real runTool and updateJob.

   v5.76 (focus and restraint, with the v5.75 style guide):
   Long outputs drifted in their later sections. Three causes in this file:
     1. A section saw only the first 400 characters of each earlier section,
        so late sections could not see the argument already made and either
        repeated it or wandered off it. Each section now sees the document so
        far in full, up to PRIOR_TEXT_CAP characters (most recent first).
     2. target_words was a target with a floor, so a thin section was padded
        to reach it. It is now a ceiling: the prompt says shorter is fine.
     3. The plan named sections but not what each was for. Each planned
        section now carries a `point` (the proposition it establishes) and a
        `basis` (what supports it), the planner is told to leave out
        unsupported sections, and the section prompt holds the writer to its
        point.
   Also:
     - `opts.structure`: a fixed section list the planner must follow. The
       briefing note's seven sections were only used on the fallback path
       until now; the planner invented its own.
     - `opts.numbered`: paragraphs number continuously across sections
       (style guide section 2), carried by lastParagraphNumber().
     - `opts.collectPoints`: each section writes its Points to check below
       POINTS_MARKER; they are stripped from the section and assembled into
       one list at the end (style guide section 6), instead of one list per
       section.
   Stored plans from before v5.76 have no point or basis; every use of them
   tolerates their absence, so a job resumed across the deploy completes.

   Functions exported:
     - parsePlan(text)              pure parser, no side effects
     - planSections(...)            plan phase, needs runTool injected
     - synthesiseSections(...)      section loop, needs runTool + updateJob
     - lastParagraphNumber(text)    pure
     - splitPoints(text)            pure
     - constants below */

export const MAX_SECTIONS = 12;
export const MIN_SECTION_WORDS = 150;
export const MAX_SECTION_WORDS = 2500;
export const PLAN_PARSE_ATTEMPTS = 2;
export const PLAN_MAX_TOKENS = 3000;
/* About 15k tokens. Sits in the user message, below the cache breakpoint, so
   it is billed at the full rate on every section after the first. */
export const PRIOR_TEXT_CAP = 60000;
export const PRIOR_SNIPPET_CHARS = 400;
export const POINTS_MARKER = "<<<POINTS TO CHECK>>>";

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
    const point = (typeof s.point === "string" ? s.point : "").trim();
    const basis = (typeof s.basis === "string" ? s.basis : "").trim();
    let targetWords = s.target_words;
    if (typeof targetWords !== "number" || !isFinite(targetWords)) targetWords = 500;
    if (targetWords < MIN_SECTION_WORDS) targetWords = MIN_SECTION_WORDS;
    if (targetWords > MAX_SECTION_WORDS) targetWords = MAX_SECTION_WORDS;
    normalised.push({
      index: i + 1,
      title: title || ("Section " + (i + 1)),
      description: description,
      point: point,
      basis: basis,
      target_words: Math.round(targetWords),
    });
  }
  return normalised;
}

/* The highest top-level paragraph number in a piece of text: lines that start
   "12. " or "**12.** ". Sub-paragraphs ("12.1") and Markdown headings
   ("## 2. The Issues") do not count. Returns 0 when there are none. */
export function lastParagraphNumber(text) {
  if (!text || typeof text !== "string") return 0;
  const re = /^[ \t]*(?:\*\*)?(\d{1,4})\.(?:\*\*)?[ \t]+\S/gm;
  let max = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

/* Split a section's output at POINTS_MARKER. Returns the body without the
   marker and the points as an array of one-line items. Bullets are stripped
   so assembly can re-bullet consistently; "none" lines are dropped. */
export function splitPoints(text) {
  if (!text || typeof text !== "string") return { body: text || "", points: [] };
  const at = text.indexOf(POINTS_MARKER);
  if (at === -1) return { body: text, points: [] };
  const body = text.slice(0, at).replace(/\s+$/, "");
  const points = text.slice(at + POINTS_MARKER.length)
    .split("\n")
    .map(function (l) { return l.replace(/^[ \t]*(?:[-*•]|\d+[.)])[ \t]+/, "").trim(); })
    .filter(function (l) { return l.length > 0 && !/^(none|n\/a|nil)\.?$/i.test(l); });
  return { body: body, points: points };
}

const TOOL_DESCRIPTIONS = {
  briefing: "a briefing note for senior litigation counsel. The reader will read the entire document.",
  draft: "a legal drafting document (skeleton argument, witness statement, affidavit, or similar). The draft must read as a finished work product.",
  proposition: "an evidence assessment analysing whether the available material supports a specific proposition. Output includes per-document gradings and an overall assessment.",
};

function toolLabel(toolName) {
  return toolName === "briefing" ? "a briefing note" : toolName === "draft" ? "a legal drafting document" : "an evidence assessment";
}

/* Ask the model to propose a section list. `runTool` is injected for
   testability — production passes the real runTool from worker.js, tests
   pass a stub. opts.structure, when given, is a fixed section list the plan
   must follow. */
export async function planSections(runTool, systemBase, toolName, instructions, synthInput, actingFor, matterName, opts) {
  const o = opts || {};
  const what = TOOL_DESCRIPTIONS[toolName] || ("a " + toolName + " output");

  const planSystem = systemBase + "\n\nYou are now planning the STRUCTURE of " + what;

  const planPrompt =
    "You are about to produce " + what + "\n\n" +
    "Before writing the full output, plan its structure. Decide on the sections needed given the material below and the user's instructions. " +
    "Return ONLY a JSON array. No preamble, no commentary, no code fences. Each array entry must be an object with these fields:\n\n" +
    "  - title:         short section heading, a noun phrase with no argument in it (string)\n" +
    "  - point:         one sentence: the proposition this section establishes, or for a descriptive section, exactly what it covers (string)\n" +
    "  - basis:         the documents or authorities in the material below that support that point (string)\n" +
    "  - description:   one-line description of what this section covers (string)\n" +
    "  - target_words:  the MOST words this section may use (integer between " + MIN_SECTION_WORDS + " and " + MAX_SECTION_WORDS + ")\n\n" +
    "Guidance:\n" +
    "  - Aim for " + (toolName === "draft" ? "5 to 10" : "4 to 8") + " sections in most cases. Maximum " + MAX_SECTIONS + ".\n" +
    "  - Include a section only if the material supports its point. Do not add sections for completeness, general background, or risks the material does not raise. If you cannot name a basis for a section, leave it out.\n" +
    "  - target_words is a ceiling, not a target. Set it from the weight of the material: a section covering the key disputed issues may need more; a thin section should be short.\n" +
    "  - The section list must cover the full scope of the output without overlap. No two sections may make the same point.\n" +
    "  - Section titles should be specific to this matter, not generic. For example 'Disputed Matters: Quantum and Allocation' is better than 'The Issues'.\n" +
    (o.structure
      ? "  - REQUIRED STRUCTURE: use exactly the sections listed below, in that order, with those titles. Set point, basis and target_words for each. Do not add or drop sections.\n\nREQUIRED STRUCTURE:\n" + o.structure + "\n\n"
      : "\n") +
    (instructions ? "USER INSTRUCTIONS: " + instructions + "\n\n" : "") +
    (actingFor ? "ACTING FOR: " + actingFor + "\n\n" : "") +
    "MATTER: " + (matterName || "(unnamed)") + "\n\n" +
    "CONDENSED SOURCE MATERIAL:\n\n" + synthInput + "\n\n" +
    "Return the JSON array now.";

  let lastError = null;
  for (let attempt = 1; attempt <= PLAN_PARSE_ATTEMPTS; attempt++) {
    let planCall;
    try {
      planCall = await runTool(planSystem, planPrompt, PLAN_MAX_TOKENS);
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

/* The document so far, for the section about to be written. Most recent
   sections are given in full until PRIOR_TEXT_CAP is reached; anything
   earlier falls back to its opening PRIOR_SNIPPET_CHARS. */
function buildPriorText(results, sections, upTo) {
  const parts = [];
  let used = 0;
  for (let j = upTo - 1; j >= 0; j--) {
    const rj = results[j];
    if (!rj || !rj.text) continue;
    const label = "### Section " + (j + 1) + " (" + sections[j].title + ")";
    if (used + rj.text.length <= PRIOR_TEXT_CAP) {
      parts.unshift(label + " [full text]\n" + rj.text);
      used += rj.text.length;
    } else {
      parts.unshift(label + " [opening only]\n" + rj.text.slice(0, PRIOR_SNIPPET_CHARS));
    }
  }
  return parts.join("\n\n");
}

/* Run one Claude call per planned section. `runTool` and `updateJob` are
   injected. `updateJob` may be null/omitted in tests that don't care about
   persistence. opts: { numbered, collectPoints } — see the header. */
export async function synthesiseSections(runTool, updateJob, jobId, job, systemBase, toolName, instructions, synthInput, sections, actingFor, matterName, headerText, opts) {
  const o = opts || {};
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
    const isLast = (i === sections.length - 1);

    const priorText = buildPriorText(results, sections, i);

    let numberingLine = "";
    if (o.numbered) {
      let lastNum = 0;
      for (let j = 0; j < i; j++) {
        if (results[j] && results[j].text) lastNum = Math.max(lastNum, lastParagraphNumber(results[j].text));
      }
      numberingLine = "Number paragraphs continuously with the rest of the document. The first numbered paragraph in this section is " + (lastNum + 1) + ".\n";
    }

    const pointsLine = o.collectPoints
      ? "If this section gives rise to any Points to check, write them after the section, below a line containing only " + POINTS_MARKER + ", one item per line with its paragraph number. Do not write a Points to check heading or list anywhere else: the lists from every section are combined at the end.\n"
      : "";

    const sectionPrompt =
      "You are writing section " + sec.index + " of " + sections.length + " for " + toolLabel(toolName) + ".\n\n" +
      "SECTION " + sec.index + ": " + sec.title + "\n" +
      (sec.point ? "This section exists to establish: " + sec.point + "\nEverything in it must serve that point. Leave out anything that does not.\n" : "") +
      (sec.basis ? "Basis in the material: " + sec.basis + "\n" : "") +
      (sec.description && !sec.point ? "(" + sec.description + ")\n" : "") +
      "Length: at most " + sec.target_words + " words. Shorter is better if the point is made. Stop when it is made.\n\n" +
      "Output ONLY the body of this section. Start with a Markdown heading '## " + sec.title + "' and then the section's content. Do not write any other section's content. Do not repeat what earlier sections say: where you need it, refer to the earlier paragraph by number.\n" +
      "Hold the same standard as the opening sections. Do not drift into general commentary or speculation.\n" +
      (isLast ? "This is the final section. Do not summarise the earlier sections.\n" : "") +
      numberingLine +
      pointsLine + "\n" +
      (priorText ? "THE DOCUMENT SO FAR (for continuity; do not repeat it):\n\n" + priorText + "\n\n" : "") +
      "FULL OUTLINE OF ALL SECTIONS (for context on what belongs where, so you avoid duplicating later sections):\n" +
      sections.map(function(s) { return "  " + s.index + ". " + s.title + (s.point ? " — " + s.point : (s.description ? " — " + s.description : "")); }).join("\n") + "\n\n" +
      (instructions ? "USER INSTRUCTIONS: " + instructions + "\n\n" : "") +
      (actingFor ? "ACTING FOR: " + actingFor + "\n\n" : "") +
      "CONDENSED SOURCE MATERIAL:\n\n" + synthInput;

    const sectionStart = Date.now();
    try {
      const r = await runTool(systemBase, sectionPrompt, sectionBudget);
      /* Points are split off before storing, so the stored text (which later
         sections read as "the document so far") is the section body alone. */
      const split = o.collectPoints ? splitPoints(r.text) : { body: r.text, points: [] };
      results[i] = {
        index: sec.index,
        title: sec.title,
        text: split.body,
        points: split.points,
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
  const allPoints = [];
  for (let k = 0; k < results.length; k++) {
    const rk = results[k];
    if (rk && rk.text) {
      pieces.push(rk.text.trim());
      if (Array.isArray(rk.points)) for (let q = 0; q < rk.points.length; q++) allPoints.push(rk.points[q]);
    } else if (rk) {
      pieces.push("## " + rk.title + "\n\n*This section failed to generate. See note above.*");
    }
  }
  if (o.collectPoints && allPoints.length > 0) {
    pieces.push("## Points to check\n\n*Not for filing.*\n\n" + allPoints.map(function(p) { return "- " + p; }).join("\n"));
  }
  const assembled = pieces.join("\n\n");

  return {
    text: assembled,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cost: totalCost,
    failedSections: failed,
    sectionsCompleted: sections.length - failed.length,
    points: allPoints,
  };
}
