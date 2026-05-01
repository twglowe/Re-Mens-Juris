/* EX LIBRIS JURIS v5.12a — document-classifier.js
   Layer 2: deeper structural classifier. EXISTS BUT DORMANT IN v5.12a.
   This file is shipped now so the schema is locked and Build 3 only has to
   wire it into worker.js's draft branch. Build 3 will:
     1. Import classifyDocumentForType from this file inside worker.js's
        draft branch.
     2. After the existing precedent-library load, query
        document_fingerprints for candidates matching the doc type being
        drafted (fingerprints are eager so this is cheap).
     3. For each candidate (capped, e.g. top 5), call classifyDocumentForType
        to write/read a full structural summary in document_classifications.
     4. Feed those summaries into the draft prompt under a new precedent
        slot alongside the existing library precedents.

   Why it ships dormant:
     - Locking the schema and the function signature now means Build 3 is a
       pure additive worker.js change with no new file to debug at the same
       time.
     - The file is not imported by anything in v5.12a, so the dormant code
       is genuinely zero-risk: Vercel doesn't load it.

   What this file does NOT do in v5.12a:
     - It is not imported from worker.js.
     - It is not imported from fingerprint.js or index-library.js.
     - It writes nothing to the database when v5.12a is live.

   The implementation below is a working draft of the function shape Build 3
   will use, but Build 3 should expect to re-read and tune it. The prompt
   in particular will likely change as Tom sees real classifications.
   v5.12a: created (dormant). */

import Anthropic from "@anthropic-ai/sdk";

/* Same retry helper as fingerprint.js. Duplicated rather than shared
   because Build 0 (helper extraction into _workerlib.js) was deferred. */
function isRetryableAnthropicError(err) {
  if (!err) return false;
  if (err.status === 529 || err.status === 429) return true;
  var t1 = err.error && err.error.type;
  var t2 = err.error && err.error.error && err.error.error.type;
  if (t1 === "overloaded_error" || t1 === "rate_limit_error") return true;
  if (t2 === "overloaded_error" || t2 === "rate_limit_error") return true;
  var msg = (err.message || "") + "";
  if (msg.indexOf("overloaded_error") !== -1) return true;
  if (msg.indexOf("rate_limit_error") !== -1) return true;
  if (msg.indexOf("Overloaded") !== -1) return true;
  return false;
}

async function callSonnet(anthropic, system, userPrompt, maxTokens) {
  var BACKOFF_MS = [5000, 15000, 45000];
  var MAX_ATTEMPTS = BACKOFF_MS.length + 1;
  var attempt = 0;
  var lastErr = null;
  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    try {
      var stream = anthropic.messages.stream({
        model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
        max_tokens: maxTokens || 4000,
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
      return {
        text: text,
        inputTokens: (finalMessage.usage && finalMessage.usage.input_tokens) || 0,
        outputTokens: (finalMessage.usage && finalMessage.usage.output_tokens) || 0,
      };
    } catch (err) {
      lastErr = err;
      if (!isRetryableAnthropicError(err)) throw err;
      if (attempt >= MAX_ATTEMPTS) throw err;
      var waitMs = BACKOFF_MS[attempt - 1];
      console.log("v5.12a classifier: retryable error attempt " + attempt + ", waiting " + (waitMs / 1000) + "s");
      await new Promise(function(r) { setTimeout(r, waitMs); });
    }
  }
  throw lastErr || new Error("callSonnet exhausted retries");
}

function extractJson(text) {
  if (!text) return null;
  var stripped = text.trim();
  stripped = stripped.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  try {
    return JSON.parse(stripped);
  } catch (e) {
    var start = -1;
    for (var i = 0; i < stripped.length; i++) {
      if (stripped[i] === "{" || stripped[i] === "[") { start = i; break; }
    }
    var end = -1;
    for (var j = stripped.length - 1; j >= 0; j--) {
      if (stripped[j] === "}" || stripped[j] === "]") { end = j; break; }
    }
    if (start !== -1 && end !== -1 && end > start) {
      try { return JSON.parse(stripped.slice(start, end + 1)); } catch (e2) { return null; }
    }
    return null;
  }
}

/* The Build 3 classification prompt. Reads more of the document than the
   fingerprint did (up to 60,000 chars). Writes a structural summary that
   strips facts and keeps form. May produce multiple rows for a bundle. */
function buildClassifyPrompt(fileName, fullText, targetDocType) {
  var system = "You are a senior litigation counsel analysing legal documents to extract their structural form for use as a drafting template. You return JSON only, no markdown fences, no preamble.";
  var typeFocus = targetDocType
    ? "\n\nFOCUS: The user is drafting a " + targetDocType + ". Pay special attention to whether this document IS a " + targetDocType + " or contains one (in a bundle). If it is or contains one, your structural_summary should be detailed enough to use as a template. If it isn't, mark it as such and keep the summary brief.\n"
    : "";
  var user = "Read this legal document and produce structural classification(s) for it." + typeFocus + "\n\n" +
    "Return ONLY this JSON, no markdown fences:\n\n" +
    "[\n" +
    "  {\n" +
    "    \"classification\": \"Skeleton Argument\",\n" +
    "    \"page_start\": null,\n" +
    "    \"page_end\": null,\n" +
    "    \"structural_summary\": \"Detailed 100-300 word description of structure: sections, headings, length, argument flow, formatting conventions. Strip facts entirely — describe form only.\"\n" +
    "  }\n" +
    "]\n\n" +
    "Rules:\n" +
    "- Single document: array of one object with page_start and page_end null.\n" +
    "- Bundle: one object per constituent, with page_start/page_end set.\n" +
    "- structural_summary 100-300 words. STRUCTURE ONLY. Do NOT summarise\n" +
    "  the facts of the matter. The summary will be used as a template\n" +
    "  for drafting in OTHER matters where the facts are entirely different.\n" +
    "- Use established legal document names (Skeleton Argument, Defence,\n" +
    "  Particulars of Claim, Notice of Appeal, Witness Statement, Affidavit,\n" +
    "  Order, Judgment, Letter, Memorandum, Research Note, Bundle Index,\n" +
    "  Exhibit). If none fits, use a clear short descriptor.\n\n" +
    "DOCUMENT FILENAME: " + fileName + "\n\n" +
    "DOCUMENT CONTENT (may be truncated for large bundles):\n\n" + fullText;
  return { system: system, user: user };
}

/* Public API for Build 3.

   classifyDocumentForType(supabase, anthropic, documentId, targetDocType)
     - Looks up existing document_classifications rows for documentId.
     - If a row already exists for this targetDocType (or any classification
       row exists if targetDocType is null), returns the cached rows.
     - Otherwise loads the document chunks, makes a Sonnet call with the
       full text, parses the JSON, writes one or more rows.
     - Returns an array of {classification, page_start, page_end,
       structural_summary} suitable for prompt building.

   This function is intentionally side-effecting (it writes the rows) but
   idempotent on re-call — Build 3 should call it freely without worrying
   about duplicate inserts.

   v5.12a: this function exists but is NOT called from anywhere in the
   shipped code. Build 3 will wire it into worker.js. */
export async function classifyDocumentForType(supabase, anthropic, documentId, targetDocType) {
  var docResp = await supabase
    .from("documents")
    .select("id, matter_id, name")
    .eq("id", documentId)
    .single();
  if (docResp.error || !docResp.data) {
    throw new Error("Document not found: " + documentId);
  }
  var doc = docResp.data;

  /* Cached path */
  var existingResp = await supabase
    .from("document_classifications")
    .select("classification, page_start, page_end, structural_summary")
    .eq("document_id", documentId);
  if (existingResp.data && existingResp.data.length > 0) {
    return existingResp.data;
  }

  /* Load chunks. We pull more than fingerprint.js did — up to 60,000 chars
     of text — because the structural summary needs to see headings and
     argument flow, not just the cover. */
  var chunkResp = await supabase
    .from("chunks")
    .select("content, chunk_index")
    .eq("document_id", documentId)
    .order("chunk_index", { ascending: true })
    .limit(80);
  if (chunkResp.error) throw new Error("Chunk load failed: " + chunkResp.error.message);
  var chunks = chunkResp.data || [];
  var fullText = "";
  for (var i = 0; i < chunks.length && fullText.length < 60000; i++) {
    fullText += chunks[i].content + "\n\n";
  }
  if (fullText.length > 60000) fullText = fullText.slice(0, 60000) + "\n[...truncated...]";

  if (fullText.trim().length < 100) {
    throw new Error("Document too short to classify");
  }

  var prompts = buildClassifyPrompt(doc.name, fullText, targetDocType || null);
  var resp = await callSonnet(anthropic, prompts.system, prompts.user, 4000);
  var parsed = extractJson(resp.text);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Classifier returned invalid JSON");
  }

  /* Write rows. Drop any partial existing rows first (defensive — should
     be empty per the cache check above). */
  await supabase.from("document_classifications").delete().eq("document_id", documentId);
  var rowsToInsert = parsed.slice(0, 30).map(function(r) {
    return {
      document_id: doc.id,
      matter_id: doc.matter_id,
      classification: typeof r.classification === "string" ? r.classification.slice(0, 200) : "Unclassified",
      page_start: typeof r.page_start === "number" ? r.page_start : null,
      page_end: typeof r.page_end === "number" ? r.page_end : null,
      structural_summary: typeof r.structural_summary === "string" ? r.structural_summary.slice(0, 5000) : "",
      classifier_version: "v1",
    };
  });
  var insertResp = await supabase.from("document_classifications").insert(rowsToInsert).select("classification, page_start, page_end, structural_summary");
  if (insertResp.error) throw new Error("Insert failed: " + insertResp.error.message);
  return insertResp.data || rowsToInsert;
}

/* Default export for Vercel's API route conventions. v5.12a: this returns
   a clear "not yet active" response so any accidental hit reports clean
   information rather than a 500 or a silent run. */
export default async function handler(req, res) {
  return res.status(503).json({
    error: "document-classifier endpoint is not active in v5.12a. The classifier is invoked programmatically from worker.js in a future build (Build 3).",
    serverVersion: "v5.12a",
  });
}

export const config = { maxDuration: 120 };
