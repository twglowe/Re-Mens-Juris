/* EX LIBRIS JURIS v5.21 — worker.js
   Background tool processor. Called by tools.js (fire-and-forget) AND by
   cron-resume.js (every 2 minutes, for laptop-closed processing).

   v5.23 CHANGES (26 Jul 2026) - tool-specific tramline titles:
   1. For every tool EXCEPT draft, the title between the court heading's
      tramlines (the ═══ lines) is now "<TOOL NAME> ON <PROCEDURAL STAGE>"
      in capitals - e.g. "ISSUES ON STRIKE OUT APPLICATION". The stage is
      the matter's selected Procedural Stage (matters.subcategory_id ->
      case_subcategories.name). If no stage is selected the tool name
      appears alone. Whatever docTitle is stored in heading_data is ignored
      for tool outputs. Court, case number and parties are unchanged.
   2. The draft tool is untouched: its tramline title still comes from the
      heading editor. If a matter has no heading data at all, tool output
      is unchanged (no heading block, as before).
   3. Implementation is confined to the heading-fetch block in the tool run
      section: one widened select (heading_data, subcategory_id), one
      case_subcategories lookup, one docTitle override on a copied heading
      object. No prompts, pipeline, or resume machinery touched.

   v5.22 CHANGES (24 Jul 2026) - Push v5.22 (Push 2: long documents read in full):
   1. Feature-flagged (FULL_DOCS, default true). To restore the previous
      behaviour exactly, set FULL_DOCS = false and re-push this one file.
   2. When FULL_DOCS is true, chunksToDocMap splits any document whose text
      exceeds PART_MAX_CHARS (80000, same value as the old truncation point)
      into consecutive parts at chunk boundaries (chunks are page-based, so
      splits fall at natural page/paragraph breaks). Every part flows through
      the existing extract -> condense -> synthesise pipeline as if it were a
      document. NOTHING is truncated: the old "[...truncated for
      processing...]" cut in batchDocs is bypassed under the flag.
   3. Part labels are MODEL-ONLY. docsToText marks each part in its ===
      header as "(long document - part n of m; cite this document as
      "<name>", not by part number)". buildPageIndex merges all parts of a
      document under its base name, so the PAGE REFERENCE INDEX is identical
      in shape to before. Prompts, output formats, and citations are
      unchanged - the reader never sees part numbers.
   4. With FULL_DOCS = false, chunksToDocMap, batchDocs, docsToText and
      buildPageIndex behave byte-for-byte as v5.21. No other function, no
      tool branch, no prompt, and none of the resume/condense/synthesis
      machinery is touched.

   v5.21 CHANGES (22 Jun 2026) - Push v5.21 (Chronology: surface gaps + conflicts):
   1. Chronology SYNTHESIS prompt only. Two always-on additions (no parameter;
      applies to every chronology, anchored or not):
        a. Conflict flagging broadened from dates to facts: where sources
           conflict on a date OR a material fact, the conflict is flagged and
           each version attributed to its source, rather than chosen silently.
        b. A short "## Gaps and Contradictions" section lists (i) documents,
           exhibits or events referred to / relied upon but not produced in the
           materials, and (ii) material contradictions between sources, each
           with source references; "None identified." when there are none.
   2. Extraction, condense, resume path, and every other tool are untouched.
      The v5.20 anchor/consolidate behaviour is unchanged.

   v5.20 CHANGES (21 Jun 2026) - Push v5.20 (Chronology shaping, engine half):
   1. Chronology synthesis prompt gains an optional RELEVANCE ANCHOR and an
      optional CONSOLIDATE instruction, both read from p:
        chronologyAnchorText  : text the chronology should be made relevant to
        chronologyAnchorLabel : short label for that anchor (used in the heading)
        chronologyConsolidate : boolean; merge/group/trim without losing substance
      All three default safely. With no anchor text and consolidate not true,
      the chronology produces output identical to pre-v5.20.
   2. Applied at SYNTHESIS only. Extraction stays exhaustive (no event dropped
      early). The shared condense stage is NOT touched, so no other tool is
      affected. The sleep-survival/resume path is NOT touched.
   3. When an anchor is present the output prints "Relevant to: <label>" under
      the heading, so the chronology records its own scope. The anchor also
      lives in p (job.parameters), so it is stored and queryable already.
   4. Relevance beats consolidation: an event that bears on the anchor is kept
      even if it would otherwise be trimmed as routine.

   v5.11a CHANGES (30 Apr 2026) — Push v5.11a (Draft Build 1):
   1. Read two new optional draft-only fields from p:
        matterToolHistory: array of {tool_name, question, answer} for the
          most-recent analysis-tool result of each tool in this matter.
        learnFromComparable: boolean, default true. Wired through but the
          comparable-document hunt itself is built in a later push.
      Both fields default safely; behaviour for every non-draft tool is
      unchanged, and behaviour for any draft job that lacks them is
      unchanged.
   2. In the draft branch only: build toolHistoryText from
      matterToolHistory and prepend it to systemBase as "WHAT WE ALREADY
      KNOW ABOUT THIS MATTER", positioned between matterContext and
      libraryText. Empty array \u2192 empty string \u2192 no behaviour change.
   3. learnFromComparable currently only logged. The hunt is Build 3.
   4. No prompt-logic changes for any other tool. No changes to extraction
      or synthesis prompts. Only the system prompt for draft is touched.
   5. Version banner bumped to v5.11a.

   v5.10e CHANGES (30 Apr 2026) — Push v5.10e (Briefing Note run-parameters block):
   1. Briefing Note output now records, at the top of the saved result, what
      was specified at launch:
        - "**Additional instructions:** ..." (when instructions non-empty)
        - "**Restricted to:** doc1, doc2, doc3" (when includeDocNames non-empty)
      Block only appears if at least one of the two parameters was set; if
      neither, the saved result is byte-identical to v5.10d. The block is
      built by string concatenation (worker-built, NOT model-built) so the
      values are exactly what arrived in the job parameters.
   2. Inserted between line 1171 (`result = r.text; ...`) and the closing
      brace of the briefing branch. No prompt-logic changes; sectionHeaders,
      completionMandate, briefingHeader, briefingFocus all unchanged.
   3. Applies to launch only. Follow-ups go through a different code path
      and are not affected.
   4. Version banner bumped to v5.10e. No other behavioural change.

   v5.10a CHANGES (27 Apr 2026) — Push v5.10a (Issues focus widget):
   1. Read two new optional parameters from p: subElement, focusDocNames.
      Both default to empty values; behaviour unchanged for every job that
      lacks them (every job before this push, plus every non-Issues tool
      forever). The "Question to develop" textarea on the frontend reuses
      id="toolInstructions" so its value already arrives on
      job.instructions as today \u2014 no new field needed for it.
   2. Build a single focusBlock string near the parameter-extraction site.
      Combines the three contributors \u2014 instructions, subElement,
      focusDocNames \u2014 whichever are non-empty. Plain-string
      concatenation; no template literals; no awaits. Empty focusBlock
      means identical behaviour to v5.9b for an unfocused run.
   3. Replace the three inline `(instructions ? "Focus: " + instructions
      ... : "")` fragments inside the Issues block (lines previously
      ~1061 and ~1062 twice) with focusBlock. Only the Issues block is
      touched; every other tool's prompt fragments are unchanged.
   4. focusDocNames is option (b): a prompt instruction, not a chunk
      filter. Documents are NOT removed from the batches; the model is
      told "Concentrate your analysis on these documents: X, Y. You may
      still reference other documents where relevant." The existing
      includeDocNames folder filter is unchanged.
   5. Version banner bumped to v5.10a.

   v5.8a CHANGES (24 Apr 2026) — Push H, sectioned synthesis:
   1. NEW: sectioned synthesis path for Briefing, Draft, and Proposition.
      These three tools can now produce outputs longer than a single
      max_tokens response by planning a section list first and then
      synthesising each section in its own Claude call. Triggered by
      passing { sectioned: true } as the 8th argument to
      runBatchedChained(). Group A tools (Chronology, Persons, Issues) and
      Citations still use the single-call synthesis path.
   2. NEW: sectioned-synthesis helpers extracted into
      ./lib/sectioned_synth.js for unit-testability. Production code in
      this file imports planSections and synthesiseSections from there and
      calls them with runTool and updateJob injected. The extracted
      module is pure — no module-scope Anthropic or Supabase clients.
   3. Plan phase: one short Claude call per job. Input is condensed
      material + user instructions, output is a JSON array of
      { title, description, target_words }. Retried up to 2x on bad JSON.
      Plan written to tool_jobs.section_plan (new jsonb column).
   4. Synthesis loop: one Claude call per planned section, each with its
      own max_tokens budget scaled to target_words. If a section fails
      all runTool retries, assembly continues and a banner is prepended
      to the final output. Section text persisted incrementally to
      tool_jobs.section_results (new jsonb column) for resume + frontend.
   5. Single-call synthesis max_tokens raised from 10000 to 16384 on the
      non-sectioned path (lines previously ~718 and ~623). Sonnet 4.5/4.6
      supports this; the original 10000 cap was set when Vercel
      maxDuration was 300s and a long synth would blow the ceiling. With
      maxDuration now 800s (v4.5c), 16384 fits comfortably.
   6. section_plan and section_results added to CRITICAL_FIELDS so a
      stale schema cache cannot silently drop them.

   PRECONDITION: tool_jobs table must have these columns (in addition to
   the earlier v4.5c preconditions):
     - section_plan jsonb
     - section_results jsonb
   Migration:
     ALTER TABLE tool_jobs ADD COLUMN IF NOT EXISTS section_plan jsonb;
     ALTER TABLE tool_jobs ADD COLUMN IF NOT EXISTS section_results jsonb;

   v4.5c CHANGES (12 Apr 2026):
   1. maxDuration raised from 300 to 800. Vercel Pro permits up to 800 seconds.
      The previous 300s ceiling was the root cause of Briefing Note tail latency:
      a final synthesis call on a large matter could take 250-400s, hitting the
      ceiling mid-stream, and the cron-resume cycle (4 minutes per re-fire) made
      every "barely too long" run feel "stuck for hours".
   2. TIME_LIMIT_MS raised from 250000 to 700000. Without this, the worker would
      pause itself at 250s regardless of the new maxDuration, defeating the bump.
      The new value leaves a 100s margin below the 800s ceiling.
   3. CONDENSE_TIME_LIMIT_MS raised from 150000 to 600000 for the same reason.
      Single condense calls take ~30-220s; the new limit lets the worker burn
      through several groups in one invocation rather than pausing after one.
   4. Briefing Note synth prompt tightened with explicit completion guidance and
      per-section paragraph limits. Previous prompt produced silent truncation
      on large matters — the Thalassa briefing note ended mid-sentence in
      section 4 and never reached sections 5, 6, 7. New prompt insists on all
      7 sections being completed and tells the model to abbreviate later
      sections rather than omit them if running short on output budget.
   5. New synth_attempts column on tool_jobs is incremented on every entry into
      the synthesising branch. If the previous attempt count is >= 5 AND
      neither condense_done nor result has advanced since then, the job is
      failed with a clear error rather than looping forever. Catches the
      pathological case where final synthesis fails repeatedly with no
      forward progress (e.g. a prompt the model genuinely cannot complete
      within 10000 tokens). Does NOT catch transient failures, because the
      counter only triggers when there is no progress between attempts.

   PRECONDITION: tool_jobs table must have a synth_attempts integer column
   (default 0). Migration: ALTER TABLE tool_jobs ADD COLUMN IF NOT EXISTS
   synth_attempts integer DEFAULT 0;

   v4.3b CHANGES (carried forward):
   1. runTool() retries on overloaded_error and rate_limit_error from
      the Anthropic API. Up to 4 attempts total (initial + 3 retries) with
      exponential backoff (5s, 15s, 45s). Non-retryable errors propagate
      immediately, identical to v4.3 behaviour.
      Why: Anthropic Sonnet 4.6 has been intermittently overloaded — daily
      incidents on status.anthropic.com over the v4.x development period.
      Without retry, every brief overload kills a job. With retry, brief
      overloads become invisible to the user.
   2. New helper isRetryableAnthropicError() detects retryable errors by
      checking HTTP status (529/429), structured error.type, and message
      string as a fallback. Defensive across SDK error shapes.
   3. No changes to extraction, condense, synthesis chaining, updateJob,
      or any database code. The change is fully isolated to runTool().

   v4.3 CHANGES (carried forward):
   1. updateJob() now writes a heartbeat (updated_at) on every call. The new
      api/cron-resume.js endpoint queries tool_jobs for in-progress rows whose
      updated_at is older than 240 seconds and re-fires the worker for each.
      This means jobs continue progressing even when the user closes the
      laptop or the browser tab — the frontend polling loop is now a live UI
      nicety rather than a load-bearing requirement.
   2. No changes to extraction, condense, or synthesis logic. Heartbeat is
      a single line at the top of updateJob(). updated_at is deliberately NOT
      in CRITICAL_FIELDS (Postgres normalises timestamps on return).

   v4.2k FIXES (carried forward):
   1. Final synthesis max_tokens reduced from 16000 to 10000. The 16000 ceiling
      allowed Claude to stream for >300s on dense legal content with 6+
      condensed summaries as input, blowing the Vercel function ceiling.
      10000 tokens is still ~30 pages, plenty for any Chronology output.
   2. Final synthesis call now logs start and end with elapsed time and token
      counts, so we can see if it gets close to the ceiling on future runs.

   v4.2k NOTE: This must be deployed alongside the v4.2k tools.js, which fixes
   the frontend over-firing bug. Without that fix, parallel worker invocations
   continue to waste Anthropic spend even though the chain works.

   v4.2j FIXES (carried forward) — the real fix:
   1. Supabase client created fresh per handler invocation (fresh schema cache).
   2. updateJob throws on error and verifies critical fields persisted.

   v4.2i FIXES (carried forward):
   - SYNTH_GROUP = 3, condense max_tokens = 10000.
   - Heavy console.log instrumentation around every condense call.

   v4.2h FIXES (carried forward):
   - Per-group DB persistence in condense loop.
   - Re-entry condition checks condense_done < extracts.length.
   - Condense time guard at 150s (raised to 600s in v4.5c).

   v4.2g FIXES (carried forward):
   - Handler doesn't clobber status="synthesising"/"paused" on re-entry.
   - Condense pause path explicitly writes status="synthesising".

   PRECONDITION: tool_jobs table must have these columns:
     - condensed_extracts jsonb
     - condense_done integer DEFAULT 0
     - synthesis_phase text
     - synth_attempts integer DEFAULT 0  (v4.5c) */

import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { planSections as planSectionsLib, synthesiseSections as synthesiseSectionsLib } from "./lib/sectioned_synth.js";
import { classifyDocumentForType } from "./document-classifier.js";

export const config = { maxDuration: 800 };

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

/* v4.2j: Supabase client is created per-invocation inside the handler, not at
   module scope. Module-scope clients persist across invocations on warm Vercel
   functions, and supabase-js caches the PostgREST schema on first use. If the
   first invocation happened before a schema migration, the cached schema lacks
   the new columns and supabase-js silently strips them from UPDATE payloads
   with no error — which is exactly what bit us through v4.2g/h/i.

   The `supabase` binding is `let` so the handler can overwrite it at the start
   of every invocation. All helper functions read the current value, so they
   automatically use the fresh client. */
let supabase = createClient(supabaseUrl, supabaseKey);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const INPUT_COST_PER_M = 3.00;
const OUTPUT_COST_PER_M = 15.00;
/* v4.5c: raised from 250000 to 700000 to use the new 800s maxDuration ceiling.
   Leaves a 100s margin below the hard ceiling for the in-flight Anthropic call
   to wind down before Vercel kills the function. */
const TIME_LIMIT_MS = 700000;
const PARALLEL = 6;

/* ──────────────────────────────────────────────────────────────────────────
   v5.18 PUSH 1 — fetch-cap removal (feature-flagged).
   When FULL_FETCH is true, getAllChunks pages through EVERY passage for the
   matter instead of stopping at the old 1500-row cap. To revert to the exact
   previous behaviour, set FULL_FETCH = false and re-push this one file — no
   other change is needed. FETCH_PAGE is the per-request page size; 1000 is the
   PostgREST default ceiling.
   ────────────────────────────────────────────────────────────────────────── */
const FULL_FETCH = true;
const FETCH_PAGE = 1000;

/* ──────────────────────────────────────────────────────────────────────────
   v5.22 PUSH 2 — long documents read in full (feature-flagged).
   When FULL_DOCS is true, documents longer than PART_MAX_CHARS are split
   into consecutive parts at chunk boundaries instead of being truncated at
   80000 characters. To revert to the exact previous behaviour, set
   FULL_DOCS = false and re-push this one file — no other change is needed.
   PART_MAX_CHARS deliberately equals the old truncation point so batch
   packing arithmetic is unchanged.
   ────────────────────────────────────────────────────────────────────────── */
const FULL_DOCS = true;
const PART_MAX_CHARS = 80000;

/* ══════════════════════════════════════════════════════════════════════════
   SHARED HELPERS (moved from tools.js v3.3 — identical logic)
   ══════════════════════════════════════════════════════════════════════════ */

async function getAllChunks(matterId, docTypes, limit) {
  docTypes = docTypes || null;

  /* Original capped path — used when the flag is off OR a caller passes an
     explicit limit. Byte-for-byte the pre-Push-1 behaviour. All real callers
     pass only matterId, so with FULL_FETCH on they take the paging path below. */
  if (!FULL_FETCH || limit != null) {
    var capQuery = supabase.from("chunks")
      .select("content, document_name, doc_type, chunk_index, page_number")
      .eq("matter_id", matterId)
      .order("chunk_index", { ascending: true })
      .limit(limit || 1500);
    if (docTypes && docTypes.length > 0) capQuery = capQuery.in("doc_type", docTypes);
    var capResp = await capQuery;
    if (capResp.error) throw new Error("Chunk fetch failed: " + capResp.error.message);
    return capResp.data || [];
  }

  /* FULL_FETCH path: page through every passage for the matter.
     Ordered by (document_id, chunk_index) — the unique key the ingestion
     guarantees (chunk_index continues from the per-document max) — so range
     paging never drops or duplicates a row at a page boundary. Within each
     document the order stays chunk_index ascending, identical to before; the
     only change is that the silent tail-truncation at 1500 rows is gone. */
  var all = [];
  var offset = 0;
  for (;;) {
    var pageQuery = supabase.from("chunks")
      .select("content, document_name, doc_type, chunk_index, page_number, document_id")
      .eq("matter_id", matterId)
      .order("document_id", { ascending: true })
      .order("chunk_index", { ascending: true })
      .range(offset, offset + FETCH_PAGE - 1);
    if (docTypes && docTypes.length > 0) pageQuery = pageQuery.in("doc_type", docTypes);
    var pageResp = await pageQuery;
    if (pageResp.error) throw new Error("Chunk fetch failed: " + pageResp.error.message);
    var rows = pageResp.data || [];
    for (var r = 0; r < rows.length; r++) all.push(rows[r]);
    if (rows.length < FETCH_PAGE) break;
    offset += FETCH_PAGE;
  }
  console.log("v5.18 getAllChunks FULL_FETCH: matter " + matterId + " fetched " + all.length + " passages in " + (offset / FETCH_PAGE + 1) + " page(s)");
  return all;
}

/* v3.4: Filter out excluded documents */
function filterExcluded(chunks, excludeDocNames) {
  if (!excludeDocNames || excludeDocNames.length === 0) return chunks;
  return chunks.filter(function(c) { return excludeDocNames.indexOf(c.document_name) === -1; });
}

/* v5.0: Filter to ONLY included documents (folder filter from frontend).
   Empty/null = no filter (all documents included). Applied in addition to
   filterExcluded; the two compose. The frontend resolves selected folders
   to a list of document names and passes them in p.includeDocNames. */
function filterIncluded(chunks, includeDocNames) {
  if (!includeDocNames || includeDocNames.length === 0) return chunks;
  return chunks.filter(function(c) { return includeDocNames.indexOf(c.document_name) !== -1; });
}

/* v5.0: Apply both filters in one call. Used by every tool's chunk fetch. */
function applyDocFilters(chunks, excludeDocNames, includeDocNames) {
  return filterIncluded(filterExcluded(chunks, excludeDocNames), includeDocNames);
}

function chunksToDocMap(chunks) {
  /* v5.22: flag off — original behaviour, byte-for-byte. */
  if (!FULL_DOCS) {
    var byDocOld = {};
    for (var oi = 0; oi < chunks.length; oi++) {
      var oc = chunks[oi];
      if (!byDocOld[oc.document_name]) byDocOld[oc.document_name] = { type: oc.doc_type, text: "", pages: [] };
      byDocOld[oc.document_name].text += oc.content + "\n\n";
      if (oc.page_number != null) {
        byDocOld[oc.document_name].pages.push({ chunkIndex: oc.chunk_index, page: oc.page_number, snippet: oc.content.slice(0, 80) });
      }
    }
    return byDocOld;
  }
  /* v5.22 FULL_DOCS path: identical accumulation, but when a document's
     current part would exceed PART_MAX_CHARS, close it and open a new part
     keyed "<name> \u27E6part N\u27E7". Splits fall at chunk boundaries
     (chunks are page-based). currentKeyByDoc tracks each document's open
     part so accumulation is correct even if chunk ordering interleaves
     documents. A part always accepts at least one chunk, so no chunk is
     ever dropped. After the loop, parts of split documents are stamped with
     baseName / partNum / partTotal for docsToText and buildPageIndex;
     unsplit documents carry no part fields and behave exactly as before. */
  var byDoc = {};
  var partsPerDoc = {};
  var currentKeyByDoc = {};
  for (var i = 0; i < chunks.length; i++) {
    var c = chunks[i];
    var base = c.document_name;
    var key = currentKeyByDoc[base];
    if (!key) {
      key = base;
      currentKeyByDoc[base] = key;
      partsPerDoc[base] = [key];
      byDoc[key] = { type: c.doc_type, text: "", pages: [] };
    }
    var entry = byDoc[key];
    if (entry.text.length > 0 && entry.text.length + c.content.length + 2 > PART_MAX_CHARS) {
      key = base + " \u27E6part " + (partsPerDoc[base].length + 1) + "\u27E7";
      currentKeyByDoc[base] = key;
      partsPerDoc[base].push(key);
      byDoc[key] = { type: c.doc_type, text: "", pages: [] };
      entry = byDoc[key];
    }
    entry.text += c.content + "\n\n";
    if (c.page_number != null) {
      entry.pages.push({ chunkIndex: c.chunk_index, page: c.page_number, snippet: c.content.slice(0, 80) });
    }
  }
  var splitDocs = Object.keys(partsPerDoc);
  for (var s = 0; s < splitDocs.length; s++) {
    var keys = partsPerDoc[splitDocs[s]];
    if (keys.length > 1) {
      for (var k = 0; k < keys.length; k++) {
        byDoc[keys[k]].baseName = splitDocs[s];
        byDoc[keys[k]].partNum = k + 1;
        byDoc[keys[k]].partTotal = keys.length;
      }
    }
  }
  return byDoc;
}

function batchDocs(byDoc, maxChars) {
  maxChars = maxChars || 100000;
  var docDataPart = null;
  var batches = [];
  var current = {};
  var currentSize = 0;
  var entries = Object.entries(byDoc);
  for (var i = 0; i < entries.length; i++) {
    var name = entries[i][0];
    var data = entries[i][1];
    /* v5.22: under FULL_DOCS, entries arrive pre-split at <= PART_MAX_CHARS,
       so nothing is truncated. Flag off: original 80000 cut, byte-for-byte. */
    var truncated = (!FULL_DOCS && data.text.length > 80000) ? data.text.slice(0, 80000) + "\n[...truncated for processing...]" : data.text;
    if (data.partNum) { docDataPart = { baseName: data.baseName, partNum: data.partNum, partTotal: data.partTotal }; } else { docDataPart = null; }
    var docData = docDataPart ? { type: data.type, text: truncated, pages: data.pages, baseName: docDataPart.baseName, partNum: docDataPart.partNum, partTotal: docDataPart.partTotal } : { type: data.type, text: truncated, pages: data.pages };
    var docSize = truncated.length + name.length + 50;
    if (currentSize + docSize > maxChars && Object.keys(current).length > 0) {
      batches.push(current);
      current = {};
      currentSize = 0;
    }
    current[name] = docData;
    currentSize += docSize;
  }
  if (Object.keys(current).length > 0) batches.push(current);
  return batches;
}

function docsToText(byDoc) {
  return Object.entries(byDoc).map(function(entry) {
    var n = entry[0];
    var d = entry[1];
    /* v5.22: parts of a long document are labelled for the MODEL only, with
       an explicit instruction to cite by the document name. Unsplit
       documents produce the identical header to v5.21. */
    var header = d.partNum
      ? "=== " + (d.baseName || n) + " [" + d.type + "] (long document \u2014 part " + d.partNum + " of " + d.partTotal + "; cite this document as \"" + (d.baseName || n) + "\", not by part number) ==="
      : "=== " + n + " [" + d.type + "] ===";
    if (d.pages && d.pages.length > 0) {
      var pageRange = d.pages.map(function(p) { return p.page; });
      header += " (pages " + Math.min.apply(null, pageRange) + "\u2013" + Math.max.apply(null, pageRange) + ")";
    }
    return header + "\n" + d.text;
  }).join("\n\n");
}

/* ── v5.59 Push C: CASE LAW CONTEXT FOR THE DRAFT ────────────────────────────
   Two sources, either of which may come back empty:

     1. Authorities dual-linked to this matter — case_law_docs rows carrying
        source_matter_id. The client sends the ids still ticked in the Draft
        tab's checklist; unticking one drops it here.

     2. A search of the case law library, in one of three modes:
          general — the whole library
          subject — confined to one case_law_subjects row, and optionally to
                    one sub-tag within it
          off     — no library search; source 1 above is unaffected

   Relevance: case_law_search() ranks with ts_rank_cd, so a chunk that turns
   on the issue repeatedly beats one mentioning a word in passing. That
   function ships in migrations/migration_case_law_search.sql. Until it is
   run the RPC 404s and we fall back to an unranked PostgREST text search,
   which still filters to matching chunks — the draft works either way, it
   just picks matching chunks rather than the best-matching ones.

   The query text is the matter's issues and nature plus the draft
   instructions — "the draft's issues".

   Size: a chunk is 1500 characters, so the library's CASE_LAW_SEARCH_CHUNKS
   is about 60k tokens. That block sits in the system prompt, which
   runBatchedChained re-sends with every extraction batch and again for the
   synthesis — so its cost is multiplied by the number of batches, and a
   matter large enough to make ten of them pays for it eleven times. Raising
   this further is a cost decision before it is a context decision; prompt
   caching on the system prompt would be the cheaper way to buy more.

   Each matter-linked authority stays at CASE_LAW_DOC_CHUNKS — the 80 chunks
   the precedent search allows per precedent document. A textbook runs to
   thousands of chunks, so an uncapped fetch would swamp the prompt. */
const CASE_LAW_SEARCH_CHUNKS = 160;
const CASE_LAW_DOC_CHUNKS = 80;
const CASE_LAW_MAX_MATTER_DOCS = 5;
const CASE_LAW_SUBJECT_DOC_CAP = 500;

/* Everyday words plus the ones every legal document is full of: keeping them
   would match every chunk in the library and rank nothing. */
const CASE_LAW_STOPWORDS = (
  "about above after again against because been before being below between both " +
  "cannot could does doing down during each from further have having here hers " +
  "herself himself into itself more most other ought over same shall should some " +
  "such than that their theirs them themselves then there these they this those " +
  "through under until very were what when where which while whom whose will with " +
  "would your yours yourself " +
  "case cases court courts claim claimant defendant plaintiff respondent applicant " +
  "matter action proceedings judgment judgement order orders party parties " +
  "document documents draft submission submissions paragraph paragraphs learned " +
  "counsel affidavit exhibit hearing application"
).split(/\s+/).reduce(function (acc, w) { acc[w] = true; return acc; }, {});

function caseLawKeywords(text) {
  var words = String(text || "").toLowerCase().match(/[a-z][a-z'-]{3,}/g) || [];
  var seen = {};
  var out = [];
  for (var i = 0; i < words.length && out.length < 12; i++) {
    var w = words[i];
    if (CASE_LAW_STOPWORDS[w] || seen[w]) continue;
    seen[w] = true;
    out.push(w);
  }
  return out;
}

function caseLawHeading(doc) {
  var title = [doc.name, doc.citation].filter(Boolean).join(" ");
  var aside = [];
  if (doc.jurisdiction) aside.push(doc.jurisdiction);
  if (doc.doc_type === "textbook") aside.push("textbook");
  return "=== AUTHORITY: " + title + (aside.length ? " (" + aside.join("; ") + ")" : "") + " ===";
}

/* Chunks arrive as separate extracts, not continuous text. Mark the gaps so
   the model does not read across a jump as though it were one passage. */
function caseLawJoinChunks(chunks) {
  var parts = [];
  for (var i = 0; i < chunks.length; i++) {
    if (i > 0 && chunks[i].chunk_index !== chunks[i - 1].chunk_index + 1) parts.push("[…]");
    parts.push(chunks[i].content);
  }
  return parts.join("\n\n");
}

async function caseLawSearchChunks(supabase, userId, query, docIds) {
  /* Ranked path — needs migration_case_law_search.sql. */
  try {
    var rpc = await supabase.rpc("case_law_search", {
      p_user_id: userId, p_query: query,
      p_doc_ids: docIds && docIds.length ? docIds : null,
      p_limit: CASE_LAW_SEARCH_CHUNKS,
    });
    if (!rpc.error && rpc.data) {
      console.log("[draft] case law search: ranked, " + rpc.data.length + " chunks");
      return rpc.data;
    }
    console.log("[draft] case law ranked search unavailable (" + ((rpc.error && rpc.error.message) || "no data") + "), falling back");
  } catch (e) {
    console.log("[draft] case law ranked search threw (" + e.message + "), falling back");
  }
  /* Unranked fallback. websearch_to_tsquery understands OR, so terms are
     joined with it — plainto_tsquery would AND them and match almost
     nothing across a dozen keywords. */
  var terms = caseLawKeywords(query);
  if (terms.length === 0) return [];
  var q = supabase.from("case_law_chunks")
    .select("case_law_id, chunk_index, content")
    .eq("user_id", userId)
    .textSearch("content", terms.join(" OR "), { type: "websearch", config: "english" })
    .limit(CASE_LAW_SEARCH_CHUNKS);
  if (docIds && docIds.length) q = q.in("case_law_id", docIds);
  var resp = await q;
  if (resp.error) {
    console.log("[draft] case law fallback search failed: " + resp.error.message);
    return [];
  }
  console.log("[draft] case law search: unranked fallback, " + (resp.data || []).length + " chunks");
  return resp.data || [];
}

async function buildCaseLawContext(supabase, userId, matterId, ctx, queryText) {
  if (!ctx) return "";
  var blocks = [];

  /* ── 1. Authorities dual-linked to this matter ─────────────────────────── */
  var tickedIds = Array.isArray(ctx.matterCaseLawIds) ? ctx.matterCaseLawIds.filter(Boolean) : [];
  if (tickedIds.length > 0) {
    /* eq source_matter_id as well as the id list: the client sends what it
       showed, and this is the server's own check that each one really is
       linked to the matter being drafted. */
    var mResp = await supabase.from("case_law_docs")
      .select("id, name, citation, jurisdiction, doc_type, commentary")
      .eq("user_id", userId).eq("source_matter_id", matterId)
      .in("id", tickedIds).order("name").limit(CASE_LAW_MAX_MATTER_DOCS);
    var mDocs = (mResp.data) || [];
    var linked = [];
    for (var i = 0; i < mDocs.length; i++) {
      var d = mDocs[i];
      var cResp = await supabase.from("case_law_chunks")
        .select("content, chunk_index").eq("case_law_id", d.id).eq("user_id", userId)
        .order("chunk_index").limit(CASE_LAW_DOC_CHUNKS);
      var chunks = cResp.data || [];
      if (chunks.length === 0) continue;
      var entry = caseLawHeading(d) + "\n";
      if (d.commentary) entry += "[Commentary — read carefully and apply: " + d.commentary + "]\n\n";
      linked.push(entry + caseLawJoinChunks(chunks));
    }
    if (linked.length > 0) {
      blocks.push("## AUTHORITIES LINKED TO THIS MATTER\n\nThese were filed against this matter and are the authorities you are expected to work from.\n\n" + linked.join("\n\n"));
    }
  }

  /* ── 2. The library search ─────────────────────────────────────────────── */
  var mode = (ctx.mode === "subject" || ctx.mode === "off") ? ctx.mode : "general";
  var docIds = null;
  var scopeLabel = "whole library";
  var skipSearch = false;

  /* "Off" turns off the library search only. Authorities the user ticked
     under "from this matter" are an explicit choice and still go in. */
  if (mode === "off") {
    skipSearch = true;
    console.log("[draft] case law: library search off");
  } else if (mode === "subject") {
    if (!ctx.subjectId) {
      skipSearch = true;
      console.log("[draft] case law: subject mode with no subject chosen, library search skipped");
    } else {
      var dq = supabase.from("case_law_docs").select("id")
        .eq("user_id", userId).eq("subject_id", ctx.subjectId);
      if (ctx.subTag) dq = dq.contains("sub_tags", [ctx.subTag]);
      var dResp = await dq.limit(CASE_LAW_SUBJECT_DOC_CAP);
      docIds = (dResp.data || []).map(function (r) { return r.id; });
      scopeLabel = (ctx.subjectName || "chosen subject") + (ctx.subTag ? " — " + ctx.subTag : "");
      /* Nothing filed under that subject. Never widen to the whole library:
         the user confined the search on purpose. */
      if (docIds.length === 0) {
        skipSearch = true;
        console.log("[draft] case law: nothing filed under " + scopeLabel + ", library search skipped");
      }
    }
  }

  if (!skipSearch) {
    var rows = await caseLawSearchChunks(supabase, userId, queryText, docIds);
    if (rows.length > 0) {
      var byDoc = {};
      rows.forEach(function (r) { (byDoc[r.case_law_id] = byDoc[r.case_law_id] || []).push(r); });
      var ids = Object.keys(byDoc);
      var metaResp = await supabase.from("case_law_docs")
        .select("id, name, citation, jurisdiction, doc_type")
        .eq("user_id", userId).in("id", ids);
      var meta = {};
      (metaResp.data || []).forEach(function (d) { meta[d.id] = d; });
      var found = ids
        .filter(function (id) { return meta[id]; })
        .sort(function (a, b) { return String(meta[a].name).localeCompare(String(meta[b].name)); })
        .map(function (id) {
          var sorted = byDoc[id].sort(function (a, b) { return a.chunk_index - b.chunk_index; });
          return caseLawHeading(meta[id]) + "\n" + caseLawJoinChunks(sorted);
        });
      if (found.length > 0) {
        blocks.push("## AUTHORITIES FROM THE LIBRARY (" + scopeLabel + ")\n\nThe passages below are the parts of your case law library that bear most closely on the issues in this draft. They are extracts, not whole judgments — where a passage is cut, that is marked …\n\n" + found.join("\n\n"));
      }
    }
  }

  if (blocks.length === 0) return "";

  /* Same discipline the draft applies to document references: name the
     source, do not reproduce it. */
  return "\n\n# CASE LAW AND TEXTS\n\n"
    + "HOW TO USE THESE:\n"
    + "1. Any authority you rely on MUST be cited by name and citation exactly as given in its heading above — for example \"Schmidt v Rosewood Trust Ltd [2003] 2 AC 709\".\n"
    + "2. Do NOT reproduce these passages at length. State the proposition the authority supports in your own words and cite it. Quote only where the precise words matter, and then only a sentence or two.\n"
    + "3. Cite only what appears below. Do not cite an authority you have not been given here, and do not invent a citation for one that is missing.\n"
    + "4. Where the material below does not support a proposition you need, say so rather than stretching it.\n\n"
    + blocks.join("\n\n---\n\n");
}

function buildPageIndex(byDoc) {
  /* v5.22: parts of a split document are merged under the base document
     name, so the index shape is identical to v5.21 — one line per document.
     For unsplit documents the output is byte-for-byte unchanged. */
  var lines = [];
  var order = [];
  var groupedByLabel = {};
  var entries = Object.entries(byDoc);
  for (var i = 0; i < entries.length; i++) {
    var name = entries[i][0];
    var data = entries[i][1];
    if (data.pages && data.pages.length > 0) {
      var label = data.baseName || name;
      if (!groupedByLabel[label]) { groupedByLabel[label] = {}; order.push(label); }
      var grouped = groupedByLabel[label];
      for (var j = 0; j < data.pages.length; j++) {
        var p = data.pages[j];
        if (!grouped[p.page]) grouped[p.page] = [];
        grouped[p.page].push(p.chunkIndex + 1);
      }
    }
  }
  for (var li = 0; li < order.length; li++) {
    var refs = Object.entries(groupedByLabel[order[li]]).map(function(e) { return "p." + e[0] + " (\u00b6" + e[1].join(",") + ")"; }).join(", ");
    lines.push(order[li] + ": " + refs);
  }
  return lines.length > 0 ? "\n\nPAGE REFERENCE INDEX:\n" + lines.join("\n") : "";
}

/* v4.3b: helper that detects whether a thrown Anthropic error is a transient
   overload/rate-limit that we should retry, vs a hard error we should propagate.
   The SDK can throw errors in several shapes depending on whether the error
   surfaces at HTTP level, JSON-parse level, or inside the stream. We check
   every plausible path. */
function isRetryableAnthropicError(err) {
  if (!err) return false;
  /* HTTP status check — SDK exceptions usually carry .status */
  if (err.status === 529 || err.status === 429) return true;
  /* Structured error.type check — both .error.type and .error.error.type seen */
  var t1 = err.error && err.error.type;
  var t2 = err.error && err.error.error && err.error.error.type;
  if (t1 === "overloaded_error" || t1 === "rate_limit_error") return true;
  if (t2 === "overloaded_error" || t2 === "rate_limit_error") return true;
  /* String match on the message as a final fallback — for cases where the
     SDK has stringified the error before throwing. */
  var msg = (err.message || "") + "";
  if (msg.indexOf("overloaded_error") !== -1) return true;
  if (msg.indexOf("rate_limit_error") !== -1) return true;
  if (msg.indexOf("Overloaded") !== -1) return true;
  return false;
}

async function runTool(system, userPrompt, maxTokens) {
  /* v4.1: raised from 8192 to API max — synthesis of large matters was truncating */
  /* v4.1b: switched to streaming to avoid Anthropic 10-minute timeout on large outputs */
  /* v4.3b: retry on overloaded_error / rate_limit_error with exponential backoff.
     Anthropic Sonnet 4.6 has been intermittently overloaded — daily incidents on
     status.anthropic.com over the v4.x development period. Without retry, every
     brief overload kills a job. With retry, brief overloads become invisible.
     Non-retryable errors (auth, bad request, anything else) propagate immediately
     with no retry, identical to v4.3 behaviour. */
  maxTokens = maxTokens || 64000;
  var BACKOFF_MS = [5000, 15000, 45000]; /* attempt 1 fails -> wait 5s, attempt 2 fails -> 15s, attempt 3 fails -> 45s, attempt 4 is the last */
  var MAX_ATTEMPTS = BACKOFF_MS.length + 1;
  var attempt = 0;
  var lastErr = null;
  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    try {
      var stream = anthropic.messages.stream({
        model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
        max_tokens: maxTokens,
        system: system,
        messages: [{ role: "user", content: userPrompt }],
      });
      var finalMessage = await stream.finalMessage();
      var text = "";
      if (finalMessage.content) {
        for (var i = 0; i < finalMessage.content.length; i++) {
          if (finalMessage.content[i].type === "text") { text = finalMessage.content[i].text; break; }
        }
      }
      var inputTokens = (finalMessage.usage && finalMessage.usage.input_tokens) || 0;
      var outputTokens = (finalMessage.usage && finalMessage.usage.output_tokens) || 0;
      var cost = (inputTokens * INPUT_COST_PER_M / 1000000) + (outputTokens * OUTPUT_COST_PER_M / 1000000);
      if (attempt > 1) {
        console.log("v4.3b runTool: succeeded on attempt " + attempt + " of " + MAX_ATTEMPTS);
      }
      return { text: text, inputTokens: inputTokens, outputTokens: outputTokens, cost: cost };
    } catch (err) {
      lastErr = err;
      if (!isRetryableAnthropicError(err)) {
        /* Non-retryable — throw immediately, identical to v4.3 behaviour */
        throw err;
      }
      if (attempt >= MAX_ATTEMPTS) {
        /* Out of retries — log and throw */
        console.log("v4.3b runTool: retryable error on final attempt " + attempt + ", giving up: " + (err.message || err));
        throw err;
      }
      var waitMs = BACKOFF_MS[attempt - 1];
      console.log("v4.3b runTool: retryable error on attempt " + attempt + " of " + MAX_ATTEMPTS + " (" + (err.message || "no message").slice(0, 200) + "), waiting " + (waitMs / 1000) + "s before retry");
      await new Promise(function(r) { setTimeout(r, waitMs); });
    }
  }
  /* Unreachable in normal flow — the loop either returns or throws — but if
     we somehow exit, throw the last error so the caller knows. */
  throw lastErr || new Error("runTool: exhausted retries with no final error");
}

async function logUsage(matterId, userId, toolName, inputTokens, outputTokens, cost) {
  try {
    await supabase.from("usage_log").insert({
      matter_id: matterId, user_id: userId, tool_name: toolName,
      input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: cost,
    });
  } catch (e) { console.error("Usage log error:", e); }
}

async function saveHistory(matterId, userId, question, answer, toolName) {
  try {
    await supabase.from("conversation_history").insert({
      matter_id: matterId, user_id: userId,
      question: question, answer: answer, tool_name: toolName,
    });
  } catch (e) { console.error("History save error:", e); }
}

function formatCourtHeading(h) {
  if (!h || (!h.court && !h.party1)) return "";
  var lines = [];
  if (h.court) lines.push(h.court);
  if (h.caseNo) lines.push(h.caseNo);
  lines.push("");
  lines.push("BETWEEN:");
  lines.push("");
  if (h.party1) lines.push(h.party1 + (h.party1Role ? "          " + h.party1Role : ""));
  lines.push("\u2014 and \u2014");
  if (h.party2) lines.push(h.party2 + (h.party2Role ? "          " + h.party2Role : ""));
  if (h.docTitle) {
    lines.push("");
    lines.push("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
    lines.push(h.docTitle);
    lines.push("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
  }
  lines.push("");
  return lines.join("\n");
}

/* ══════════════════════════════════════════════════════════════════════════
   JOB MANAGEMENT
   ══════════════════════════════════════════════════════════════════════════ */

/* v4.2j: updateJob now throws on error instead of swallowing. It also chains
   .select() to force a round-trip that returns the updated row, so we can
   verify critical fields actually persisted. Previously updateJob logged errors
   to console.error but returned normally, so a silent failure (stale schema
   cache stripping columns, for example) looked identical to success.

   Strict field verification is limited to a whitelist of fields where a
   mismatch would be catastrophic. Timestamp and numeric fields are omitted
   because Postgres normalises them on return and the string comparison would
   report false positives. */
var CRITICAL_FIELDS = {
  condensed_extracts: true,
  condense_done: true,
  status: true,
  batches_done: true,
  /* v5.8a: sectioned-synthesis persistence. A stale schema cache silently
     dropping these columns would leave a planned Briefing/Draft/Proposition
     job with no plan and no section results, which would look identical to
     a pre-plan state and cause infinite replanning on re-entry. */
  section_plan: true,
  section_results: true,
};

async function updateJob(jobId, fields) {
  /* v4.3: heartbeat. Every updateJob() call stamps updated_at so the cron-resume
     endpoint can identify stale in-progress jobs. updated_at is intentionally
     NOT in CRITICAL_FIELDS — Postgres normalises timestamps on return and a
     string comparison would report false positives. */
  fields.updated_at = new Date().toISOString();
  var resp = await supabase
    .from("tool_jobs")
    .update(fields)
    .eq("id", jobId)
    .select();
  if (resp.error) {
    console.error("Job update error for " + jobId + ":", resp.error.message);
    throw new Error("updateJob failed: " + resp.error.message);
  }
  if (!resp.data || resp.data.length === 0) {
    console.error("Job update returned no rows for " + jobId + " — row missing or RLS blocking");
    throw new Error("updateJob returned no rows for " + jobId);
  }
  /* Verify critical fields actually persisted. If supabase-js silently strips
     an unknown column from the payload (stale schema cache), the returned row
     will still have the old value — this check catches that. */
  var returned = resp.data[0];
  var mismatch = [];
  for (var k in fields) {
    if (fields.hasOwnProperty(k) && CRITICAL_FIELDS[k]) {
      var expected = JSON.stringify(fields[k]);
      var actual = JSON.stringify(returned[k]);
      if (expected !== actual) {
        var expectedShort = expected.length > 80 ? expected.slice(0, 80) + "..." : expected;
        var actualShort = actual.length > 80 ? actual.slice(0, 80) + "..." : actual;
        mismatch.push(k + " expected=" + expectedShort + " got=" + actualShort);
      }
    }
  }
  if (mismatch.length > 0) {
    console.error("Job update critical fields did not persist for " + jobId + ": " + mismatch.join("; "));
    throw new Error("updateJob field mismatch: " + mismatch.join("; "));
  }
  return returned;
}

async function failJob(jobId, errorMsg) {
  await updateJob(jobId, { status: "failed", error: errorMsg, completed_at: new Date().toISOString() });
}

/* v5.9b: Increment synth_attempts and check the guard. Called immediately
   before each real synthesis call (single-call path, sectioned plan call).
   Returns true if the guard fired and the job has been failed; the caller
   should bail out. Returns false to proceed with synthesis.
   The threshold is the same as the previous v4.5c guard (>= 5 prior real
   synthesis attempts), but now counts only true synthesis attempts rather
   than every entry into the synthesising branch — so chained continuations
   that did only condense work don't burn the budget. */
async function bumpAndGuardSynthAttempts(jobId, job, extractsLength) {
  var priorAttempts = job.synth_attempts || 0;
  var newAttempts = priorAttempts + 1;
  console.log("v5.9b Worker: incrementing synth_attempts before real synthesis call (priorAttempts=" + priorAttempts + ", newAttempts=" + newAttempts + ")");
  await updateJob(jobId, { synth_attempts: newAttempts });
  if (priorAttempts >= 5) {
    var stuckMsg = "Synthesis exceeded retry limit (" + newAttempts + " real synthesis attempts with no successful completion). The matter may be too large for the current configuration, or the model is repeatedly failing to produce a complete output. Consider reducing the matter size, narrowing the focus instructions, or contacting support.";
    console.error("v5.9b Worker: " + stuckMsg);
    await failJob(jobId, stuckMsg);
    return true;
  }
  return false;
}

/* ══════════════════════════════════════════════════════════════════════════
   BATCHED RUNNER (v4.2e: frontend-driven chaining)
   Processes extraction batches within time limit. If time runs out, saves
   progress and sets status to "paused". Frontend polls, detects "paused",
   and calls /api/worker again. No server-to-server chaining.
   Returns null if paused/synthesising (caller should return response and stop).
   ══════════════════════════════════════════════════════════════════════════ */

async function runBatchedChained(jobId, job, systemBase, extractPromptFn, synthPromptFn, byDoc, hostUrl, options) {
  var batches = batchDocs(byDoc);
  var startTime = Date.now();

  /* Resume from previous invocation */
  var batchesDone = job.batches_done || 0;
  var extracts = [];
  try {
    if (job.extracts && Array.isArray(job.extracts)) extracts = job.extracts;
  } catch (e) { extracts = []; }
  var totalInput = job.input_tokens || 0;
  var totalOutput = job.output_tokens || 0;
  var totalCost = parseFloat(job.cost_usd) || 0;

  /* v4.2e: If status is "synthesising", skip extraction — go straight to synthesis */
  if (job.status === "synthesising") {
    console.log("Worker: running synthesis for " + jobId + " (" + extracts.length + " extracts)");

    /* v5.9b: Persistent-failure detection (REVISED).
       Previously synth_attempts was incremented here on every entry into the
       synthesising branch — including legitimate chained continuations doing
       only condense work. On a job where condensing took several invocations
       to complete, the counter could reach 5+ purely from condense entries,
       and the guard would fire prematurely on the very first real synthesis
       attempt — which then succeeded, but too late to clear the stuck-error.
       Fix: do NOT increment on entry. Increment immediately before the actual
       synthesis runTool call (and the sectioned plan call), so the counter
       reflects true synthesis attempts only. */
    var priorAttempts = job.synth_attempts || 0;
    var priorCondenseDone = job.condense_done || 0;
    var priorResult = job.result || null;
    console.log("v5.9b Worker: synthesising entry (prior synth_attempts=" + priorAttempts + ", prior condense_done=" + priorCondenseDone + ", prior result=" + (priorResult ? "set" : "null") + ")");

    /* Condense phase. Unchanged from v4.5c. */
    var SYNTH_GROUP = 3;
    var CONDENSE_MAX_TOKENS = 10000;
    var condensed = job.condensed_extracts || null;
    var condenseDoneFromDb = job.condense_done || 0;
    var needsCondense = extracts.length > SYNTH_GROUP && condenseDoneFromDb < extracts.length;

    if (needsCondense) {
      if (!condensed) condensed = [];
      var condenseDone = condenseDoneFromDb;
      console.log("v4.2i Worker: condensing " + extracts.length + " extracts in groups of " + SYNTH_GROUP + " (starting from group " + condenseDone + ", " + condensed.length + " already done)");

      var CONDENSE_TIME_LIMIT_MS = 600000;

      for (var gi = condenseDone; gi < extracts.length; gi += SYNTH_GROUP) {
        var elapsedSec = Math.round((Date.now() - startTime) / 1000);
        if (Date.now() - startTime > CONDENSE_TIME_LIMIT_MS) {
          console.log("v4.2i Worker: condense paused at group " + gi + " (" + elapsedSec + "s elapsed)");
          await updateJob(jobId, {
            condensed_extracts: condensed,
            condense_done: gi,
            status: "synthesising",
            input_tokens: totalInput,
            output_tokens: totalOutput,
            cost_usd: totalCost,
          });
          return null;
        }

        var group = extracts.slice(gi, gi + SYNTH_GROUP);
        var groupText = group.map(function(e, idx) { return "=== BATCH " + (gi + idx + 1) + " FINDINGS ===\n" + e; }).join("\n\n");

        console.log("v4.2i Worker: starting condense call for group " + gi + " (" + group.length + " extracts, " + groupText.length + " chars input, " + elapsedSec + "s elapsed)");
        var condenseCallStart = Date.now();

        var condenseResult;
        try {
          condenseResult = await runTool(systemBase,
            "Condense these extraction findings into a comprehensive summary. Preserve ALL key facts, dates, names, document references, and evidence. Do not omit anything significant.\n\nFINDINGS:\n\n" + groupText,
            CONDENSE_MAX_TOKENS
          );
        } catch (condenseErr) {
          console.log("v4.2i Worker: CONDENSE CALL FAILED at group " + gi + " after " + Math.round((Date.now() - condenseCallStart) / 1000) + "s: " + condenseErr.message);
          await updateJob(jobId, {
            condensed_extracts: condensed,
            condense_done: gi,
            status: "synthesising",
            input_tokens: totalInput,
            output_tokens: totalOutput,
            cost_usd: totalCost,
            error: "Condense group " + gi + " failed: " + condenseErr.message,
          });
          throw condenseErr;
        }

        var condenseCallSec = Math.round((Date.now() - condenseCallStart) / 1000);
        console.log("v4.2i Worker: condense call for group " + gi + " returned in " + condenseCallSec + "s, output " + (condenseResult.text ? condenseResult.text.length : 0) + " chars, " + condenseResult.outputTokens + " tokens");

        condensed.push(condenseResult.text);
        totalInput += condenseResult.inputTokens;
        totalOutput += condenseResult.outputTokens;
        totalCost += condenseResult.cost;

        console.log("v4.2i Worker: writing progress to DB after group " + gi + " (condense_done=" + (gi + SYNTH_GROUP) + ", condensed.length=" + condensed.length + ")");
        await updateJob(jobId, {
          condensed_extracts: condensed,
          condense_done: gi + SYNTH_GROUP,
          status: "synthesising",
          input_tokens: totalInput,
          output_tokens: totalOutput,
          cost_usd: totalCost,
        });
        console.log("v4.2i Worker: DB write complete for group " + gi + ", total elapsed " + Math.round((Date.now() - startTime) / 1000) + "s");
      }

      if (Date.now() - startTime > TIME_LIMIT_MS) {
        console.log("Worker: condense done, setting synthesising before final synthesis");
        await updateJob(jobId, {
          condensed_extracts: condensed,
          condense_done: extracts.length,
          input_tokens: totalInput,
          output_tokens: totalOutput,
          cost_usd: totalCost,
          status: "synthesising",
        });
        fetch(hostUrl + "/api/worker?jobId=" + jobId, {
          method: "POST", headers: { "Content-Type": "application/json" }
        }).catch(function(ce) { console.log("Chain attempt:", ce.message); });
        await new Promise(function(r) { setTimeout(r, 2000); });
        return null;
      }
    }

    /* Stage 2 input preparation */
    var synthInput;
    if (condensed && condensed.length > 0) {
      synthInput = condensed.map(function(e, idx) { return "=== SUMMARY " + (idx + 1) + " ===\n" + e; }).join("\n\n");
      console.log("Worker: final synthesis from " + condensed.length + " condensed summaries");
    } else {
      synthInput = extracts.map(function(e, idx) { return "=== BATCH " + (idx + 1) + " FINDINGS ===\n" + e; }).join("\n\n");
      console.log("Worker: direct synthesis from " + extracts.length + " extracts");
    }

    /* v5.5: Heartbeat immediately before final synthesis so the cron-resume
       240s threshold is not breached during the long Claude call. */
    await updateJob(jobId, {});

    /* v5.8a: Sectioned vs single-call branching. */
    var useSectioned = !!(options && options.sectioned);

    if (useSectioned) {
      var toolName = (options && options.toolName) || "briefing";
      var userInstructions = (options && options.instructions) || "";
      var actingFor = (options && options.actingFor) || "";
      var matterName = (options && options.matterName) || "";
      var sectionHeaderText = (options && options.headerText) || "";

      var existingPlan = Array.isArray(job.section_plan) ? job.section_plan : null;
      var plan;
      if (existingPlan && existingPlan.length > 0) {
        plan = existingPlan;
        console.log("v5.8a sectioned: resuming with existing plan of " + plan.length + " sections");
      } else {
        /* v5.9b: increment synth_attempts and check the guard immediately
           before the real plan call. Resuming with an existing plan skips
           this — the work has already been done. */
        var guardFiredSectioned = await bumpAndGuardSynthAttempts(jobId, job, extracts.length);
        if (guardFiredSectioned) return null;
        var planStart = Date.now();
        console.log("v5.9b sectioned: calling planSections for " + toolName);
        var planResult;
        try {
          planResult = await planSectionsLib(runTool, systemBase, toolName, userInstructions, synthInput, actingFor, matterName);
        } catch (planErr) {
          console.error("v5.9b sectioned: plan phase failed, falling back to single-call synthesis: " + planErr.message);
          var fallbackResult = await runTool(systemBase, synthPromptFn(synthInput, batches.length), 16384);
          totalInput += fallbackResult.inputTokens;
          totalOutput += fallbackResult.outputTokens;
          totalCost += fallbackResult.cost;
          return { text: fallbackResult.text, inputTokens: totalInput, outputTokens: totalOutput, cost: totalCost, done: true };
        }
        plan = planResult.sections;
        totalInput += planResult.inputTokens;
        totalOutput += planResult.outputTokens;
        totalCost += planResult.cost;
        console.log("v5.9b sectioned: plan produced in " + Math.round((Date.now() - planStart) / 1000) + "s, " + plan.length + " sections");
        await updateJob(jobId, { section_plan: plan });
      }

      var secResult = await synthesiseSectionsLib(runTool, updateJob, jobId, job, systemBase, toolName, userInstructions, synthInput, plan, actingFor, matterName, sectionHeaderText);
      totalInput += secResult.inputTokens;
      totalOutput += secResult.outputTokens;
      totalCost += secResult.cost;

      if (secResult.sectionsCompleted === 0) {
        throw new Error("All " + plan.length + " sections failed synthesis. The matter may be too large for the current configuration, or the model is repeatedly failing on this content. Consider reducing the matter size or narrowing the focus instructions.");
      }

      console.log("v5.8a sectioned: synthesis complete, " + secResult.sectionsCompleted + "/" + plan.length + " sections succeeded");
      return { text: secResult.text, inputTokens: totalInput, outputTokens: totalOutput, cost: totalCost, done: true };
    }

    /* Original single-call synthesis path (Group A tools + Citations) */
    /* v5.9b: increment synth_attempts and check the guard immediately before
       the real synthesis call. Returns true if the guard fired (job already
       failed); bail out so the worker exits cleanly. */
    var guardFiredSingle = await bumpAndGuardSynthAttempts(jobId, job, extracts.length);
    if (guardFiredSingle) return null;
    var synthCallStart = Date.now();
    console.log("v5.9b Worker: starting final synthesis call (heartbeat refreshed)");
    var synthResult = await runTool(systemBase, synthPromptFn(synthInput, batches.length), 16384);
    console.log("v5.9b Worker: final synthesis returned in " + Math.round((Date.now() - synthCallStart) / 1000) + "s, output " + (synthResult.text ? synthResult.text.length : 0) + " chars, " + synthResult.outputTokens + " tokens");
    totalInput += synthResult.inputTokens;
    totalOutput += synthResult.outputTokens;
    totalCost += synthResult.cost;
    return { text: synthResult.text, inputTokens: totalInput, outputTokens: totalOutput, cost: totalCost, done: true };
  }

  await updateJob(jobId, {
    batches_total: batches.length,
    batches_done: batchesDone,
    status: "running",
    started_at: job.started_at || new Date().toISOString(),
  });

  /* Single-batch shortcut: no extraction phase needed */
  if (batches.length === 1 && batchesDone === 0) {
    var r = await runTool(systemBase, synthPromptFn(docsToText(batches[0]), null));
    return {
      text: r.text,
      inputTokens: totalInput + r.inputTokens,
      outputTokens: totalOutput + r.outputTokens,
      cost: totalCost + r.cost,
      done: true,
    };
  }

  /* Multi-batch: extraction phase — process from where we left off */
  for (var i = batchesDone; i < batches.length; i += PARALLEL) {
    if (Date.now() - startTime > TIME_LIMIT_MS) {
      console.log("Worker chain: processed batches 1-" + i + " of " + batches.length + ", chaining (" + Math.round((Date.now() - startTime) / 1000) + "s elapsed)");
      await updateJob(jobId, {
        batches_done: i,
        extracts: extracts,
        input_tokens: totalInput,
        output_tokens: totalOutput,
        cost_usd: totalCost,
      });
      await updateJob(jobId, { status: "paused" });
      console.log("Worker: paused at batch " + i + " of " + batches.length);
      fetch(hostUrl + "/api/worker?jobId=" + jobId, {
        method: "POST", headers: { "Content-Type": "application/json" }
      }).catch(function(ce) { console.log("Chain attempt (frontend will retry if needed):", ce.message); });
      await new Promise(function(r) { setTimeout(r, 2000); });
      return null;
    }

    var slice = batches.slice(i, i + PARALLEL);
    var results = await Promise.all(slice.map(function(batch, j) {
      var batchText = docsToText(batch);
      return runTool(systemBase, extractPromptFn(batchText, i + j + 1, batches.length), 4096);
    }));
    for (var ri = 0; ri < results.length; ri++) {
      extracts.push(results[ri].text);
      totalInput += results[ri].inputTokens;
      totalOutput += results[ri].outputTokens;
      totalCost += results[ri].cost;
    }
    batchesDone = Math.min(i + PARALLEL, batches.length);

    await updateJob(jobId, {
      batches_done: batchesDone,
      input_tokens: totalInput,
      output_tokens: totalOutput,
      cost_usd: totalCost,
    });
  }

  /* Extraction done. Set "synthesising" and try server-side chain. */
  if (Date.now() - startTime > 10000) {
    console.log("Worker: extraction done (" + batches.length + " batches, " + Math.round((Date.now() - startTime) / 1000) + "s elapsed), setting synthesising");
    await updateJob(jobId, {
      batches_done: batches.length,
      extracts: extracts,
      input_tokens: totalInput,
      output_tokens: totalOutput,
      cost_usd: totalCost,
      status: "synthesising",
    });
    fetch(hostUrl + "/api/worker?jobId=" + jobId, {
      method: "POST", headers: { "Content-Type": "application/json" }
    }).catch(function(ce) { console.log("Chain attempt (frontend will retry if needed):", ce.message); });
    await new Promise(function(r) { setTimeout(r, 2000); });
    return null;
  }

  /* Enough time remaining — run synthesis directly.
     v5.8a: max_tokens raised from 10000 to 16384 on the single-call path.
     If options.sectioned is set, run the plan-then-loop path instead. */
  var combinedExtracts = extracts.map(function(e, idx) { return "=== BATCH " + (idx + 1) + " FINDINGS ===\n" + e; }).join("\n\n");
  var useSectionedDirect = !!(options && options.sectioned);

  if (useSectionedDirect) {
    var toolNameDirect = (options && options.toolName) || "briefing";
    var userInstructionsDirect = (options && options.instructions) || "";
    var actingForDirect = (options && options.actingFor) || "";
    var matterNameDirect = (options && options.matterName) || "";
    var headerTextDirect = (options && options.headerText) || "";

    var existingPlanDirect = Array.isArray(job.section_plan) ? job.section_plan : null;
    var planDirect;
    if (existingPlanDirect && existingPlanDirect.length > 0) {
      planDirect = existingPlanDirect;
      console.log("v5.8a sectioned (direct): resuming with existing plan of " + planDirect.length + " sections");
    } else {
      var planResultDirect;
      try {
        planResultDirect = await planSectionsLib(runTool, systemBase, toolNameDirect, userInstructionsDirect, combinedExtracts, actingForDirect, matterNameDirect);
      } catch (planErrDirect) {
        console.error("v5.8a sectioned (direct): plan phase failed, falling back to single-call synthesis: " + planErrDirect.message);
        var fallbackDirect = await runTool(systemBase, synthPromptFn(combinedExtracts, batches.length), 16384);
        totalInput += fallbackDirect.inputTokens;
        totalOutput += fallbackDirect.outputTokens;
        totalCost += fallbackDirect.cost;
        return { text: fallbackDirect.text, inputTokens: totalInput, outputTokens: totalOutput, cost: totalCost, done: true };
      }
      planDirect = planResultDirect.sections;
      totalInput += planResultDirect.inputTokens;
      totalOutput += planResultDirect.outputTokens;
      totalCost += planResultDirect.cost;
      await updateJob(jobId, { section_plan: planDirect });
    }

    var secResultDirect = await synthesiseSectionsLib(runTool, updateJob, jobId, job, systemBase, toolNameDirect, userInstructionsDirect, combinedExtracts, planDirect, actingForDirect, matterNameDirect, headerTextDirect);
    totalInput += secResultDirect.inputTokens;
    totalOutput += secResultDirect.outputTokens;
    totalCost += secResultDirect.cost;

    if (secResultDirect.sectionsCompleted === 0) {
      throw new Error("All " + planDirect.length + " sections failed synthesis. The matter may be too large for the current configuration, or the model is repeatedly failing on this content. Consider reducing the matter size or narrowing the focus instructions.");
    }
    return { text: secResultDirect.text, inputTokens: totalInput, outputTokens: totalOutput, cost: totalCost, done: true };
  }

  var synthResult = await runTool(systemBase, synthPromptFn(combinedExtracts, batches.length), 16384);
  totalInput += synthResult.inputTokens;
  totalOutput += synthResult.outputTokens;
  totalCost += synthResult.cost;

  return { text: synthResult.text, inputTokens: totalInput, outputTokens: totalOutput, cost: totalCost, done: true };
}

/* ══════════════════════════════════════════════════════════════════════════
   MAIN HANDLER
   v3.4.1 FIX: Response is sent AFTER processing, not before. Vercel keeps
   the function alive as long as the response has not been sent.
   ══════════════════════════════════════════════════════════════════════════ */

const SERVER_VERSION = "v5.23";
export default async function handler(req, res) {
  console.log(SERVER_VERSION + " worker handler: " + (req.method || "?") + " " + (req.url || ""));
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  var jobId = req.query.jobId;
  if (!jobId) return res.status(400).json({ error: "jobId required" });

  /* v4.2j: Fresh Supabase client for this invocation. Overwrites the module-level
     binding so every helper in this file uses the new client without needing a
     signature change. Fresh client = fresh PostgREST schema cache. */
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log("v4.2j Worker: fresh supabase client created for job " + jobId);

  try {
    /* Load job */
    var jobResp = await supabase.from("tool_jobs").select("*").eq("id", jobId).single();
    if (jobResp.error || !jobResp.data) {
      console.error("Job load error:", jobResp.error && jobResp.error.message);
      return res.status(404).json({ error: "Job not found" });
    }
    var job = jobResp.data;

    if (job.status === "complete" || job.status === "failed") {
      console.log("Job already finished: " + jobId);
      return res.status(200).json({ ok: true, status: "already_done" });
    }
    /* v4.2e: "paused" and "synthesising" are valid — worker should continue */

    var hostUrl = "https://" + req.headers.host;
    var matterId = job.matter_id;
    var userId = job.user_id;
    var tool = job.tool_name;
    var instructions = job.instructions || "";
    var p = job.parameters || {};
    var jur = p.jurisdiction || "Bermuda";
    var matterName = p.matterName || "";
    var actingFor = p.actingFor || "";
    var excludeDocNames = p.excludeDocNames || [];
    /* v5.0: includeDocNames is the folder filter — frontend resolves selected
       folders to document names and passes them here. Empty = no filter. */
    var includeDocNames = p.includeDocNames || [];
    /* v5.11a (Draft Build 1): two new draft-only fields.
       matterToolHistory: array of {tool_name, question, answer} for the
         most-recent analysis-tool result of each tool, used as background
         context in the draft prompt.
       learnFromComparable: boolean flag for the cross-matter comparable-
         document hunt. Currently only logged; the hunt is built in a later
         build. */
    var matterToolHistory = Array.isArray(p.matterToolHistory) ? p.matterToolHistory : [];
    var learnFromComparable = (p.learnFromComparable !== false);

    /* v5.10a: Issues focus widget. Two optional fields sent by the new
       launch modal for the Issues tool. The "Question to develop"
       textarea reuses id="toolInstructions" on the frontend so its value
       arrives on job.instructions as today \u2014 nothing new to read for
       that field. All harmless defaults for every other tool. */
    var subElement = p.subElement || "";
    var focusDocNames = Array.isArray(p.focusDocNames) ? p.focusDocNames : [];

    /* v5.17 Push C: server-side draft persistence. For draft jobs created
       by api/tools.js v5.17 or later, p.draftRowId is the id of a drafts
       row created at job-start. The worker UPDATEs that row on completion
       (see completion block far below). Null/missing for every non-draft
       tool and for draft jobs created before v5.17 \u2014 the latter fall
       back to the old client-side save behaviour. Backward-compatible. */
    var draftRowId = p.draftRowId || null;

    /* v5.10a: Build focusBlock once, reused across the three Issues prompt
       fragments below. Each contributor only adds to the block when
       non-empty. With nothing typed, focusBlock == "" and the prompts are
       identical to v5.9b. The "Focus: <instructions>" line is preserved
       verbatim from v5.9b for that case, so a job that only fills the
       Question textarea is byte-identical to v5.9b. */
    var focusBlock = "";
    if (instructions) focusBlock += "Focus: " + instructions + "\n\n";
    if (subElement) focusBlock += "Issue or sub-element to develop: " + subElement + "\n\n";
    if (focusDocNames.length > 0) {
      focusBlock += "Concentrate your analysis on these documents: " + focusDocNames.join(", ")
        + ". You may still reference other documents where relevant.\n\n";
    }

    var matterContext = [
      p.matterNature ? "Nature of the dispute: " + p.matterNature : "",
      p.matterIssues ? "Key issues: " + p.matterIssues : "",
      actingFor ? "Acting for: " + actingFor : "",
    ].filter(Boolean).join("\n");

    /* Get court heading.
       v5.23: for every tool except draft, the tramline title (docTitle) is
       replaced with "<TOOL NAME> ON <PROCEDURAL STAGE>" in capitals; the
       stage name comes from case_subcategories via matters.subcategory_id.
       No stage selected -> tool name alone. Stored docTitle is ignored for
       tool outputs. Draft keeps its heading-editor title untouched. */
    var heading = p.courtHeading || null;
    var matterStageName = "";
    if (!heading || tool !== "draft") {
      try {
        var matterResp = await supabase.from("matters").select("heading_data, subcategory_id").eq("id", matterId).single();
        if (matterResp.data) {
          if (!heading && matterResp.data.heading_data && (matterResp.data.heading_data.court || matterResp.data.heading_data.party1)) {
            heading = matterResp.data.heading_data;
          }
          if (tool !== "draft" && matterResp.data.subcategory_id) {
            try {
              var stageResp = await supabase.from("case_subcategories").select("name").eq("id", matterResp.data.subcategory_id).single();
              if (stageResp.data && stageResp.data.name) matterStageName = String(stageResp.data.name);
            } catch (e2) { /* no stage lookup */ }
          }
        }
      } catch (e) { /* no heading */ }
    }
    if (heading && tool !== "draft") {
      var TOOL_TITLES = { issues: "ISSUES", briefing: "BRIEFING", chronology: "CHRONOLOGY", persons: "DRAMATIS PERSONAE", proposition: "PROPOSITION EVIDENCE", inconsistency: "INCONSISTENCY TRACKER", citations: "CITATION CHECK", issueBriefing: "ISSUE BRIEFING" };
      var toolTitle = TOOL_TITLES[tool] || null;
      if (toolTitle) {
        heading = { court: heading.court, caseNo: heading.caseNo, party1: heading.party1, party1Role: heading.party1Role, party2: heading.party2, party2Role: heading.party2Role, docTitle: toolTitle + (matterStageName ? " ON " + matterStageName.toUpperCase() : "") };
      }
    }
    var headingText = heading ? formatCourtHeading(heading) : "";

    /* v4.2g: Do not clobber an in-progress synthesising/paused status on re-entry.
       The worker is re-fired by the frontend when status is "paused" or "synthesising";
       overwriting it back to "running" here would prevent the next pause from being
       visible to the frontend, breaking the chain. */
    var statusUpdate = { started_at: job.started_at || new Date().toISOString() };
    if (job.status !== "synthesising" && job.status !== "paused") {
      statusUpdate.status = "running";
    }
    await updateJob(jobId, statusUpdate);

    var result = "";
    var inputTokens = 0;
    var outputTokens = 0;
    var cost = 0;

    /* ── PROPOSITION EVIDENCE FINDER ───────────────────────────────────── */
    if (tool === "proposition") {
      var chunks = applyDocFilters(await getAllChunks(matterId), excludeDocNames, includeDocNames);
      var byDoc = chunksToDocMap(chunks);
      var pageIndex = buildPageIndex(byDoc);
      var systemBase = "You are a senior litigation counsel in " + jur + " conducting an evidence assessment for the matter \"" + matterName + "\".\n" + matterContext;
      var r = await runBatchedChained(jobId, job, systemBase,
        function(batchText, batchNum, total) { return "PROPOSITION: \"" + instructions + "\"\n\nBatch " + batchNum + " of " + total + ". Extract ALL relevant passages \u2014 supporting, contradicting, or neutral.\n\nFor each:\n### [Document] \u2014 [Brief description]\nGRADE: [1-5]\n[Relevant passage]\n**Analysis:** [Relevance to proposition]\n**Reference:** [page and paragraph if available]\n\nGrading: 5=strong direct, 4=good supportive, 3=moderate indirect, 2=weak tangential, 1=contrary" + pageIndex + "\n\nDOCUMENTS:\n\n" + batchText; },
        function(combined, numBatches) { return numBatches ? "PROPOSITION: \"" + instructions + "\"\n\nSynthesise findings from " + numBatches + " batches into a single evidence assessment.\n\nRetain format:\n### [Document] \u2014 [Description]\nGRADE: [1-5]\n[Passage]\n**Analysis:** [Relevance]\n**Reference:** [page and paragraph]\n\nThen:\n## Overall Assessment\nStrength of evidence for/against and view on balance of probabilities.\n\nFINDINGS:\n\n" + combined : "PROPOSITION: \"" + instructions + "\"\n\nFind ALL evidence \u2014 supporting, contradicting, or neutral.\n\n### [Document] \u2014 [Description]\nGRADE: [1-5] (5=strong direct, 4=good supportive, 3=moderate indirect, 2=weak tangential, 1=contrary)\n[Relevant passage]\n**Analysis:** [Relevance]\n**Reference:** [page and paragraph if available]\n\n## Overall Assessment\nSummary and preliminary view." + pageIndex + "\n\nDOCUMENTS:\n\n" + combined; },
        byDoc, hostUrl,
        { sectioned: true, toolName: "proposition", instructions: instructions, actingFor: actingFor, matterName: matterName, headerText: "" }
      );
      if (r === null) return res.status(200).json({ ok: true, status: "continuing" });
      result = r.text; inputTokens = r.inputTokens; outputTokens = r.outputTokens; cost = r.cost;
    }

    /* ── INCONSISTENCY TRACKER ─────────────────────────────────────────── */
    else if (tool === "inconsistency") {
      var chunks = applyDocFilters(await getAllChunks(matterId), excludeDocNames, includeDocNames);
      var byDoc = chunksToDocMap(chunks);
      var anchorDocs = {};
      var otherDocs = {};
      var anchorDocNames = p.anchorDocNames || [];
      var entries = Object.entries(byDoc);
      for (var ei = 0; ei < entries.length; ei++) {
        if (anchorDocNames.indexOf(entries[ei][0]) !== -1) anchorDocs[entries[ei][0]] = entries[ei][1];
        else otherDocs[entries[ei][0]] = entries[ei][1];
      }
      if (Object.keys(anchorDocs).length === 0) {
        var mid = Math.ceil(entries.length / 2);
        anchorDocs = Object.fromEntries(entries.slice(0, mid));
        otherDocs = Object.fromEntries(entries.slice(mid));
      }
      var systemBase = "You are a senior litigation counsel conducting forensic inconsistency analysis for \"" + matterName + "\" in " + jur + ".\n" + matterContext;
      var anchorText = docsToText(anchorDocs);
      if (anchorText.length > 40000) anchorText = anchorText.slice(0, 40000) + "\n[...anchor truncated...]";
      var otherBatches = batchDocs(otherDocs);
      var allFindings = [];
      var totalInput = job.input_tokens || 0;
      var totalOutput = job.output_tokens || 0;
      var totalCost = parseFloat(job.cost_usd) || 0;
      var startTime = Date.now();

      /* Resume support */
      var batchesDone = job.batches_done || 0;
      try { if (job.extracts && Array.isArray(job.extracts)) allFindings = job.extracts; } catch (e) {}

      await updateJob(jobId, { batches_total: otherBatches.length + 1, batches_done: batchesDone, status: "running", started_at: job.started_at || new Date().toISOString() });

      var INCON_PARALLEL = 2;
      for (var ii = batchesDone; ii < otherBatches.length; ii += INCON_PARALLEL) {
        if (Date.now() - startTime > TIME_LIMIT_MS) {
          await updateJob(jobId, { batches_done: ii, extracts: allFindings, input_tokens: totalInput, output_tokens: totalOutput, cost_usd: totalCost, status: "paused" });
          console.log("Worker: inconsistency paused at batch " + ii);
          fetch(hostUrl + "/api/worker?jobId=" + jobId, { method: "POST", headers: { "Content-Type": "application/json" } }).catch(function(ce) { console.log("Chain attempt:", ce.message); });
          await new Promise(function(r) { setTimeout(r, 2000); });
          return res.status(200).json({ ok: true, status: "paused" });
        }
        var slice = otherBatches.slice(ii, ii + INCON_PARALLEL);
        var results = await Promise.all(slice.map(function(batch, j) {
          return runTool(systemBase,
            "Find every inconsistency between ANCHOR DOCUMENTS and this batch.\n\n### [N]. [Description]\n**Anchor:** [Document and passage, with page reference if available]\n**Contradiction:** [Document and passage, with page reference if available]\n**Significance:** CRITICAL / SIGNIFICANT / MINOR\n**Tactical note:** [How to use or address]\n\nANCHOR:\n\n" + anchorText + "\n\nOTHER (batch " + (ii + j + 1) + "/" + otherBatches.length + "):\n\n" + docsToText(batch) + "\n\n" + (instructions ? "Instructions: " + instructions : ""),
            4096
          );
        }));
        for (var ri = 0; ri < results.length; ri++) {
          allFindings.push(results[ri].text);
          totalInput += results[ri].inputTokens; totalOutput += results[ri].outputTokens; totalCost += results[ri].cost;
        }
        batchesDone = Math.min(ii + INCON_PARALLEL, otherBatches.length);
        await updateJob(jobId, { batches_done: batchesDone, input_tokens: totalInput, output_tokens: totalOutput, cost_usd: totalCost });
      }

      if (allFindings.length === 1) {
        result = allFindings[0];
      } else {
        if (Date.now() - startTime > TIME_LIMIT_MS) {
          await updateJob(jobId, { batches_done: otherBatches.length, extracts: allFindings, input_tokens: totalInput, output_tokens: totalOutput, cost_usd: totalCost, status: "synthesising" });
          console.log("Worker: inconsistency extraction done, set synthesising");
          fetch(hostUrl + "/api/worker?jobId=" + jobId, { method: "POST", headers: { "Content-Type": "application/json" } }).catch(function(ce) { console.log("Chain attempt:", ce.message); });
          await new Promise(function(r) { setTimeout(r, 2000); });
          return res.status(200).json({ ok: true, status: "synthesising" });
        }
        var synth = await runTool(systemBase,
          "Consolidate these inconsistency findings, remove duplicates, sort by significance (CRITICAL first).\n\nEnd with:\n## Summary\nOverall factual assessment.\n\nFINDINGS:\n\n" + allFindings.map(function(f, fi) { return "=== BATCH " + (fi + 1) + " ===\n" + f; }).join("\n\n")
        );
        result = synth.text;
        totalInput += synth.inputTokens; totalOutput += synth.outputTokens; totalCost += synth.cost;
      }
      inputTokens = totalInput; outputTokens = totalOutput; cost = totalCost;
    }

    /* ── CHRONOLOGY ────────────────────────────────────────────────────── */
    else if (tool === "chronology") {
      var chunks = applyDocFilters(await getAllChunks(matterId), excludeDocNames, includeDocNames);
      var byDoc = chunksToDocMap(chunks);
      var pageIndex = buildPageIndex(byDoc);

      var chronoInstructions = instructions || "";
      if (p.chronologyDateRange) chronoInstructions += "\n\nDATE RANGE FILTER: Only include events within the date range: " + p.chronologyDateRange + ". Exclude all events outside this range.";
      if (p.chronologyEntities && p.chronologyEntities.trim()) chronoInstructions += "\n\nENTITY FOCUS: Focus specifically on these individuals or entities: " + p.chronologyEntities + ". Include only events directly involving or relevant to them. Title the output \"Documents Relevant to " + p.chronologyEntities + "\".";
      if (p.chronologyCorrespondenceFilter) chronoInstructions += "\n\nCORRESPONDENCE FILTER: Only include correspondence (letters, emails) if the letter or email is specifically referred to, quoted, or exhibited in a pleading, petition, or affidavit in the matter. Exclude correspondence that is not referenced in a sworn statement or pleading.";

      var focusBlock = chronoInstructions.trim() ? "Focus/Filters: " + chronoInstructions.trim() + "\n\n" : "";
      var entityTitle = (p.chronologyEntities && p.chronologyEntities.trim()) ? "Documents Relevant to " + p.chronologyEntities.trim() : "Chronology \u2014 " + matterName;

      var systemBase = "You are a senior litigation counsel constructing a comprehensive chronology for \"" + matterName + "\" in " + jur + ".\n" + matterContext;
      /* v5.20 (Chronology shaping, engine half). Anchor + consolidation are
         applied at SYNTHESIS only; extraction stays exhaustive. Both are inert
         when their parameters are absent, so a run with no anchor and consolidate
         not true yields a synthesis prompt identical to pre-v5.20. The shared
         condense stage and the resume/sleep path are untouched. Relevance beats
         consolidation: an anchored event is kept even if otherwise trimmed. */
      var anchorText = (typeof p.chronologyAnchorText === "string") ? p.chronologyAnchorText.trim() : "";
      var anchorLabel = (typeof p.chronologyAnchorLabel === "string" && p.chronologyAnchorLabel.trim()) ? p.chronologyAnchorLabel.trim() : "the selected anchor";
      var consolidate = p.chronologyConsolidate === true;
      var anchorBlock = anchorText
        ? "RELEVANCE ANCHOR \u2014 build this chronology to be relevant to the anchor below. Include every event that bears on it. Where you are uncertain whether an event is relevant, INCLUDE it: for a chronology that may go before a court, over-inclusion is safer than omission. There is no length limit and no fixed number of entries; length should follow from relevance to this anchor.\n\nANCHOR (" + anchorLabel + "):\n" + anchorText + "\n\n"
        : "";
      var consolidateBlock = consolidate
        ? "CONSOLIDATE for usability without losing substance: merge near-duplicate events into a single entry; group a run of closely-related dates into one line where that aids readability; omit purely trivial procedural entries UNLESS they bear on the anchor. Never silently drop a substantive event, and always keep the full source references (document, page, paragraph) on every entry, including consolidated ones. Where an event bears on the anchor, keep it even if it would otherwise be trimmed as routine.\n\n"
        : "";
      var relevanceLine = anchorText ? "*Relevant to: " + anchorLabel + "*\n\n" : "";
      var r = await runBatchedChained(jobId, job, systemBase,
        function(batchText, batchNum, total) { return "Extract EVERY date and event from batch " + batchNum + " of " + total + ". Be exhaustive.\n\n**[DATE]** \u2014 [Event] *(Source: [document], p.[page number] \u00b6[paragraph])* \n\nInclude page and paragraph references where available. Flag conflicts: **[DATE] (DISPUTED)**\n\n" + focusBlock + "DOCUMENTS:\n\n" + batchText + pageIndex; },
        function(combined, numBatches) { return numBatches ? "Synthesise chronology from " + numBatches + " batches into a single de-duplicated chronology sorted by date.\n\n" + anchorBlock + consolidateBlock + "## " + entityTitle + "\n\n" + relevanceLine + "**[DATE]** \u2014 [Event] *(Source: [document], p.[page] \u00b6[paragraph])*\n\nGroup by year. Where sources conflict on a date or on a material fact, flag the conflict and attribute each version to its source rather than choosing between them silently. Include page and paragraph references.\n\n## Key Dates Summary\nThe 10-15 most significant dates.\n\n## Gaps and Contradictions\nState here, with source references: (a) any document, exhibit, agreement, letter or event referred to or relied upon in the materials but not itself produced in them \u2014 marked as referred to but not produced; and (b) any material contradiction between sources, with each version attributed to its source. If none are identified, state \"None identified.\"\n\n" + focusBlock + "EXTRACTS:\n\n" + combined : "Construct a complete chronology. Be exhaustive.\n\n" + anchorBlock + consolidateBlock + "## " + entityTitle + "\n\n" + relevanceLine + "**[DATE]** \u2014 [Event] *(Source: [document], p.[page] \u00b6[paragraph])*\n\nAll date formats. Where sources conflict on a date or on a material fact, flag the conflict and attribute each version to its source rather than choosing between them silently. Include page and paragraph references where available.\n\n## Key Dates Summary\n\n## Gaps and Contradictions\nState here, with source references: (a) any document, exhibit, agreement, letter or event referred to or relied upon in the materials but not itself produced in them \u2014 marked as referred to but not produced; and (b) any material contradiction between sources, with each version attributed to its source. If none are identified, state \"None identified.\"\n\n" + focusBlock + "DOCUMENTS:\n\n" + combined + pageIndex; },
        byDoc, hostUrl
      );
      if (r === null) return res.status(200).json({ ok: true, status: "continuing" });
      result = r.text; inputTokens = r.inputTokens; outputTokens = r.outputTokens; cost = r.cost;
    }

    /* ── DRAMATIS PERSONAE ─────────────────────────────────────────────── */
    else if (tool === "persons") {
      var chunks = applyDocFilters(await getAllChunks(matterId), excludeDocNames, includeDocNames);
      var byDoc = chunksToDocMap(chunks);
      var pageIndex = buildPageIndex(byDoc);
      var systemBase = "You are a senior litigation counsel compiling a dramatis personae for \"" + matterName + "\" in " + jur + ".\n" + matterContext;
      var r = await runBatchedChained(jobId, job, systemBase,
        function(batchText, batchNum, total) { return "Extract EVERY person and entity from batch " + batchNum + " of " + total + ".\n\nEXCLUDE: Do NOT include attorneys, counsel, solicitors, barristers or legal representatives acting in the proceedings. Do NOT include the Judge, Master, Registrar, or Justices of Appeal.\n\nFor each person or entity:\n### [Name]\n**Description:** [A concise description of who this person/entity is and their relevance to the proceedings]\n**References in pleadings/petitions:** [List each reference with document name, page and paragraph]\n**References in affidavits:** [List each reference with document name, page and paragraph]\n**References in other documents:** [List each reference with document name, page and paragraph]\n\n" + (instructions ? "Focus: " + instructions + "\n\n" : "") + "DOCUMENTS:\n\n" + batchText + pageIndex; },
        function(combined, numBatches) { return numBatches ? "Synthesise persons from " + numBatches + " batches. Merge entries for the same person/entity. Sort alphabetically.\n\n## Dramatis Personae \u2014 " + matterName + "\n\nEXCLUDE: Do NOT include attorneys, counsel, solicitors, barristers or legal representatives acting in the proceedings. Do NOT include the Judge, Master, Registrar, or Justices of Appeal.\n\nFor each person or entity:\n### [Full Name]\n**Description:** [Concise description of who they are and their relevance]\n**References in pleadings/petitions:** [document, page, paragraph \u2014 listed first]\n**References in affidavits:** [document, page, paragraph \u2014 listed second]\n**References in other documents:** [document, page, paragraph \u2014 listed third]\n\n" + (instructions ? "Focus: " + instructions + "\n\n" : "") + "EXTRACTS:\n\n" + combined : "Compile a complete dramatis personae. Include EVERY person and entity.\n\n## Dramatis Personae \u2014 " + matterName + "\n\nEXCLUDE: Do NOT include attorneys, counsel, solicitors, barristers or legal representatives acting in the proceedings. Do NOT include the Judge, Master, Registrar, or Justices of Appeal.\n\nFor each person or entity:\n### [Full Name]\n**Description:** [Concise description of who they are and their relevance to the proceedings]\n**References in pleadings/petitions:** [document, page, paragraph \u2014 listed first]\n**References in affidavits:** [document, page, paragraph \u2014 listed second]\n**References in other documents:** [document, page, paragraph \u2014 listed third]\n\nSort alphabetically.\n\n" + (instructions ? "Focus: " + instructions + "\n\n" : "") + "DOCUMENTS:\n\n" + combined + pageIndex; },
        byDoc, hostUrl
      );
      if (r === null) return res.status(200).json({ ok: true, status: "continuing" });
      result = r.text; inputTokens = r.inputTokens; outputTokens = r.outputTokens; cost = r.cost;
    }

    /* ── ISSUE TRACKER ─────────────────────────────────────────────────── */
    else if (tool === "issues") {
      var chunks = applyDocFilters(await getAllChunks(matterId), excludeDocNames, includeDocNames);
      var byDoc = chunksToDocMap(chunks);
      var pageIndex = buildPageIndex(byDoc);
      var systemBase = "You are a senior litigation counsel in " + jur + " mapping issues for \"" + matterName + "\".\n" + matterContext;
      var r = await runBatchedChained(jobId, job, systemBase,
        function(batchText, batchNum, total) { return "Identify every legal and factual issue from batch " + batchNum + " of " + total + ".\n\n### Issue: [description]\n**Type:** Legal / Factual / Mixed\n**Evidence for Claimant:** [documents, passages, page and paragraph references]\n**Evidence for Defendant:** [documents, passages, page and paragraph references]\n\n" + focusBlock + "DOCUMENTS:\n\n" + batchText + pageIndex; },
        function(combined, numBatches) { return numBatches ? "Synthesise issues from " + numBatches + " batches. Merge duplicates.\n\n## Issue Tracker \u2014 " + matterName + "\n\n### Issue [N]: [description]\n**Type:** Legal / Factual / Mixed\n**Raised by:** [party]\n**Evidence for Claimant:** [documents, passages, page and paragraph references]\n**Evidence for Defendant:** [documents, passages, page and paragraph references]\n**Assessment:** [preliminary view]\n\n## Overall Assessment\n\n" + focusBlock + "FINDINGS:\n\n" + combined : "Produce a complete issue tracker.\n\n## Issue Tracker \u2014 " + matterName + "\n\n### Issue [N]: [description]\n**Type:** Legal / Factual / Mixed\n**Raised by:** [party]\n**Evidence for Claimant:** [documents, passages, page and paragraph references]\n**Evidence for Defendant:** [documents, passages, page and paragraph references]\n**Assessment:** [preliminary view]\n\n## Overall Assessment\n\n" + focusBlock + "DOCUMENTS:\n\n" + combined + pageIndex; },
        byDoc, hostUrl
      );
      if (r === null) return res.status(200).json({ ok: true, status: "continuing" });
      result = r.text; inputTokens = r.inputTokens; outputTokens = r.outputTokens; cost = r.cost;
    }

    /* ── CITATION CHECKER ──────────────────────────────────────────────── */
    else if (tool === "citations") {
      var allChunks = applyDocFilters(await getAllChunks(matterId), excludeDocNames, includeDocNames);
      var skeletonChunks, caselawChunks;
      if (p.citationSource) {
        skeletonChunks = allChunks.filter(function(c) { return c.document_name === p.citationSource; });
      } else {
        skeletonChunks = allChunks.filter(function(c) { return c.doc_type === "Skeleton Argument" || c.doc_type === "Pleading"; });
      }
      if (p.citationTargets && p.citationTargets.length > 0) {
        caselawChunks = allChunks.filter(function(c) { return p.citationTargets.indexOf(c.document_name) !== -1; });
      } else {
        caselawChunks = allChunks.filter(function(c) { return c.doc_type === "Case Law"; });
      }
      var skeletonText = docsToText(chunksToDocMap(skeletonChunks)) || "None uploaded";
      var caselawText = docsToText(chunksToDocMap(caselawChunks)) || "No case law uploaded";

      await updateJob(jobId, { batches_total: 1, batches_done: 0, status: "running", started_at: job.started_at || new Date().toISOString() });

      var r = await runTool(
        "You are a senior litigation counsel in " + jur + " checking citations for \"" + matterName + "\".\n" + matterContext,
        "Check every citation in the source document against the target case law.\n\n## Citation Check \u2014 " + matterName + "\n\n### [Case name]\n**Cited for:** [proposition]\n**Found in uploads:** Yes / No / Partial\n**Accuracy:** [does the judgment support the proposition?]\n**Flag:** \u2713 Accurate / \u26A0\uFE0F Overstated / \u2717 Incorrect / ? Not uploaded\n**Notes:** [any concern]\n\nSOURCE DOCUMENT:\n\n" + skeletonText + "\n\nTARGET CASE LAW:\n\n" + caselawText
      );
      result = r.text; inputTokens = r.inputTokens; outputTokens = r.outputTokens; cost = r.cost;
    }

    /* ── BRIEFING NOTE ─────────────────────────────────────────────────── */
    /* v4.5c: Synth prompt rewritten. Previous prompt produced silent truncation
       on large matters — the model would write a long section 4 and run out of
       output budget before reaching sections 5, 6, 7. Two fixes:
       (a) Explicit completion mandate at the top of the prompt: all 7 sections
           are required, abbreviate later sections rather than omitting them.
       (b) Per-section paragraph guidance to keep total output bounded.
       The system message also gains a short reminder. The extraction prompt is
       unchanged. */
    else if (tool === "briefing") {
      var chunks = applyDocFilters(await getAllChunks(matterId), excludeDocNames, includeDocNames);
      var byDoc = chunksToDocMap(chunks);
      var pageIndex = buildPageIndex(byDoc);
      var systemBase = "You are a senior litigation counsel in " + jur + " producing a briefing note for \"" + matterName + "\".\n" + matterContext + "\n\nIMPORTANT: When producing a briefing note you MUST complete all seven sections in full. Do not stop after section 4 or 5. If you find yourself running short on output budget, abbreviate the later sections rather than omitting them — every section must have at least a short paragraph.";
      var briefingDate = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
      var briefingHeader = "## Briefing Note \u2014 " + matterName + "\n**Jurisdiction:** " + jur + "\n**Date:** " + briefingDate + "\n\n";
      var completionMandate = "CRITICAL INSTRUCTIONS:\n1. You MUST complete ALL SEVEN sections below. The briefing note is incomplete if any section is missing.\n2. Aim for 2-4 paragraphs per section. Section 4 (Case on Disputed Matters) may be longer because it covers multiple issues, but each issue should be limited to 3-5 short paragraphs (Petitioner's case, GP's case, brief assessment).\n3. If you are running short on output budget as you write, ABBREVIATE the remaining sections rather than omitting them. A one-paragraph section 7 is acceptable; a missing section 7 is not.\n4. Do not repeat the same fact across sections. Cross-reference earlier sections instead.\n5. The reader is a senior lawyer who will read the entire document. Be concise.\n\n";
      var sectionHeaders = "## 1. Summary of the Proceedings\nBrief overview of the nature and status of the proceedings (2-3 paragraphs).\n\n## 2. The Issues\nList each issue that arises in the proceedings \u2014 both legal and factual. Reference the pleadings or other documents where each issue is raised. Use a numbered list; do not write extended prose for each issue here \u2014 detailed analysis belongs in section 4.\n\n## 3. Common Ground and Admissions\nList all facts, matters, or legal points that are admitted or agreed between the parties. Distinguish formal admissions from matters that appear to be common ground. A bullet list is appropriate.\n\n## 4. The Case on Disputed Matters\nFor each disputed issue identified in section 2, set out:\n- The case for the " + (actingFor || "client") + ": evidence and arguments supporting the position (2-3 short paragraphs)\n- The opposing case: evidence and arguments the other side relies on (2-3 short paragraphs)\n- Assessment: preliminary view on the strength of each side's position (1-2 paragraphs)\n\n## 5. Key Evidence\nSummary of the most important evidence with page and paragraph references where available (2-4 paragraphs).\n\n## 6. Procedural Position and Next Steps\nCurrent procedural stage, upcoming deadlines, and recommended next steps (2-3 paragraphs).\n\n## 7. Key Risks\nSignificant risks to be aware of (2-3 paragraphs or a short bullet list).\n\nREMEMBER: All seven sections are required. Do not stop early.\n\n";
      var briefingFocus = instructions ? "Focus: " + instructions + "\n\n" : "";
      var r = await runBatchedChained(jobId, job, systemBase,
        function(batchText, batchNum, total) { return "Extract key facts, legal issues, evidence, admissions, common ground, and procedural information from batch " + batchNum + " of " + total + " for a briefing note.\n\nPay particular attention to:\n- What issues are raised in the proceedings\n- What facts or matters are admitted or agreed (common ground)\n- What facts or matters are in dispute and what evidence supports each side\n\nDOCUMENTS:\n\n" + batchText + pageIndex; },
        function(combined, numBatches) {
          if (numBatches) {
            return "Using findings from " + numBatches + " batches, produce a complete briefing note.\n\n" + briefingHeader + completionMandate + sectionHeaders + briefingFocus + "FINDINGS:\n\n" + combined;
          }
          return "Produce a structured briefing note.\n\n" + briefingHeader + completionMandate + sectionHeaders + briefingFocus + "DOCUMENTS:\n\n" + combined + pageIndex;
        },
        byDoc, hostUrl,
        { sectioned: true, toolName: "briefing", instructions: instructions, actingFor: actingFor, matterName: matterName, headerText: briefingHeader }
      );
      if (r === null) return res.status(200).json({ ok: true, status: "continuing" });
      result = r.text; inputTokens = r.inputTokens; outputTokens = r.outputTokens; cost = r.cost;

      /* v5.10e: prepend a "Run parameters" block recording what was specified
         at launch. Worker-built (not model-built) so the values are exactly
         what was sent. Block only appears when at least one parameter was
         set; if neither, output is byte-identical to v5.10d. Applies to
         launch only — follow-ups are unaffected because they go through a
         different code path. */
      var runParamsLines = [];
      if (instructions && String(instructions).trim()) {
        runParamsLines.push("**Additional instructions:** " + String(instructions).trim());
      }
      if (Array.isArray(includeDocNames) && includeDocNames.length > 0) {
        runParamsLines.push("**Restricted to:** " + includeDocNames.join(", "));
      }
      if (runParamsLines.length > 0) {
        result = runParamsLines.join("\n") + "\n\n" + result;
      }
    }

    /* ── DRAFT GENERATOR ───────────────────────────────────────────────── */
    else if (tool === "draft") {
      /* Draft has special logic: library context, precedents, learning from past drafts */
      var libraryContext = p.libraryContext || null;
      var caseTypeId = p.caseTypeId || null;
      var docTypeId = p.docTypeId || null;
      var subcatId = p.subcatId || null;
      var libraryText = "";

      var allPrecedentIds = [];
      if (libraryContext && libraryContext.selectedPrecedentIds) {
        allPrecedentIds = libraryContext.selectedPrecedentIds.slice();
      }

      if (caseTypeId && allPrecedentIds.length === 0) {
        var autoQuery = supabase.from("precedent_docs").select("id").eq("user_id", userId).eq("case_type_id", caseTypeId);
        if (docTypeId) autoQuery = autoQuery.eq("doc_type_id", docTypeId);
        var autoResp = await autoQuery.limit(5);
        if (autoResp.data) allPrecedentIds = autoResp.data.map(function(pp) { return pp.id; });
      }

      if (allPrecedentIds.length > 0) {
        var ownTexts = [];
        var thirdTexts = [];
        for (var pi = 0; pi < allPrecedentIds.length; pi++) {
          var docId = allPrecedentIds[pi];
          var pChunksResp = await supabase.from("precedent_chunks").select("content, chunk_index").eq("precedent_doc_id", docId).order("chunk_index").limit(80);
          var precMetaResp = await supabase.from("precedent_docs").select("name, context_relationship, context_doc_id, ai_instructions, is_own_style, commentary").eq("id", docId).single();
          var pChunks = pChunksResp.data;
          var precMeta = precMetaResp.data;
          if (pChunks && pChunks.length > 0) {
            var label = precMeta ? precMeta.name : docId;
            var precEntry = "=== PRECEDENT: " + label + " ===\n";
            if (precMeta && precMeta.ai_instructions) precEntry += "[Author instructions: " + precMeta.ai_instructions + "]\n\n";
            if (precMeta && precMeta.commentary) precEntry += "[Commentary \u2014 read carefully and apply: " + precMeta.commentary + "]\n\n";
            precEntry += pChunks.map(function(c) { return c.content; }).join("\n\n");
            if (precMeta && precMeta.context_doc_id) {
              var ctxResp = await supabase.from("precedent_chunks").select("content, chunk_index").eq("precedent_doc_id", precMeta.context_doc_id).order("chunk_index").limit(40);
              if (ctxResp.data && ctxResp.data.length > 0) {
                var rel = precMeta.context_relationship || "relates to";
                precEntry += "\n\n--- CONTEXT: this precedent " + rel + " the following ---\n" + ctxResp.data.map(function(c) { return c.content; }).join("\n\n");
              }
            }
            if (precMeta && precMeta.is_own_style) ownTexts.push(precEntry);
            else thirdTexts.push(precEntry);
          }
        }
        var precTexts = [];
        if (ownTexts.length > 0) precTexts.push("### MY DRAFTING STYLE\nStudy these documents carefully. Learn and replicate: the document structure, heading hierarchy, argument sequence, paragraph style, tone, and language. Your draft must follow this style closely:\n\n" + ownTexts.join("\n\n"));
        if (thirdTexts.length > 0) precTexts.push("### THIRD PARTY PRECEDENTS\nUse these as benchmarks for structure, legal argument, and completeness. Adapt their approach to our client's position:\n\n" + thirdTexts.join("\n\n"));
        if (precTexts.length > 0) {
          var ctLabel = [libraryContext && libraryContext.caseTypeName, libraryContext && libraryContext.subcategoryName, libraryContext && libraryContext.docTypeName].filter(Boolean).join(" \u2014 ") || "Auto-matched";
          libraryText = "\n\n# PRECEDENT LIBRARY (" + ctLabel + ")\n\nYou MUST study these precedents before drafting. Learn from their structure, standard sections, argument methods, and language. Apply what you learn to the current draft.\n\n" + precTexts.join("\n\n---\n\n");
        }
      }

      if (libraryContext && libraryContext.selectedSections && libraryContext.selectedSections.length > 0) {
        var secText = libraryContext.selectedSections.map(function(s) { return "=== STANDARD SECTION: " + s.title + " ===\n" + s.content; }).join("\n\n");
        libraryText += "\n\n## STANDARD SECTIONS TO INCORPORATE\n\nIncorporate these sections with only minor contextual adaptation:\n\n" + secText;
      }

      /* v5.59 Push C: case law and texts. Wrapped so any failure — a missing
         search function, a slow query, a malformed context — leaves the
         draft behaving exactly as it did in v5.58. */
      var caseLawText = "";
      try {
        if (p.caseLawContext) {
          var clQuery = [p.matterIssues, p.matterNature, instructions].filter(Boolean).join(" ");
          caseLawText = await buildCaseLawContext(supabase, userId, matterId, p.caseLawContext, clQuery);
          console.log("[draft] case law context: " + caseLawText.length + " chars");
        }
      } catch (e) { console.log("[draft] case law context skipped:", e.message); }

      var learningText = "";
      try {
        var pastResp = await supabase.from("conversation_history").select("question, answer, created_at").eq("matter_id", matterId).eq("user_id", userId).eq("tool_name", "draft").order("created_at", { ascending: false }).limit(3);
        if (pastResp.data && pastResp.data.length > 0) {
          var pastSummaries = pastResp.data.map(function(d) { return "--- Previous draft (" + new Date(d.created_at).toLocaleDateString("en-GB") + ") ---\nInstructions: " + d.question.slice(0, 200) + "\nDraft excerpt: " + d.answer.slice(0, 800) + "..."; }).join("\n\n");
          learningText = "\n\n# PREVIOUS DRAFTS FOR THIS MATTER\n\nLearn from these earlier drafts \u2014 maintain consistency in style, terminology, and argument structure:\n\n" + pastSummaries;
        }
      } catch (e) { console.log("Past drafts fetch skipped:", e.message); }

      /* v5.11a (Draft Build 1): tool-history context. The frontend has
         already truncated each answer; we just format. No DB call needed
         here — the data arrives in the job parameters. */
      var toolHistoryText = "";
      if (matterToolHistory.length > 0) {
        var TOOL_LABELS = { briefing: "Briefing Note", issues: "Issues", chronology: "Chronology", dramatis: "Dramatis Personae", citations: "Citations Check", inconsistency: "Inconsistency Tracker", proposition: "Proposition Tracker", issueBriefing: "Issue Briefing" };
        var historyEntries = matterToolHistory.map(function(h) {
          var label = TOOL_LABELS[h.tool_name] || h.tool_name;
          return "--- " + label + " ---\n" + (h.answer || "");
        }).join("\n\n");
        toolHistoryText = "\n\n# WHAT WE ALREADY KNOW ABOUT THIS MATTER\n\nThe following are the most recent analysis-tool outputs from this matter. They summarise the case as it stands. Use them to orient yourself before reading the source documents below \u2014 facts, parties, issues, procedural posture, and known evidence are already laid out here. Do not contradict them unless the source documents below clearly require it.\n\n" + historyEntries;
      }

      /* v5.11a (Draft Build 1): record the comparable-document hunt flag.
         The hunt itself is built in a later push; for now we just log. */
      console.log("[draft] learnFromComparable =", learnFromComparable);

      /* v5.13a (Draft Build 3): structural-precedent hunt across all of
         the user's matters. Gated by learnFromComparable. Wrapped in
         outer try/catch so any failure path leaves the draft behaviour
         identical to v5.12b. Per-candidate try/catch inside ensures one
         bad doc doesn't kill the hunt. 45-second wall-clock budget on
         classifier calls so cache misses can't blow the Vercel timeout.
         The cache in document_classifications means second-and-later
         drafts of the same doc-type return classifications in ms. */
      var comparableText = "";
      if (learnFromComparable && docTypeId) {
        try {
          /* Resolve the target type name. Prefer the name already on the
             job (no DB call). Fall back to a single SELECT only if the
             frontend didn't send one. */
          var targetTypeName = (libraryContext && libraryContext.docTypeName) || null;
          if (!targetTypeName) {
            var dtResp = await supabase.from("doc_types").select("name").eq("id", docTypeId).single();
            if (dtResp.data && dtResp.data.name) targetTypeName = dtResp.data.name;
          }

          if (targetTypeName) {
            /* Pull all fingerprints belonging to this user's matters.
               JOIN through matters for owner_id since fingerprints have
               no owner_id of their own. is_relevant=true and failed=false
               are mandatory filters per the locked design. */
            var fpResp = await supabase
              .from("document_fingerprints")
              .select("document_id, likely_types, matters!inner(owner_id), documents!inner(name)")
              .eq("matters.owner_id", userId)
              .eq("is_relevant", true)
              .eq("failed", false);

            var fpRows = (fpResp.data || []);

            /* Two-pass type filter: exact match first, substring fallback. */
            var targetLower = targetTypeName.toLowerCase();
            var exactMatches = [];
            var substringMatches = [];
            for (var fpi = 0; fpi < fpRows.length; fpi++) {
              var row = fpRows[fpi];
              var lt = Array.isArray(row.likely_types) ? row.likely_types : [];
              var docName = (row.documents && row.documents.name) || "";
              /* Honour excludeDocNames — never draw structural precedent
                 from a document the user excluded for this draft. */
              if (excludeDocNames.indexOf(docName) !== -1) continue;
              var hitExact = false;
              var hitSubstring = false;
              for (var lti = 0; lti < lt.length; lti++) {
                var ltLower = (lt[lti] || "").toLowerCase();
                if (ltLower === targetLower) { hitExact = true; break; }
                if (ltLower.indexOf(targetLower) !== -1 || targetLower.indexOf(ltLower) !== -1) hitSubstring = true;
              }
              if (hitExact) exactMatches.push(row);
              else if (hitSubstring) substringMatches.push(row);
            }

            var candidates = exactMatches.concat(substringMatches).slice(0, 5);
            console.log("[draft] comparable hunt: " + exactMatches.length + " exact, " + substringMatches.length + " substring, using top " + candidates.length);

            /* Classify each candidate. 45s wall-clock budget. Per-call
               try/catch. Cache hits return in ms. */
            var huntDeadline = Date.now() + 45000;
            var summaries = [];
            for (var ci = 0; ci < candidates.length; ci++) {
              if (Date.now() > huntDeadline) {
                console.log("[draft] comparable hunt: 45s budget reached, stopping at " + summaries.length);
                break;
              }
              try {
                var rows = await classifyDocumentForType(supabase, anthropic, candidates[ci].document_id, targetTypeName);
                /* A bundle returns multiple rows; pick the one whose
                   classification matches our target (exact or substring),
                   or take the first if nothing matches. */
                var picked = null;
                for (var ri = 0; ri < rows.length; ri++) {
                  var cls = (rows[ri].classification || "").toLowerCase();
                  if (cls === targetLower) { picked = rows[ri]; break; }
                }
                if (!picked) {
                  for (var ri2 = 0; ri2 < rows.length; ri2++) {
                    var cls2 = (rows[ri2].classification || "").toLowerCase();
                    if (cls2.indexOf(targetLower) !== -1 || targetLower.indexOf(cls2) !== -1) { picked = rows[ri2]; break; }
                  }
                }
                if (!picked && rows.length > 0) picked = rows[0];
                if (picked && picked.structural_summary) {
                  summaries.push("--- " + (picked.classification || targetTypeName) + " (from another matter) ---\n" + picked.structural_summary);
                }
              } catch (clsErr) {
                console.log("[draft] classifier failed for doc " + candidates[ci].document_id + ":", clsErr.message);
              }
            }

            if (summaries.length > 0) {
              comparableText = "\n\n# STRUCTURAL PRECEDENTS FROM YOUR OWN MATTERS\n\nThe following are structural summaries of similar documents you have drafted or worked on in other matters. Study their structure, heading hierarchy, section ordering, and argument flow. Apply what you learn — but do NOT copy their facts; the facts of this matter are different.\n\n" + summaries.join("\n\n");
            } else {
              comparableText = "\n\n# STRUCTURAL PRECEDENTS FROM YOUR OWN MATTERS\n\n_No comparable precedents found in your other matters._";
            }
          }
        } catch (huntErr) {
          console.log("[draft] comparable hunt failed:", huntErr.message);
          comparableText = "";
        }
      }

      var chunks = applyDocFilters(await getAllChunks(matterId), excludeDocNames, includeDocNames);
      var byDoc = chunksToDocMap(chunks);

      var headingInstruction = heading && (heading.court || heading.party1)
        ? "\n\nIMPORTANT: Begin the document with this exact court heading (do not alter the heading itself):\n\n" + headingText + "\n\nThen continue with the body of the document."
        : "";

      var systemBase = "You are a senior litigation counsel in " + jur + " drafting a legal document for \"" + matterName + "\". Apply " + jur + " law, procedure, and drafting conventions." + (actingFor ? " You are acting for the " + actingFor + "." : "") + "\n\nCRITICAL INSTRUCTIONS:\n1. If precedent documents are provided below, you MUST study them first. Learn their structure, standard sections, argument methods, heading hierarchy, and language style. Replicate this approach in your draft.\n2. If commentary or AI instructions are attached to a precedent, follow them precisely \u2014 they contain the author\u2019s specific guidance on how to use that document.\n3. If previous drafts for this matter exist, maintain consistency with their style, terminology, and argument structure.\n4. If case law or textbook extracts are provided below, cite any authority you rely on by name and citation, and do not reproduce the extracts at length.\n5. Apply " + jur + " court rules and conventions throughout.\n\n" + matterContext + toolHistoryText + libraryText + caseLawText + comparableText + learningText + headingInstruction;

      var r = await runBatchedChained(jobId, job, systemBase,
        function(batchText, batchNum, total) { return "Extract all facts, legal points, and arguments from batch " + batchNum + " of " + total + " relevant to: " + (instructions || "Draft a skeleton argument") + "\n\nDOCUMENTS:\n\n" + batchText; },
        function(combined, numBatches) { return numBatches ? "Using source material from " + numBatches + " batches, produce:\n\n" + (instructions || "Draft a skeleton argument.") + "\n\nApply " + jur + " court rules and conventions.\n\nSOURCE MATERIAL:\n\n" + combined : (instructions || "Draft a skeleton argument based on the matter documents.") + "\n\nApply " + jur + " court rules and conventions.\n\nDOCUMENTS:\n\n" + combined; },
        byDoc, hostUrl,
        { sectioned: true, toolName: "draft", instructions: instructions, actingFor: actingFor, matterName: matterName, headerText: headingText || "" }
      );
      if (r === null) return res.status(200).json({ ok: true, status: "continuing" });
      result = r.text; inputTokens = r.inputTokens; outputTokens = r.outputTokens; cost = r.cost;
    }

    /* ── ISSUE BRIEFING (detailed analysis of selected issues) ─────────── */
    else if (tool === "issueBriefing") {
      var selectedIssues = p.selectedIssues || [];
      var issuesText = p.issuesText || "";
      if (selectedIssues.length === 0 && !instructions) {
        await failJob(jobId, "No issues selected for briefing");
        return res.status(200).json({ ok: false, error: "No issues selected" });
      }

      var chunks = applyDocFilters(await getAllChunks(matterId), excludeDocNames, includeDocNames);
      var byDoc = chunksToDocMap(chunks);
      var pageIndex = buildPageIndex(byDoc);

      var issuesList = selectedIssues.length > 0
        ? selectedIssues.map(function(iss, idx) { return (idx + 1) + ". " + iss; }).join("\n")
        : instructions;

      var systemBase = "You are a senior litigation counsel in " + jur + " producing a detailed issue briefing for \"" + matterName + "\"." + (actingFor ? " You are acting for the " + actingFor + "." : "") + "\n" + matterContext
        + "\n\nYou have been asked to produce a detailed briefing on specific issues from the matter. For each issue you MUST:\n"
        + "1. Provide a detailed commentary on the issue — what it involves, why it matters, and how it arises in the proceedings.\n"
        + "2. Cite specific document references in the format: [Document Name, p.X \u00b6Y] for every factual assertion.\n"
        + "3. Set out the STRENGTHS of the " + (actingFor || "client") + "'s position on this issue, with document references.\n"
        + "4. Set out the WEAKNESSES of the " + (actingFor || "client") + "'s position on this issue, with document references.\n"
        + "5. Set out the STRENGTHS of the opposing party's position, with document references.\n"
        + "6. Set out the WEAKNESSES of the opposing party's position, with document references.\n"
        + "7. Provide a preliminary assessment of the likely outcome on this issue.\n"
        + "\nIMPORTANT: Every factual claim must be supported by a reference to a specific document, page, and paragraph where available. Use the format [Document Name, p.X \u00b6Y]. Do not make assertions without references.";

      if (issuesText) {
        systemBase += "\n\nPREVIOUS ISSUE TRACKER OUTPUT (for context — the user has selected specific issues from this list):\n" + issuesText.slice(0, 15000);
      }

      var r = await runBatchedChained(jobId, job, systemBase,
        function(batchText, batchNum, total) {
          return "Extract ALL evidence relevant to the following issues from batch " + batchNum + " of " + total + ". For each piece of evidence, note:\n- Which issue it relates to\n- Whether it supports or undermines each party's position\n- The exact document reference [Document Name, p.X \u00b6Y]\n\nISSUES TO ANALYSE:\n" + issuesList + "\n\nDOCUMENTS:\n\n" + batchText + pageIndex;
        },
        function(combined, numBatches) {
          var header = "## Detailed Issue Briefing \u2014 " + matterName + "\n**Jurisdiction:** " + jur + "\n**Date:** " + new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) + (actingFor ? "\n**Acting for:** " + actingFor : "") + "\n\n";
          var format = "For EACH of the following issues, produce a detailed briefing with these sections:\n\n"
            + "### Issue [N]: [Issue description]\n\n"
            + "#### Commentary\n[Detailed discussion of the issue — what it involves, why it matters, how it arises. Cite document references throughout.]\n\n"
            + "#### " + (actingFor || "Client") + "'s Position\n**Strengths:**\n[Each strength with document references in the format [Document Name, p.X \u00b6Y]]\n\n"
            + "**Weaknesses:**\n[Each weakness with document references]\n\n"
            + "#### Opposing Party's Position\n**Strengths:**\n[Each strength with document references]\n\n"
            + "**Weaknesses:**\n[Each weakness with document references]\n\n"
            + "#### Assessment\n[Preliminary view on the likely outcome, with reasoning]\n\n---\n\n"
            + "After all issues:\n\n## Overall Assessment\n[Summary view across all issues]\n\n";

          if (numBatches) {
            return header + format + "ISSUES TO ANALYSE:\n" + issuesList + "\n\nEVIDENCE FROM " + numBatches + " BATCHES:\n\n" + combined;
          }
          return header + format + "ISSUES TO ANALYSE:\n" + issuesList + "\n\nDOCUMENTS:\n\n" + combined + pageIndex;
        },
        byDoc, hostUrl
      );
      if (r === null) return res.status(200).json({ ok: true, status: "continuing" });
      result = r.text; inputTokens = r.inputTokens; outputTokens = r.outputTokens; cost = r.cost;
    }

    else {
      await failJob(jobId, "Unknown tool: " + tool);
      return res.status(200).json({ ok: false, error: "Unknown tool" });
    }

    /* Prepend court heading to result if heading exists (except draft which handles it in prompt) */
    if (headingText && tool !== "draft") {
      result = headingText + "\n" + result;
    }

    /* Save result.
       v5.5: Idempotency guard. Multiple workers can reach this point in parallel
       if the cron-resume fired during a long synthesis call. Re-read the job
       status: if another worker already set it to "complete", skip the save
       so we don't create duplicate history rows.
       v5.9b: Also handle the case where a prematurely-fired synth_attempts
       watchdog has already written status="failed" with a stuck-error message,
       but the underlying synthesis call eventually returned a real result.
       In that case the success was real — clear the stale error and write
       completion legitimately rather than leaving a "failed" job that did
       in fact succeed. */
    var freshJob = await supabase.from("tool_jobs").select("status").eq("id", jobId).single();
    if (freshJob.data && freshJob.data.status === "complete") {
      console.log("v5.9b Worker: job " + jobId + " already complete — skipping duplicate save");
      return res.status(200).json({ ok: true, status: "already_done" });
    }
    if (freshJob.data && freshJob.data.status === "failed") {
      console.log("v5.9b Worker: job " + jobId + " was marked failed by watchdog but synthesis did succeed — clearing stale error and completing");
    }
    await logUsage(matterId, userId, tool, inputTokens, outputTokens, cost);
    await saveHistory(matterId, userId, (toolLabels[tool] || tool) + (instructions ? ": " + instructions : ""), result, tool);

    /* v5.17 Push C: server-side draft persistence. For draft jobs created
       by api/tools.js v5.17 or later, draftRowId points at a drafts row
       created at job-start. UPDATE that row with the final draft content
       BEFORE marking the tool_jobs row complete \u2014 if the drafts UPDATE
       fails, the catch block below fails the whole job rather than leaving
       a "complete" tool_jobs row with no corresponding drafts row.
       Backward-compatible: jobs without draftRowId (older jobs, or any
       non-draft tool) skip this entirely. */
    if (tool === "draft" && draftRowId) {
      var draftUpdate = await supabase.from("drafts")
        .update({
          draft_content: result,
          updated_at: new Date().toISOString(),
        })
        .eq("id", draftRowId)
        .select("id");
      if (draftUpdate.error) {
        console.error("v5.17 drafts row UPDATE failed for " + draftRowId + ":", draftUpdate.error.message);
        throw new Error("Drafts persistence failed: " + draftUpdate.error.message);
      }
      if (!draftUpdate.data || draftUpdate.data.length === 0) {
        console.error("v5.17 drafts row UPDATE returned no rows for " + draftRowId + " \u2014 row missing or RLS blocking");
        throw new Error("Drafts persistence returned no rows for " + draftRowId);
      }
      console.log("v5.17 drafts row " + draftRowId + " updated with " + result.length + " chars of draft_content");
    }

    await updateJob(jobId, {
      status: "complete",
      result: result,
      error: null,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: cost,
      completed_at: new Date().toISOString(),
    });
    console.log("Job complete: " + jobId + " (" + tool + ") " + inputTokens + "/" + outputTokens + " tokens, $" + cost.toFixed(4));
    return res.status(200).json({ ok: true, status: "complete" });

  } catch (err) {
    console.error("Worker error for job " + jobId + ":", err);
    try { await failJob(jobId, err.message || "Worker failed"); } catch (e) { /* nothing */ }
    return res.status(200).json({ ok: false, error: err.message });
  }
}

/* Tool label lookup for history saving */
var toolLabels = {
  proposition: "Proposition Evidence Finder",
  inconsistency: "Inconsistency Tracker",
  chronology: "Chronology",
  persons: "Dramatis Personae",
  issues: "Issue Tracker",
  issueBriefing: "Issue Briefing",
  citations: "Citation Checker",
  briefing: "Briefing Note",
  draft: "Draft",
};

/* v5.59 Push C: named exports for the case law retrieval helpers so
   api/__tests__/case_law_context.test.js can exercise them against a stub
   client. The default export — the Vercel handler — is unchanged. */
export { buildCaseLawContext, caseLawKeywords, caseLawJoinChunks, caseLawHeading };
