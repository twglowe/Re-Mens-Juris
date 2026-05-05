/* ELJ v5.16c — api/extract_heading.js
   ───────────────────────────────────────────────────────────────────
   Dedicated heading-extraction endpoint. Bypasses /api/analyse's
   keyword-search retrieval (which was unreliable for headings because
   the search prompt contained words like 'pleadings', 'court', 'case'
   that don't appear in the heading text itself).

   How it works:
   1. Auth (same pattern as drafts.js / draft_doc_titles.js).
   2. Fetch chunk_index IN (0,1) for the matter \u2014 i.e. the first 1\u20132
      chunks of every document. Court headings sit on page 1.
   3. Regex prefilter: keep only chunks containing BOTH a court-name
      shape AND an action-number shape. Misses skip the Claude call.
   4. Send up to 5 matching chunks to Claude with a tight prompt.
      Return the heading JSON if validation passes, else 200 with
      heading=null.
   5. No usage logging (heading extraction is a small, infrequent call;
      we can add later if it matters).

   Failure modes:
   - No matter_id  \u2192 400.
   - No matching chunks (no court doc) \u2192 200 { heading: null }.
   - Claude call fails    \u2192 500.
   - Claude returns something \u2192 validate (court + caseNo + party1
                                            non-empty); else 200 { heading: null }.
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

/* Action-number patterns. Tom's two examples are 'FSD 253 OF 2026 (RPJ)'
   (Cayman) and 'Civil Jurisdiction 2024 No. 123' (Bermuda style). We also
   accept BVI-style 'BVIHC ...' / 'Claim No. ...' and Bermuda 'Cause No. ...'.
   The check is intentionally loose \u2014 misses are cheap (just one less
   chunk in the candidate set) and false positives are filtered later by
   Claude's structured extraction. */
const ACTION_NUMBER_PATTERNS = [
  /\bFSD\s*\d+\s*OF\s*\d{4}/i,                           /* Cayman FSD */
  /\b(?:Civil|Cause|Commercial|Companies?)\s+(?:Jurisdiction|Cause)?\s*\d{4}\s*No\.?\s*\d+/i, /* Bermuda Civil Jurisdiction 2024 No. 123 */
  /\b\d{4}\s*:?\s*No\.?\s*\d+/i,                         /* '2024: No. 123' or '2024 No 123' */
  /\bBVIHC[\s\(\)A-Z\d]+\d+/i,                           /* BVI High Court e.g. BVIHC (COM) 0123 of 2024 */
  /\bClaim\s+No\.?\s*\d+\s*of\s*\d{4}/i,                  /* 'Claim No. 123 of 2024' */
  /\bCause\s+No\.?\s*\d+\s*of\s*\d{4}/i,                  /* 'Cause No. 123 of 2024' */
];

const COURT_PATTERNS = [
  /grand\s+court/i,                /* Cayman Grand Court */
  /supreme\s+court/i,              /* Bermuda Supreme Court */
  /high\s+court/i,                 /* BVI High Court */
  /court\s+of\s+appeal/i,
  /privy\s+council/i,
];

function isHeadingCandidate(text) {
  if (!text || typeof text !== "string") return false;
  /* Only check the first ~2000 chars \u2014 headings sit at the very top of
     a chunk. Saves regex work on long chunks. */
  const head = text.slice(0, 2000);
  const hasCourt = COURT_PATTERNS.some(re => re.test(head));
  if (!hasCourt) return false;
  const hasActionNo = ACTION_NUMBER_PATTERNS.some(re => re.test(head));
  return hasActionNo;
}

const SERVER_VERSION = "v5.16c";
export default async function handler(req, res) {
  console.log(SERVER_VERSION + " extract_heading handler: " + (req.method || "?") + " " + (req.url || ""));
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const user = await getUser(supabase, req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { matterId } = req.body || {};
  if (!matterId) return res.status(400).json({ error: "matterId required" });

  try {
    /* Step 1: Fetch first 1\u20132 chunks of every document in the matter.
       Verify the matter belongs to this user via a separate matters check
       before pulling the chunks (chunks table has no owner_id; security
       is enforced by checking the matter ownership). */
    const { data: m, error: mErr } = await supabase
      .from("matters").select("id").eq("id", matterId).eq("owner_id", user.id).single();
    if (mErr || !m) return res.status(403).json({ error: "Matter not found or not yours" });

    const { data: chunks, error: cErr } = await supabase
      .from("chunks")
      .select("content, document_name, doc_type, chunk_index")
      .eq("matter_id", matterId)
      .in("chunk_index", [0, 1])
      .order("document_name", { ascending: true })
      .order("chunk_index", { ascending: true })
      .limit(200);   /* hard cap \u2014 even with 100 docs at 2 chunks each, 200 covers it */
    if (cErr) throw cErr;
    if (!chunks || chunks.length === 0) {
      console.log("extract_heading: no chunks found for matter", matterId);
      return res.status(200).json({ heading: null, reason: "no_chunks" });
    }

    /* Step 2: Regex prefilter \u2014 keep chunks that look like court doc
       headings. Stop after we've collected 5 candidates. */
    const candidates = [];
    for (const c of chunks) {
      if (isHeadingCandidate(c.content)) {
        candidates.push(c);
        if (candidates.length >= 5) break;
      }
    }
    if (candidates.length === 0) {
      console.log("extract_heading: no heading-shaped chunks for matter", matterId);
      return res.status(200).json({ heading: null, reason: "no_heading_shaped_chunks" });
    }

    /* Step 3: Send to Claude. Keep the prompt very tight and the chunks
       trimmed to the first ~3000 chars each \u2014 that's where the heading
       lives. */
    const candText = candidates.map((c, i) => {
      const head = (c.content || "").slice(0, 3000);
      return `--- CANDIDATE ${i+1}: ${c.document_name} ---\n${head}`;
    }).join("\n\n");

    const prompt = `Below are the opening passages of court documents from a single matter. Extract the case heading from these passages and return it as a JSON object.

Required fields (use empty string "" if not found):
  - court: e.g. "IN THE GRAND COURT OF THE CAYMAN ISLANDS FINANCIAL SERVICES DIVISION", "IN THE SUPREME COURT OF BERMUDA"
  - caseNo: e.g. "FSD 253 OF 2026 (RPJ)", "2024: No. 123"
  - party1: the first party's name, in CAPITALS, e.g. "THALASSA INVESTMENTS LP"
  - party1Role: e.g. "Plaintiff", "Petitioner", "Applicant", or "In the Matter of"
  - party2: second party's name in CAPITALS, or empty if single-party
  - party2Role: e.g. "Defendant", "Respondent", or empty
  - docTitle: the title of THIS document, e.g. "STATEMENT OF CLAIM", "SKELETON ARGUMENT", or empty if uncertain

Return ONLY valid JSON. No prose, no markdown, no code fences.

PASSAGES:
${candText}`;

    const response = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }]
    });

    const text = response.content?.find(b => b.type === "text")?.text?.trim() || "";
    let heading = null;
    try {
      /* Be lenient about extra whitespace or stray code-fence characters. */
      const cleaned = text.replace(/^```json\s*|^```\s*|```$/g, "").trim();
      const s = cleaned.indexOf("{");
      const e = cleaned.lastIndexOf("}");
      if (s >= 0 && e > s) heading = JSON.parse(cleaned.slice(s, e + 1));
    } catch (parseErr) {
      console.log("extract_heading: parse failed:", parseErr.message);
      return res.status(200).json({ heading: null, reason: "parse_failed" });
    }

    if (!heading || typeof heading !== "object") {
      return res.status(200).json({ heading: null, reason: "no_object" });
    }
    /* Validation: need court non-empty AND (caseNo non-empty OR party1 non-empty). */
    const hasCourt = typeof heading.court === "string" && heading.court.trim().length > 2;
    const hasCaseNo = typeof heading.caseNo === "string" && heading.caseNo.trim().length > 0;
    const hasParty1 = typeof heading.party1 === "string" && heading.party1.trim().length > 0;
    if (!hasCourt || (!hasCaseNo && !hasParty1)) {
      console.log("extract_heading: validation failed", { hasCourt, hasCaseNo, hasParty1 });
      return res.status(200).json({ heading: null, reason: "validation_failed", raw: heading });
    }

    /* Normalise: trim whitespace and uppercase party names. */
    const out = {
      court: String(heading.court || "").trim(),
      caseNo: String(heading.caseNo || "").trim(),
      party1: String(heading.party1 || "").trim().toUpperCase(),
      party1Role: String(heading.party1Role || "").trim(),
      party2: String(heading.party2 || "").trim().toUpperCase(),
      party2Role: String(heading.party2Role || "").trim(),
      docTitle: String(heading.docTitle || "").trim().toUpperCase(),
    };

    return res.status(200).json({ heading: out, candidatesUsed: candidates.length });
  } catch (err) {
    console.error("extract_heading error:", err);
    return res.status(500).json({ error: err.message || "Heading extraction failed" });
  }
}
