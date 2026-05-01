/* EX LIBRIS JURIS v5.12a — fingerprint.js
   Layer 1: cheap eager fingerprint of a single document.

   Called as fire-and-forget from upload.js after a successful upload, and
   called sequentially by index-library.js when Tom hits the "Index N
   documents" button. Either way the contract is the same: one POST per
   document, returns quickly with a result.

   What it does:
     1. Verifies the request is authenticated (or comes from a same-origin
        worker, see below).
     2. Looks up the document and its chunks.
     3. Reads the first ~4,000 chars (cover page, opening, first index, first
        headers) and sends to Claude Haiku 4.5.
     4. Parses the JSON response. Writes one row to document_fingerprints.
     5. On any failure, writes a failed=true row with a short reason so the
        Library tab can surface it.

   Idempotency:
     - If a fingerprint already exists for this document_id and is NOT
       failed=true, returns immediately without re-classifying.
     - If a fingerprint exists with failed=true, deletes it and tries again
       (this is the retry path — Tom presses "Retry N failed").

   Authentication:
     - Standard bearer-token path for end-user calls.
     - When called fire-and-forget from upload.js (server-to-server inside
       the same Vercel deployment), we accept a service-role shared-secret
       header X-Internal-Secret matching FINGERPRINT_INTERNAL_SECRET.
     - This is the same fire-and-forget pattern tools.js uses to fire
       worker.js — except we add the secret check because fingerprint.js
       has no jobId-bound row that constrains who can call it.
   v5.12a: created. */

import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

export const config = { maxDuration: 60 };

const SERVER_VERSION = "v5.12a";
const FINGERPRINT_MODEL = process.env.HAIKU_MODEL || "claude-haiku-4-5-20251001";
const SAMPLE_CHARS = 4000;

function freshClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

async function getUserOrInternal(req, supabase) {
  /* Accept internal calls from upload.js / index-library.js in the same
     Vercel deployment. The shared secret is set as an env var; if missing
     internal calls cannot succeed, which is the safe default. */
  var internalSecret = process.env.FINGERPRINT_INTERNAL_SECRET || "";
  var headerSecret = req.headers["x-internal-secret"] || "";
  if (internalSecret && headerSecret && headerSecret === internalSecret) {
    return { internal: true };
  }
  /* Otherwise standard end-user auth */
  var token = req.headers.authorization ? req.headers.authorization.replace("Bearer ", "") : "";
  if (!token) return null;
  try {
    var resp = await supabase.auth.getUser(token);
    if (resp.error || !resp.data || !resp.data.user) return null;
    return { user: resp.data.user };
  } catch (e) {
    return null;
  }
}

/* Same pattern as worker.js runTool retry, but using Haiku for cost.
   Smaller backoff schedule: this is meant to be fast and cheap. If Haiku
   really cannot answer after 2 retries we fail the document and move on. */
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

async function callHaiku(anthropic, system, userPrompt) {
  var BACKOFF_MS = [3000, 9000];
  var MAX_ATTEMPTS = BACKOFF_MS.length + 1;
  var attempt = 0;
  var lastErr = null;
  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    try {
      var resp = await anthropic.messages.create({
        model: FINGERPRINT_MODEL,
        max_tokens: 800,
        system: system,
        messages: [{ role: "user", content: userPrompt }],
      });
      var text = "";
      if (resp.content) {
        for (var i = 0; i < resp.content.length; i++) {
          if (resp.content[i].type === "text") { text = resp.content[i].text; break; }
        }
      }
      return { text: text, inputTokens: (resp.usage && resp.usage.input_tokens) || 0, outputTokens: (resp.usage && resp.usage.output_tokens) || 0 };
    } catch (err) {
      lastErr = err;
      if (!isRetryableAnthropicError(err)) throw err;
      if (attempt >= MAX_ATTEMPTS) throw err;
      var waitMs = BACKOFF_MS[attempt - 1];
      console.log("v5.12a fingerprint: retryable error attempt " + attempt + ", waiting " + (waitMs / 1000) + "s");
      await new Promise(function(r) { setTimeout(r, waitMs); });
    }
  }
  throw lastErr || new Error("callHaiku exhausted retries");
}

/* Strip code fences and parse JSON. Some Haiku replies wrap output in
   ```json ... ``` even when told not to; this normalises that. */
function extractJson(text) {
  if (!text) return null;
  var stripped = text.trim();
  /* Remove leading ```json or ``` and trailing ``` */
  stripped = stripped.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  try {
    return JSON.parse(stripped);
  } catch (e) {
    /* Try to find the first { or [ and last } or ] */
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

/* The fingerprint prompt. Short, cheap, JSON-only. Reads the opening of the
   document; tells Haiku to look at the filename, cover sheet, table of
   contents, internal headers, and formal openings. Returns a JSON object,
   not an array — Layer 2 (the classifier) is what produces multiple rows
   for bundles. Layer 1 just flags "this looks like a bundle" so Layer 2
   knows to inspect more carefully. */
function buildPrompt(fileName, sampleText) {
  var system = "You analyse legal documents and identify their type from a brief opening sample. You always return valid JSON only, with no preamble, commentary, or markdown fences.";
  var user = "Analyse this opening sample of a legal document and identify what it is.\n\n" +
    "The document may be:\n" +
    "  (a) A single legal document (Skeleton Argument, Defence, Particulars of Claim,\n" +
    "      Notice of Appeal, Witness Statement, Affidavit, Order, Judgment, Letter,\n" +
    "      Memorandum, Research Note, Bundle Index, Exhibit, etc.)\n" +
    "  (b) A bundle containing multiple documents (hearing bundle, exhibit bundle).\n\n" +
    "Look at: filename, any cover sheet, table of contents or index, internal\n" +
    "section headers, and formal openings (\"IN THE SUPREME COURT...\", \"I, [name],\n" +
    "make oath...\", \"Dear Sir,\", etc.).\n\n" +
    "Return ONLY this JSON object, no markdown fences:\n\n" +
    "{\n" +
    "  \"likely_types\": [\"Skeleton Argument\"],\n" +
    "  \"is_likely_bundle\": false,\n" +
    "  \"structural_hint\": \"Short 1-2 sentence note on the document's structure\\n  and form. Do NOT summarise the facts of the matter — only the\\n  structure (sections, headings, length, formatting conventions).\"\n" +
    "}\n\n" +
    "Rules:\n" +
    "- likely_types: array of one or more short type labels. For a single\n" +
    "  document, one entry. For a bundle, the bundle's likely contents\n" +
    "  (e.g. [\"Bundle\", \"Skeleton Argument\", \"Witness Statement\"]).\n" +
    "- is_likely_bundle: true if the document looks like it contains\n" +
    "  multiple distinct sub-documents (table of contents at the start, or\n" +
    "  visible cover sheets between sections, or page count over 50 with\n" +
    "  multiple formal openings).\n" +
    "- structural_hint: 1-2 sentences only. Structure, not facts.\n\n" +
    "DOCUMENT FILENAME: " + fileName + "\n\n" +
    "OPENING SAMPLE (first ~4000 chars, may be truncated):\n\n" + sampleText;
  return { system: system, user: user };
}

async function fetchDocAndSample(supabase, documentId) {
  var docResp = await supabase
    .from("documents")
    .select("id, matter_id, name")
    .eq("id", documentId)
    .single();
  if (docResp.error || !docResp.data) {
    return { ok: false, reason: "Document not found." };
  }

  var chunkResp = await supabase
    .from("chunks")
    .select("content, chunk_index")
    .eq("document_id", documentId)
    .order("chunk_index", { ascending: true })
    .limit(20);
  if (chunkResp.error) {
    return { ok: false, reason: "Could not load document chunks." };
  }

  var chunks = chunkResp.data || [];
  var sample = "";
  for (var i = 0; i < chunks.length && sample.length < SAMPLE_CHARS; i++) {
    sample += chunks[i].content + "\n\n";
  }
  if (sample.length > SAMPLE_CHARS) sample = sample.slice(0, SAMPLE_CHARS);

  if (sample.trim().length < 100) {
    return { ok: false, reason: "Document too short to classify (under 100 characters of text).", doc: docResp.data };
  }

  return { ok: true, doc: docResp.data, sample: sample };
}

async function writeFingerprint(supabase, doc, parsed) {
  /* Idempotent upsert: delete any existing row for this document, then insert.
     We could use ON CONFLICT but we want to overwrite cleanly when retrying a
     failed fingerprint. */
  await supabase.from("document_fingerprints").delete().eq("document_id", doc.id);
  var likelyTypes = Array.isArray(parsed.likely_types) ? parsed.likely_types.slice(0, 10) : [];
  var insertResp = await supabase.from("document_fingerprints").insert({
    document_id: doc.id,
    matter_id: doc.matter_id,
    likely_types: likelyTypes,
    is_likely_bundle: !!parsed.is_likely_bundle,
    structural_hint: typeof parsed.structural_hint === "string" ? parsed.structural_hint.slice(0, 4000) : "",
    fingerprint_version: "v1",
    failed: false,
    failure_reason: null,
  }).select("id").single();
  if (insertResp.error) {
    throw new Error("Insert failed: " + insertResp.error.message);
  }
  return insertResp.data.id;
}

async function writeFailure(supabase, documentId, matterId, reason) {
  await supabase.from("document_fingerprints").delete().eq("document_id", documentId);
  await supabase.from("document_fingerprints").insert({
    document_id: documentId,
    matter_id: matterId,
    likely_types: [],
    is_likely_bundle: false,
    structural_hint: "",
    fingerprint_version: "v1",
    failed: true,
    failure_reason: reason.slice(0, 500),
  });
}

export default async function handler(req, res) {
  console.log(SERVER_VERSION + " fingerprint handler: " + (req.method || "?") + " " + (req.url || ""));
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  var supabase = freshClient();
  var caller = await getUserOrInternal(req, supabase);
  if (!caller) return res.status(401).json({ error: "Unauthorized" });

  var documentId = req.query.documentId || (req.body && req.body.documentId);
  if (!documentId) return res.status(400).json({ error: "documentId required" });

  /* Permission check for end-user calls. Internal calls bypass — they are
     trusted because they came with the shared secret. */
  if (!caller.internal) {
    var permResp = await supabase
      .from("documents")
      .select("matter_id, matters!inner(owner_id)")
      .eq("id", documentId)
      .single();
    if (permResp.error || !permResp.data) {
      return res.status(404).json({ error: "Document not found" });
    }
    var ownerId = permResp.data.matters && permResp.data.matters.owner_id;
    if (ownerId !== caller.user.id) {
      /* Could also be a shared matter — check matter_shares */
      var shareResp = await supabase
        .from("matter_shares")
        .select("permission")
        .eq("matter_id", permResp.data.matter_id)
        .eq("user_id", caller.user.id)
        .single();
      if (!shareResp.data || (shareResp.data.permission !== "edit" && shareResp.data.permission !== "view")) {
        return res.status(403).json({ error: "No access to this document" });
      }
    }
  }

  /* Idempotency: if a non-failed fingerprint already exists, return it. */
  var existingResp = await supabase
    .from("document_fingerprints")
    .select("id, failed, likely_types, is_likely_bundle, structural_hint")
    .eq("document_id", documentId)
    .single();
  if (existingResp.data && !existingResp.data.failed) {
    return res.status(200).json({
      ok: true,
      status: "already_fingerprinted",
      fingerprintId: existingResp.data.id,
    });
  }

  /* Fetch + sample */
  var fetched;
  try {
    fetched = await fetchDocAndSample(supabase, documentId);
  } catch (e) {
    return res.status(500).json({ error: "Document fetch failed: " + e.message });
  }
  if (!fetched.ok) {
    /* Soft failure: write a failure row so the indicator can show it, but
       return 200 so callers (notably index-library.js) can carry on. */
    if (fetched.doc) {
      try { await writeFailure(supabase, fetched.doc.id, fetched.doc.matter_id, fetched.reason); } catch (e) { /* swallow */ }
    }
    return res.status(200).json({ ok: false, status: "failed", reason: fetched.reason });
  }

  var doc = fetched.doc;
  var sample = fetched.sample;
  var prompts = buildPrompt(doc.name, sample);

  var anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  var haikuResp;
  try {
    haikuResp = await callHaiku(anthropic, prompts.system, prompts.user);
  } catch (e) {
    var reason = "AI returned an unreadable response after 2 retries. May be transient — try again.";
    if (e && e.status === 401) reason = "AI authentication failed.";
    try { await writeFailure(supabase, doc.id, doc.matter_id, reason); } catch (we) { /* swallow */ }
    console.log("v5.12a fingerprint: Haiku call failed for " + doc.id + " (" + doc.name + "): " + (e.message || e));
    return res.status(200).json({ ok: false, status: "failed", reason: reason });
  }

  var parsed = extractJson(haikuResp.text);
  if (!parsed || !Array.isArray(parsed.likely_types)) {
    var jsonReason = "Couldn't extract structure — AI response was not valid JSON.";
    try { await writeFailure(supabase, doc.id, doc.matter_id, jsonReason); } catch (we) { /* swallow */ }
    console.log("v5.12a fingerprint: JSON parse failed for " + doc.id + ", raw: " + (haikuResp.text || "").slice(0, 200));
    return res.status(200).json({ ok: false, status: "failed", reason: jsonReason });
  }

  try {
    var fpId = await writeFingerprint(supabase, doc, parsed);
    return res.status(200).json({
      ok: true,
      status: "fingerprinted",
      fingerprintId: fpId,
      likely_types: parsed.likely_types,
      is_likely_bundle: !!parsed.is_likely_bundle,
    });
  } catch (e) {
    var dbReason = "Couldn't save fingerprint to database.";
    try { await writeFailure(supabase, doc.id, doc.matter_id, dbReason); } catch (we) { /* swallow */ }
    return res.status(200).json({ ok: false, status: "failed", reason: dbReason });
  }
}
