/* ELJ v5.16d — api/extract_heading.js
   ───────────────────────────────────────────────────────────────────
   Same logic as v5.16c, but every step pushes onto a `steps` array
   that is returned in every response (success, validation_failed,
   error, timeout). Vercel logs unnecessary \u2014 the browser console
   reveals exactly where the request got stuck.

   Also: hard 50-second self-imposed timeout. If anything hangs
   longer than that, we return an error with the steps so far rather
   than letting the client hang indefinitely.
*/
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

export const config = { maxDuration: 60 };

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function getUser(supabase, req) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error) return null;
    return user;
  } catch (e) { return null; }
}

const ACTION_NUMBER_PATTERNS = [
  /\bFSD\s*\d+\s*OF\s*\d{4}/i,
  /\b(?:Civil|Cause|Commercial|Companies?)\s+(?:Jurisdiction|Cause)?\s*\d{4}\s*No\.?\s*\d+/i,
  /\b\d{4}\s*:?\s*No\.?\s*\d+/i,
  /\bBVIHC[\s\(\)A-Z\d]+\d+/i,
  /\bClaim\s+No\.?\s*\d+\s*of\s*\d{4}/i,
  /\bCause\s+No\.?\s*\d+\s*of\s*\d{4}/i,
];

const COURT_PATTERNS = [
  /grand\s+court/i,
  /supreme\s+court/i,
  /high\s+court/i,
  /court\s+of\s+appeal/i,
  /privy\s+council/i,
];

function isHeadingCandidate(text) {
  if (!text || typeof text !== "string") return false;
  const head = text.slice(0, 2000);
  const hasCourt = COURT_PATTERNS.some(re => re.test(head));
  if (!hasCourt) return false;
  const hasActionNo = ACTION_NUMBER_PATTERNS.some(re => re.test(head));
  return hasActionNo;
}

const SERVER_VERSION = "v5.27";

/* withTimeout wraps a promise with a hard timeout that races to settle
   first. If the inner promise hasn't resolved by `ms` milliseconds, the
   wrapper rejects with a Timeout error tagged with the step name. */
function withTimeout(promise, ms, stepName) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("Timeout in step: " + stepName + " (" + ms + "ms)")), ms))
  ]);
}

export default async function handler(req, res) {
  const t0 = Date.now();
  const steps = [];
  const step = (name, extra) => {
    const dt = Date.now() - t0;
    const entry = { t: dt, step: name };
    if (extra !== undefined) entry.extra = extra;
    steps.push(entry);
    console.log(`${SERVER_VERSION} extract_heading [+${dt}ms] ${name}` + (extra !== undefined ? " " + JSON.stringify(extra).slice(0, 200) : ""));
  };

  step("start", { method: req.method, url: req.url });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed", steps });

  let supabase;
  try {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    step("supabase_client_created");
  } catch (e) {
    step("supabase_client_error", { err: e.message });
    return res.status(500).json({ error: "Supabase init failed: " + e.message, step: "supabase_client", steps });
  }

  let user;
  try {
    user = await withTimeout(getUser(supabase, req), 5000, "getUser");
    step("getUser_done", { hasUser: !!user });
  } catch (e) {
    step("getUser_error", { err: e.message });
    return res.status(500).json({ error: "Auth check failed: " + e.message, step: "getUser", steps });
  }
  if (!user) return res.status(401).json({ error: "Unauthorized", steps });

  const { matterId, documentId } = req.body || {};
  if (!matterId) return res.status(400).json({ error: "matterId required", steps });
  step("matter_id_received", { matterId, documentId: documentId || null });

  try {
    /* Step 1: matter ownership check. */
    step("matter_ownership_query_start");
    let m, mErr;
    try {
      const result = await withTimeout(
        supabase.from("matters").select("id").eq("id", matterId).eq("owner_id", user.id).single(),
        8000, "matter_ownership"
      );
      m = result.data; mErr = result.error;
    } catch (e) {
      step("matter_ownership_timeout", { err: e.message });
      return res.status(500).json({ error: e.message, step: "matter_ownership_timeout", steps });
    }
    step("matter_ownership_done", { ownsIt: !!m, err: mErr ? mErr.message : null });
    if (mErr || !m) {
      return res.status(403).json({
        error: "Matter not found or not yours",
        step: "matter_ownership",
        details: mErr ? mErr.message : "no_match",
        steps
      });
    }

    /* Step 2: chunks query. */
    step("chunks_query_start");
    let chunks, cErr;
    try {
      /* v5.23: when the user picks a specific document (Simple heading
         mode) scope the query to that document's opening chunks. */
      let q = supabase.from("chunks")
        .select("content, document_name, doc_type, chunk_index")
        .eq("matter_id", matterId)
        .in("chunk_index", documentId ? [0, 1, 2, 3] : [0, 1])
        .order("document_name", { ascending: true })
        .order("chunk_index", { ascending: true })
        .limit(200);
      if (documentId) q = q.eq("document_id", documentId);
      const result = await withTimeout(q, 15000, "chunks_query");
      chunks = result.data; cErr = result.error;
    } catch (e) {
      step("chunks_query_timeout", { err: e.message });
      return res.status(500).json({ error: e.message, step: "chunks_query_timeout", steps });
    }
    step("chunks_query_done", { chunkCount: chunks ? chunks.length : 0, err: cErr ? cErr.message : null });
    if (cErr) {
      return res.status(500).json({ error: "Chunks query failed: " + cErr.message, step: "chunks_query", steps });
    }
    if (!chunks || chunks.length === 0) {
      return res.status(200).json({ heading: null, reason: "no_chunks", steps });
    }

    /* Step 3: regex prefilter. */
    step("regex_filter_start", { totalChunks: chunks.length });
    const candidates = [];
    for (const c of chunks) {
      if (isHeadingCandidate(c.content)) {
        candidates.push(c);
        if (candidates.length >= 5) break;
      }
    }
    step("regex_filter_done", { candidatesFound: candidates.length });
    /* v5.23: if the user explicitly chose this document, trust them —
       send its opening chunks to Claude even when the regex prefilter
       found nothing heading-shaped. */
    if (candidates.length === 0 && documentId && chunks.length) {
      for (const c of chunks.slice(0, 4)) candidates.push(c);
      step("regex_filter_fallback_single_doc", { used: candidates.length });
    }
    if (candidates.length === 0) {
      /* Capture the document names we scanned and a small text snippet
         from the first one so the diagnostic is informative. */
      return res.status(200).json({
        heading: null,
        reason: "no_heading_shaped_chunks",
        diagnostics: {
          chunksScanned: chunks.length,
          docsScanned: [...new Set(chunks.map(c => c.document_name))].slice(0, 10),
          firstChunkPreview: chunks[0] ? (chunks[0].content || "").slice(0, 300) : null
        },
        steps
      });
    }

    /* Step 4: Claude call. */
    const candText = candidates.map((c, i) => {
      const head = (c.content || "").slice(0, 3000);
      return `--- CANDIDATE ${i+1}: ${c.document_name} ---\n${head}`;
    }).join("\n\n");

    const prompt = `Below are the opening passages of court documents from a single matter. Extract the case heading from these passages and return it as a JSON object.

Required fields (use empty string "" or empty array [] if not found):
  - court: the court line ONLY, e.g. "IN THE GRAND COURT OF THE CAYMAN ISLANDS", "IN THE SUPREME COURT OF BERMUDA"
  - division: the division/jurisdiction line if present, e.g. "FINANCIAL SERVICES DIVISION", "CIVIL JURISDICTION", or empty
  - caseNo: e.g. "FSD 253 OF 2026 (RPJ)", "2024: No. 123"
  - matterOf: an ARRAY of the "IN THE MATTER OF ..." subjects, without the words "IN THE MATTER OF" or "AND IN THE MATTER OF", e.g. ["CHINA SHANSHUI CEMENT GROUP LIMITED", "THE COMPANIES ACT (2025 REVISION)"], or []
  - party1: the first party's name (after BETWEEN), in CAPITALS, e.g. "THALASSA INVESTMENTS LP", or empty
  - party1Role: e.g. "Plaintiff", "Petitioner", "Appellant", "Applicant", or empty
  - party2: second party's name in CAPITALS, or empty
  - party2Role: e.g. "Defendant", "Respondent", or empty
  - docTitle: the title of THIS document (usually between two horizontal lines), e.g. "STATEMENT OF CLAIM", "PETITION", or empty if uncertain

Return ONLY valid JSON. No prose, no markdown, no code fences.

PASSAGES:
${candText}`;

    step("claude_call_start", { promptLength: prompt.length, candidateCount: candidates.length });
    let response;
    try {
      response = await withTimeout(
        anthropic.messages.create({
          model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
          max_tokens: 800,
          messages: [{ role: "user", content: prompt }]
        }),
        40000, "claude_call"
      );
      step("claude_call_done", { stopReason: response.stop_reason });
    } catch (claudeErr) {
      step("claude_call_error", { err: claudeErr.message });
      return res.status(500).json({
        error: "Claude API call failed: " + claudeErr.message,
        step: "claude_call",
        candidateCount: candidates.length,
        steps
      });
    }

    const text = response.content?.find(b => b.type === "text")?.text?.trim() || "";
    step("claude_response_extracted", { length: text.length, preview: text.slice(0, 100) });

    let heading = null;
    try {
      const cleaned = text.replace(/^```json\s*|^```\s*|```$/g, "").trim();
      const s = cleaned.indexOf("{");
      const e = cleaned.lastIndexOf("}");
      if (s >= 0 && e > s) heading = JSON.parse(cleaned.slice(s, e + 1));
    } catch (parseErr) {
      step("parse_error", { err: parseErr.message });
      return res.status(200).json({ heading: null, reason: "parse_failed", raw: text.slice(0, 500), steps });
    }

    if (!heading || typeof heading !== "object") {
      return res.status(200).json({ heading: null, reason: "no_object", raw: text.slice(0, 500), steps });
    }
    const hasCourt = typeof heading.court === "string" && heading.court.trim().length > 2;
    const hasCaseNo = typeof heading.caseNo === "string" && heading.caseNo.trim().length > 0;
    const hasParty1 = typeof heading.party1 === "string" && heading.party1.trim().length > 0;
    const hasDocTitle = typeof heading.docTitle === "string" && heading.docTitle.trim().length > 0;
    const hasMatterOf = Array.isArray(heading.matterOf) && heading.matterOf.some(x => String(x).trim());
    /* v5.26: when the user explicitly chose the document, a partial
       heading is far more useful than nothing — accept if ANY field was
       found, and tell the client it is partial so it can say so. The
       strict rule stays for multi-document mode. */
    if (documentId) {
      if (!hasCourt && !hasCaseNo && !hasParty1 && !hasDocTitle && !hasMatterOf) {
        step("validation_failed", { hasCourt, hasCaseNo, hasParty1, hasDocTitle });
        return res.status(200).json({ heading: null, reason: "validation_failed", raw: heading, steps });
      }
    } else if (!hasCourt || (!hasCaseNo && !hasParty1)) {
      step("validation_failed", { hasCourt, hasCaseNo, hasParty1 });
      return res.status(200).json({ heading: null, reason: "validation_failed", raw: heading, steps });
    }

    const out = {
      court: String(heading.court || "").trim(),
      division: String(heading.division || "").trim().toUpperCase(),
      caseNo: String(heading.caseNo || "").trim(),
      matterOf: (Array.isArray(heading.matterOf) ? heading.matterOf : [])
        .map(x => String(x).trim().replace(/^(and\s+)?in\s+the\s+matter\s+of\s+/i, "").toUpperCase())
        .filter(Boolean),
      party1: String(heading.party1 || "").trim().toUpperCase(),
      party1Role: String(heading.party1Role || "").trim(),
      party2: String(heading.party2 || "").trim().toUpperCase(),
      party2Role: String(heading.party2Role || "").trim(),
      docTitle: String(heading.docTitle || "").trim().toUpperCase(),
    };
    step("success", { court: out.court.slice(0, 30), caseNo: out.caseNo });
    const partial = !(hasCourt && (hasCaseNo || hasParty1));
    return res.status(200).json({ heading: out, partial, candidatesUsed: candidates.length, totalMs: Date.now() - t0, steps });
  } catch (err) {
    step("unhandled_error", { err: err.message, stack: err.stack ? err.stack.slice(0, 300) : null });
    return res.status(500).json({
      error: err.message || "Heading extraction failed",
      step: "unhandled",
      stack: err.stack ? err.stack.slice(0, 500) : null,
      steps
    });
  }
}
