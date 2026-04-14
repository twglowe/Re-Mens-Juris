import { createClient } from "@supabase/supabase-js";

/* ── v5.2: Batched upload support ─────────────────────────────────────────
   Very large PDFs (3 GB+ hearing bundles) extract to more text than fits
   in a single POST body. Vercel's gateway rejects requests with body >
   ~4.5 MB with FUNCTION_PAYLOAD_TOO_LARGE before the handler runs. The
   client-side text extraction succeeds but the upload POST fails.

   Fix: accept batched uploads. The client splits pageTexts into chunks
   capped at ~2 MB of JSON per POST and sends them sequentially. New
   optional body fields:
     - batchIndex   (0-based index of this batch)
     - batchTotal   (total number of batches for this document)
     - documentId   (set on batch 1..N-1, referencing the document created
                     by batch 0)
   If all three are absent the handler behaves exactly as before — the
   single-POST happy path is fully backward compatible.

   Flow:
     - batch 0 (or single-POST): create document row, insert chunks,
       finalise counts only if single-POST; otherwise return documentId
       so the client can use it for subsequent batches
     - batch 1..N-1: look up existing document, verify it belongs to the
       same matter, compute next chunk_index, insert chunks; on the last
       batch update chunk_count and matter document_count
   ─────────────────────────────────────────────────────────────────────── */

/* ── v5.1d: pdf-parse import REMOVED ──────────────────────────────────────
   The previous version of this file had `import pdfParse from
   "pdf-parse/lib/pdf-parse.js"` at the top. On Vercel this started failing
   at MODULE LOAD TIME with "Cannot find module 'pdf-parse/lib/pdf-parse.js'"
   — the package either disappeared from package.json, was moved to
   devDependencies, or changed its internal layout. The module-load failure
   crashed the function before any handler code ran, returning
   FUNCTION_INVOCATION_FAILED for EVERY upload (PDF and .docx alike).

   Fix: remove the import entirely. The pdfParse() call was only used by
   the legacy `fileData` branch — a base64 PDF upload path from ELJ v1/v2
   where the server did the PDF text extraction itself. The current client
   hasn't used that path since v3.2: both PDF (via pdf.js) and .docx (via
   mammoth.js via v4.5) extract text client-side and POST `pageTexts`.
   The `fileData` branch is dead code. It's been replaced with a clear
   400 response so any stale client that still hits it gets a useful error
   instead of a cryptic crash.
   ─────────────────────────────────────────────────────────────────────── */

export const config = { maxDuration: 300, api: { bodyParser: { sizeLimit: "50mb" } } };

/* v4.2j lesson: freshClient() per handler invocation, never module-scope.
   The v5.0 backend files use this pattern; upload.js was one of the
   originals still on module-scope. Converting to per-invocation keeps
   this file consistent with folders.js / documents.js / worker.js. */
function freshClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

/* ── v4.3c: TEXT SANITISATION ────────────────────────────────────────────
   PostgreSQL (via PostgREST) rejects strings containing certain Unicode
   sequences with "unsupported Unicode escape sequence". The main offenders
   in PDF-extracted text are:
     - NULL byte \u0000 (always rejected by Postgres text columns)
     - Other C0 control characters (mostly noise from PDF binary streams)
     - C1 control characters (\u0080–\u009F, also noise)
     - Lone surrogates (unpaired \uD800–\uDFFF code units, invalid UTF-8)
   This function strips all of those while preserving \t, \n, \r which are
   legitimate in document text. Applied to every text field before insertion.
   ─────────────────────────────────────────────────────────────────────── */
function sanitiseText(s) {
  if (typeof s !== "string" || !s) return "";
  // Strip C0 controls except \t \n \r, and all C1 controls
  let cleaned = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
  // Strip lone surrogates (high not followed by low, or low not preceded by high)
  cleaned = cleaned.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  return cleaned;
}

async function getUser(req, supabase) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  return error ? null : user;
}

async function canEdit(supabase, userId, matterId) {
  const { data: own } = await supabase.from("matters").select("id").eq("id", matterId).eq("owner_id", userId).single();
  if (own) return true;
  const { data: share } = await supabase.from("matter_shares").select("permission").eq("matter_id", matterId).eq("user_id", userId).single();
  return share?.permission === "edit";
}

/* ── PAGE-AWARE CHUNKING ──────────────────────────────────────────────────
   Input: array of { page, text } objects (one per PDF page, or one per
   Word paragraph-block via mammoth.js)
   Output: array of { text, page } objects where page is the starting page
   number. Each chunk records which page it begins on. If a chunk spans
   pages, the page number is the page where the chunk starts.
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
  const supabase = freshClient();
  const user = await getUser(req, supabase);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  /* v5.0: folderIds is an optional array of folder UUIDs to assign this
     document to on upload. Empty / missing = uncategorised.
     v5.2: batchIndex, batchTotal, documentId are optional fields for
     batched uploads of very large files. If batchIndex is missing or 0
     AND documentId is missing, this is a fresh upload: create the
     document row, insert chunks, update counts (if single-batch).
     If batchIndex > 0 AND documentId is provided, this is an append
     batch for an existing document: verify permission, insert chunks
     with chunk_index continuing from the current max, and if this is
     the last batch, update chunk_count and matter document_count. */
  const {
    matterId, fileName, fileData, textContent, pageTexts,
    docType, party, docIssues, folderIds,
    batchIndex, batchTotal, documentId,
  } = req.body;
  if (!matterId || !fileName) return res.status(400).json({ error: "Missing fields" });

  /* v5.1d: fileData path is no longer supported. */
  if (fileData && !pageTexts && !textContent) {
    return res.status(400).json({
      error: "Server-side PDF extraction is no longer supported. Please reload the app and try again — the new client extracts text locally before upload."
    });
  }
  if (!textContent && !pageTexts) {
    return res.status(400).json({ error: "No text content provided" });
  }

  const allowed = await canEdit(supabase, user.id, matterId);
  if (!allowed) return res.status(403).json({ error: "No edit permission" });

  /* v5.2: Determine upload mode. */
  const isBatched = typeof batchTotal === "number" && batchTotal > 1;
  const bIdx = typeof batchIndex === "number" ? batchIndex : 0;
  const bTotal = typeof batchTotal === "number" ? batchTotal : 1;
  const isAppendBatch = isBatched && bIdx > 0 && typeof documentId === "string" && documentId.length > 0;
  const isFirstBatch = !isAppendBatch; /* first batch OR single-POST happy path */

  try {
    let extractedText = "";
    let pages = null; // Array of { page, text } if available

    if (pageTexts && Array.isArray(pageTexts) && pageTexts.length > 0) {
      // v3.2: Client sends per-page text array — use page-aware chunking
      // v4.3c: Sanitise each page's text before any further processing
      pages = pageTexts.map(p => ({ page: p.page, text: sanitiseText(p.text) }));
      extractedText = pages.map(p => p.text).join("\n\n");
    } else if (textContent) {
      // v3.0 path: Client sent single text string — no page info
      // v4.3c: Sanitise before insertion
      extractedText = sanitiseText(textContent);
    }

    if (!extractedText || extractedText.trim().length < 50) {
      return res.status(400).json({ error: "No readable text found. This document may be a scanned image — please OCR it first at ilovepdf.com, or check that the .docx file is not empty." });
    }

    /* ── Append-batch path ────────────────────────────────────────────── */
    if (isAppendBatch) {
      /* Verify the document exists and belongs to this matter. This also
         prevents cross-matter abuse where a client could send a random
         documentId and try to append chunks to someone else's document. */
      const { data: existingDoc, error: eErr } = await supabase
        .from("documents")
        .select("id, matter_id, char_count")
        .eq("id", documentId)
        .single();
      if (eErr || !existingDoc) {
        return res.status(404).json({ error: "Document not found for append" });
      }
      if (existingDoc.matter_id !== matterId) {
        return res.status(403).json({ error: "Document does not belong to this matter" });
      }

      /* Find the current max chunk_index for this document so we can
         continue numbering from there. */
      const { data: maxRows, error: mErr } = await supabase
        .from("chunks")
        .select("chunk_index")
        .eq("document_id", documentId)
        .order("chunk_index", { ascending: false })
        .limit(1);
      if (mErr) throw mErr;
      const baseIndex = (maxRows && maxRows.length > 0 ? (maxRows[0].chunk_index || 0) + 1 : 0);

      /* Chunk this batch's text. Same chunker as first-batch path. */
      let chunkRows;
      if (pages) {
        const pageChunks = chunkTextWithPages(pages);
        chunkRows = pageChunks.map((c, i) => ({
          matter_id: matterId, document_id: documentId, document_name: fileName,
          doc_type: docType || "Other", party: party || null,
          doc_issues: docIssues || null, chunk_index: baseIndex + i,
          content: c.text, page_number: c.page,
        }));
      } else {
        const plainChunks = chunkText(extractedText);
        chunkRows = plainChunks.map((text, i) => ({
          matter_id: matterId, document_id: documentId, document_name: fileName,
          doc_type: docType || "Other", party: party || null,
          doc_issues: docIssues || null, chunk_index: baseIndex + i,
          content: text, page_number: null,
        }));
      }

      /* Insert in sub-batches of 50 (same pattern as first-batch path) */
      for (let i = 0; i < chunkRows.length; i += 50) {
        const { error } = await supabase.from("chunks").insert(chunkRows.slice(i, i + 50));
        if (error) throw error;
      }

      /* Update char_count to accumulate the running total across batches */
      await supabase.from("documents")
        .update({ char_count: (existingDoc.char_count || 0) + extractedText.length })
        .eq("id", documentId);

      /* If this is the last batch, finalise: update chunk_count and
         refresh the matter's document_count. */
      if (bIdx === bTotal - 1) {
        const { count: finalChunkCount } = await supabase
          .from("chunks")
          .select("*", { count: "exact", head: true })
          .eq("document_id", documentId);
        await supabase.from("documents")
          .update({ chunk_count: finalChunkCount || 0 })
          .eq("id", documentId);
        const { count: matterDocCount } = await supabase
          .from("documents")
          .select("*", { count: "exact", head: true })
          .eq("matter_id", matterId);
        await supabase.from("matters")
          .update({ document_count: matterDocCount || 0 })
          .eq("id", matterId);
        return res.status(200).json({
          success: true, documentId: documentId,
          chunks: chunkRows.length, characters: extractedText.length,
          pageAware: !!pages,
          batchIndex: bIdx, batchTotal: bTotal, complete: true,
        });
      }

      /* Not the last batch — return progress but don't update counts yet */
      return res.status(200).json({
        success: true, documentId: documentId,
        chunks: chunkRows.length, characters: extractedText.length,
        pageAware: !!pages,
        batchIndex: bIdx, batchTotal: bTotal, complete: false,
      });
    }

    /* ── First-batch path (also covers single-POST happy path) ──────── */
    const { data: doc, error: docError } = await supabase.from("documents")
      .insert({
        matter_id: matterId, name: fileName,
        doc_type: docType || "Other", party: party || null,
        doc_issues: docIssues || null, char_count: extractedText.length, chunk_count: 0
      })
      .select().single();
    if (docError) throw docError;

    /* v5.0: assign document to folders if folderIds were supplied. Validate
       each folder belongs to the same matter to prevent cross-matter assignment. */
    if (Array.isArray(folderIds) && folderIds.length > 0) {
      const { data: validFolders, error: vfErr } = await supabase
        .from("folders")
        .select("id, matter_id")
        .in("id", folderIds);
      if (vfErr) {
        console.log("v5.0 folder validation failed:", vfErr.message);
      } else {
        const sameMatter = (validFolders || []).filter(function (f) { return f.matter_id === matterId; });
        if (sameMatter.length > 0) {
          const joinRows = sameMatter.map(function (f) {
            return { document_id: doc.id, folder_id: f.id };
          });
          const { error: joinErr } = await supabase.from("document_folders").insert(joinRows);
          if (joinErr) console.log("v5.0 folder assignment insert failed:", joinErr.message);
        }
      }
    }

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

    /* v5.2: If this is the first of a multi-batch upload, skip the final
       chunk_count update — wait until the last batch finalises. If it's
       a single-POST upload, finalise now (existing behaviour). */
    if (isBatched) {
      /* First batch of many — char_count is already stored from the insert
         above; chunk_count will be finalised on the last batch. Return
         the documentId so the client can use it in subsequent batches. */
      return res.status(200).json({
        success: true, documentId: doc.id,
        chunks: chunkRows.length, characters: extractedText.length,
        pageAware: !!pages,
        batchIndex: bIdx, batchTotal: bTotal, complete: false,
      });
    }

    /* Single-POST happy path: finalise chunk_count and matter document_count */
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
