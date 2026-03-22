import { createClient } from "@supabase/supabase-js";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

export const config = { maxDuration: 300, api: { bodyParser: { sizeLimit: "50mb" } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function getUser(req) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  return error ? null : user;
}

async function canEdit(userId, matterId) {
  const { data: own } = await supabase.from("matters").select("id").eq("id", matterId).eq("owner_id", userId).single();
  if (own) return true;
  const { data: share } = await supabase.from("matter_shares").select("permission").eq("matter_id", matterId).eq("user_id", userId).single();
  return share?.permission === "edit";
}

/* ── PAGE-AWARE CHUNKING ──────────────────────────────────────────────────
   Input: array of { page, text } objects (one per PDF page)
   Output: array of { text, page } objects where page is the starting page number
   Each chunk records which page it begins on. If a chunk spans pages,
   the page number is the page where the chunk starts.
   ──────────────────────────────────────────────────────────────────────── */
function chunkTextWithPages(pages, chunkSize = 1200, overlap = 150) {
  const chunks = [];
  let current = "";
  let currentPage = 1;

  for (const pg of pages) {
    const pageNum = pg.page;
    const cleaned = pg.text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{4,}/g, "\n\n\n").trim();
    if (!cleaned) continue;

    const paragraphs = cleaned.split(/\n\s*\n/);
    for (const para of paragraphs) {
      const p = para.trim();
      if (!p) continue;

      if ((current + p).length > chunkSize && current.length > 0) {
        chunks.push({ text: current.trim(), page: currentPage });
        // Keep overlap from end of current chunk, start new chunk on this page
        current = current.slice(-overlap) + "\n\n" + p;
        currentPage = pageNum;
      } else {
        if (!current) currentPage = pageNum;
        current += (current ? "\n\n" : "") + p;
      }
    }
  }
  if (current.trim().length > 50) {
    chunks.push({ text: current.trim(), page: currentPage });
  }

  // Split oversized chunks
  const final = [];
  for (const chunk of chunks) {
    if (chunk.text.length <= chunkSize * 1.5) {
      final.push(chunk);
    } else {
      let start = 0;
      while (start < chunk.text.length) {
        final.push({ text: chunk.text.slice(start, start + chunkSize), page: chunk.page });
        start += chunkSize - overlap;
      }
    }
  }
  return final.filter(c => c.text.length > 50);
}

/* ── LEGACY CHUNKING (no page info — used when client sends plain text) ── */
function chunkText(text, chunkSize = 1200, overlap = 150) {
  text = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{4,}/g, "\n\n\n").trim();
  const chunks = [];
  const paragraphs = text.split(/\n\s*\n/);
  let current = "";
  for (const para of paragraphs) {
    const p = para.trim();
    if (!p) continue;
    if ((current + p).length > chunkSize && current.length > 0) {
      chunks.push(current.trim());
      current = current.slice(-overlap) + "\n\n" + p;
    } else {
      current += (current ? "\n\n" : "") + p;
    }
  }
  if (current.trim().length > 50) chunks.push(current.trim());
  const final = [];
  for (const chunk of chunks) {
    if (chunk.length <= chunkSize * 1.5) {
      final.push(chunk);
    } else {
      let start = 0;
      while (start < chunk.length) {
        final.push(chunk.slice(start, start + chunkSize));
        start += chunkSize - overlap;
      }
    }
  }
  return final.filter(c => c.length > 50);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const { matterId, fileName, fileData, textContent, pageTexts, docType, party, docIssues } = req.body;
  if (!matterId || !fileName) return res.status(400).json({ error: "Missing fields" });
  if (!fileData && !textContent && !pageTexts) return res.status(400).json({ error: "No file data or text content provided" });
  const allowed = await canEdit(user.id, matterId);
  if (!allowed) return res.status(403).json({ error: "No edit permission" });

  try {
    let extractedText = "";
    let pages = null; // Array of { page, text } if available

    if (pageTexts && Array.isArray(pageTexts) && pageTexts.length > 0) {
      // v3.2: Client sends per-page text array — use page-aware chunking
      pages = pageTexts;
      extractedText = pageTexts.map(p => p.text).join("\n\n");
    } else if (textContent) {
      // v3.0 path: Client sent single text string — no page info
      extractedText = textContent;
    } else if (fileData) {
      // Legacy path: base64 PDF, extract server-side
      const buffer = Buffer.from(fileData, "base64");
      try {
        const parsed = await pdfParse(buffer);
        extractedText = parsed.text || "";
      } catch (e) {
        return res.status(400).json({ error: "Could not read this PDF. It may be password-protected or a scanned image. Please use ilovepdf.com to OCR it first." });
      }
    }

    if (!extractedText || extractedText.trim().length < 50) {
      return res.status(400).json({ error: "No readable text found. This PDF may be a scanned image — please OCR it first at ilovepdf.com." });
    }

    const { data: doc, error: docError } = await supabase.from("documents")
      .insert({
        matter_id: matterId, name: fileName,
        doc_type: docType || "Other", party: party || null,
        doc_issues: docIssues || null, char_count: extractedText.length, chunk_count: 0
      })
      .select().single();
    if (docError) throw docError;

    let chunkRows;

    if (pages) {
      // v3.2: Page-aware chunking
      const pageChunks = chunkTextWithPages(pages);
      chunkRows = pageChunks.map((c, index) => ({
        matter_id: matterId, document_id: doc.id, document_name: fileName,
        doc_type: docType || "Other", party: party || null,
        doc_issues: docIssues || null, chunk_index: index,
        content: c.text, page_number: c.page,
      }));
    } else {
      // Legacy: no page info
      const chunks = chunkText(extractedText);
      chunkRows = chunks.map((text, index) => ({
        matter_id: matterId, document_id: doc.id, document_name: fileName,
        doc_type: docType || "Other", party: party || null,
        doc_issues: docIssues || null, chunk_index: index,
        content: text, page_number: null,
      }));
    }

    for (let i = 0; i < chunkRows.length; i += 50) {
      const { error } = await supabase.from("chunks").insert(chunkRows.slice(i, i + 50));
      if (error) throw error;
    }

    await supabase.from("documents").update({ chunk_count: chunkRows.length }).eq("id", doc.id);
    const { count } = await supabase.from("documents").select("*", { count: "exact", head: true }).eq("matter_id", matterId);
    await supabase.from("matters").update({ document_count: count || 0 }).eq("id", matterId);

    return res.status(200).json({
      success: true, documentId: doc.id,
      chunks: chunkRows.length, characters: extractedText.length,
      pageAware: !!pages
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Upload failed" });
  }
}
