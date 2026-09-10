import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import formidable from "formidable";
import fs from "fs";

export const config = { maxDuration: 120, api: { bodyParser: false } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function getUser(req) {
  const authHeader = req.headers.authorization?.replace("Bearer ", "");
  if (authHeader) {
    const { data: { user }, error } = await supabase.auth.getUser(authHeader);
    if (!error && user) return user;
  }
  return null;
}

/* v5.64: chunk page by page so every chunk knows where it came from — a
   citation without a pinpoint is half a citation. Pages carry `refPage`, the
   judgment's own internal number, which is what a court wants; in a bundle
   that differs from the page's position in the file. Falls back to the
   position when no internal number could be read.

   Chunks do not span a page boundary, which makes a few short chunks at page
   ends; the alternative is a chunk that cannot honestly name one page. */
function chunkPages(pages, size = 1500, overlap = 150) {
  const rows = [];
  for (const pg of pages) {
    const text = String((pg && pg.text) || "");
    if (!text.trim()) continue;
    const page = (pg.refPage !== null && pg.refPage !== undefined) ? pg.refPage : (pg.page || null);
    for (const c of chunkText(text, size, overlap)) {
      rows.push({ content: c, page_number: (typeof page === "number" ? page : null) });
    }
  }
  return rows;
}

function chunkText(text, size = 1500, overlap = 150) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + size));
    i += size - overlap;
  }
  return chunks;
}

async function extractPdfText(filePath) {
  const pdfBuffer = fs.readFileSync(filePath);
  const base64 = pdfBuffer.toString("base64");
  const response = await anthropic.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 4096,
    messages: [{ role: "user", content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
      { type: "text", text: "Extract all text from this document. Return only the text content, preserving paragraph structure. No commentary." }
    ] }]
  });
  return response.content?.find(b => b.type === "text")?.text || "";
}

/* v5.64: page_number is added by migration_case_law_pages.sql. Until that has
   been run the column does not exist and PostgREST rejects the insert, so a
   first failure that names the column drops it and retries. The upload then
   still works; the draft simply carries no [p.N] markers. */
async function insertCaseLawChunks(sb, rows) {
  let withPage = true;
  for (let s = 0; s < rows.length; s += 500) {
    const slice = rows.slice(s, s + 500);
    const payload = withPage ? slice : slice.map(({ page_number, ...rest }) => rest);
    const { error } = await sb.from("case_law_chunks").insert(payload);
    if (!error) continue;
    const msg = error.message || "";
    if (withPage && /page_number/i.test(msg)) {
      console.log("case_law_chunks has no page_number column yet — storing without it. Run migrations/migration_case_law_pages.sql.");
      withPage = false;
      const { error: retryErr } = await sb.from("case_law_chunks")
        .insert(slice.map(({ page_number, ...rest }) => rest));
      if (retryErr) throw new Error(retryErr.message);
      continue;
    }
    throw new Error(msg);
  }
}

const SERVER_VERSION = "v5.24";
export default async function handler(req, res) {
  console.log(SERVER_VERSION + " library handler: " + (req.method || "?") + " " + (req.url || ""));
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  // ── GET ────────────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    const { type } = req.query;

    if (type === "case_types") {
      const { data, error } = await supabase.from("case_types")
        .select("*").eq("user_id", user.id).order("name");
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ data });
    }
    if (type === "subcats") {
      const { data, error } = await supabase.from("case_subcategories")
        .select("*").eq("user_id", user.id).order("name");
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ data });
    }
    if (type === "doc_types") {
      const { data, error } = await supabase.from("doc_types")
        .select("*").eq("user_id", user.id).order("name");
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ data });
    }
    if (type === "precedents") {
      const { data, error } = await supabase.from("precedent_docs")
        .select("*").eq("user_id", user.id).order("created_at", { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ data });
    }
    if (type === "sections") {
      const { data, error } = await supabase.from("standard_sections")
        .select("*").eq("user_id", user.id).order("title");
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ data });
    }
    if (type === "prec_chunks") {
      const { prec_id } = req.query;
      const { data, error } = await supabase.from("precedent_chunks")
        .select("content, chunk_index")
        .eq("precedent_doc_id", prec_id)
        .eq("user_id", user.id)
        .order("chunk_index");
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ data });
    }
    /* v5.24 Push A: list legislation acts (Library > Legislation) */
    if (type === "legislation") {
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data, error } = await sb.from("legislation")
        .select("id, jurisdiction, act_name, file_name, char_count, created_at")
        .eq("user_id", user.id).order("jurisdiction").order("act_name");
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ data });
    }
    /* v5.56 Push B: list case law subjects (Library > Case Law & Texts) */
    if (type === "case_law_subjects") {
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data, error } = await sb.from("case_law_subjects")
        .select("id, name, created_at")
        .eq("user_id", user.id).order("name");
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ data });
    }
    /* v5.56 Push B: list case law and textbook entries */
    if (type === "case_law") {
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data, error } = await sb.from("case_law_docs")
        .select("id, doc_type, name, citation, jurisdiction, subject_id, sub_tags, commentary, source_document_id, source_matter_id, char_count, created_at")
        .eq("user_id", user.id).order("name");
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ data });
    }
    // v2.3: Law firms list
    if (type === "law_firms") {
      const { data, error } = await supabase.from("law_firms")
        .select("*").eq("owner_id", user.id).order("name");
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ data });
    }
    return res.status(400).json({ error: "Unknown type" });
  }

  // ── DELETE ─────────────────────────────────────────────────────────────────
  if (req.method === "DELETE") {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body);
    if (!body && req.headers["content-type"]?.includes("application/json")) {
      body = await new Promise((resolve) => {
        let data = "";
        req.on("data", chunk => data += chunk);
        req.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({}); } });
      });
    }
    const { action, id } = body || {};

    if (action === "delete_case_type") {
      await supabase.from("case_types").delete().eq("id", id).eq("user_id", user.id);
      return res.status(200).json({ success: true });
    }
    if (action === "delete_precedent") {
      await supabase.from("precedent_docs").delete().eq("id", id).eq("user_id", user.id);
      return res.status(200).json({ success: true });
    }
    if (action === "delete_section") {
      await supabase.from("standard_sections").delete().eq("id", id).eq("user_id", user.id);
      return res.status(200).json({ success: true });
    }
    // v2.3: Delete individual subcat
    if (action === "delete_subcat") {
      await supabase.from("case_subcategories").delete().eq("id", id).eq("user_id", user.id);
      return res.status(200).json({ success: true });
    }
    // v2.3: Delete individual doc type
    if (action === "delete_doc_type") {
      await supabase.from("doc_types").delete().eq("id", id).eq("user_id", user.id);
      return res.status(200).json({ success: true });
    }
    // v2.3: Delete law firm
    /* v5.24 Push A: delete a legislation act (chunks cascade) */
    if (action === "delete_legislation") {
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      await sb.from("legislation").delete().eq("id", id).eq("user_id", user.id);
      return res.status(200).json({ success: true });
    }
    /* v5.56 Push B: delete a case law / textbook entry. case_law_chunks
       cascades on the case_law_id foreign key. */
    if (action === "delete_case_law") {
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { error } = await sb.from("case_law_docs").delete().eq("id", id).eq("user_id", user.id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true });
    }
    /* v5.56 Push B: delete a subject. Entries filed under it are kept -
       case_law_docs.subject_id is ON DELETE SET NULL - and show as
       Unfiled in the list. */
    if (action === "delete_case_law_subject") {
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { error } = await sb.from("case_law_subjects").delete().eq("id", id).eq("user_id", user.id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true });
    }
    if (action === "delete_law_firm") {
      await supabase.from("law_firms").delete().eq("id", id).eq("owner_id", user.id);
      return res.status(200).json({ success: true });
    }
    return res.status(400).json({ error: "Unknown action" });
  }

  // ── POST ───────────────────────────────────────────────────────────────────
  if (req.method === "POST") {
    const contentType = req.headers["content-type"] || "";

    // Multipart form upload (precedent PDF)
    if (contentType.includes("multipart/form-data")) {
      const form = formidable({ maxFileSize: 50 * 1024 * 1024 });
      const [fields, files] = await new Promise((resolve, reject) =>
        form.parse(req, (err, f, fi) => err ? reject(err) : resolve([f, fi]))
      );
      const name = Array.isArray(fields.name) ? fields.name[0] : fields.name;
      const caseTypeId = Array.isArray(fields.case_type_id) ? fields.case_type_id[0] : fields.case_type_id;
      const subcatId = Array.isArray(fields.subcategory_id) ? fields.subcategory_id[0] : fields.subcategory_id;
      const docTypeId = Array.isArray(fields.doc_type_id) ? fields.doc_type_id[0] : fields.doc_type_id;
      const jurisdiction = Array.isArray(fields.jurisdiction) ? fields.jurisdiction[0] : fields.jurisdiction;
      const description = Array.isArray(fields.description) ? fields.description[0] : fields.description;
      const file = Array.isArray(files.file) ? files.file[0] : files.file;

      if (!file) return res.status(400).json({ error: "No file uploaded" });

      const { data: precDoc, error: precErr } = await supabase.from("precedent_docs").insert({
        user_id: user.id,
        case_type_id: caseTypeId,
        subcategory_id: subcatId || null,
        doc_type_id: docTypeId || null,
        name,
        description: description || null,
        jurisdiction: jurisdiction || null,
      }).select("id").single();
      if (precErr) return res.status(500).json({ error: precErr.message });

      try {
        const text = await extractPdfText(file.filepath);
        const chunks = chunkText(text);
        const chunkRows = chunks.map((c, i) => ({
          precedent_doc_id: precDoc.id,
          user_id: user.id,
          content: c,
          chunk_index: i,
        }));
        await supabase.from("precedent_chunks").insert(chunkRows);
      } catch (e) {
        console.error("Chunk error:", e);
      }
      return res.status(201).json({ success: true, id: precDoc.id });
    }

    // JSON body actions
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body);
    if (!body && contentType.includes("application/json")) {
      body = await new Promise((resolve) => {
        let data = "";
        req.on("data", chunk => data += chunk);
        req.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({}); } });
      });
    }
    const { action } = body || {};

    /* v5.24 Push A: store a legislation act. Text is extracted in the
       BROWSER (full text - the server-side PDF extractor's 4096-token
       ceiling would silently truncate a long act) and sent as JSON.
       Fresh client inside the handler: module-scope clients can hold a
       stale schema cache that does not know newly migrated tables. */
    if (action === "create_legislation") {
      const { jurisdiction, act_name, file_name, text } = body;
      if (!jurisdiction || !act_name || !text || !text.trim()) {
        return res.status(400).json({ error: "jurisdiction, act_name and text required" });
      }
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data: leg, error: legErr } = await sb.from("legislation").insert({
        user_id: user.id,
        jurisdiction: jurisdiction,
        act_name: act_name,
        file_name: file_name || null,
        char_count: text.length,
      }).select("id").single();
      if (legErr) return res.status(500).json({ error: legErr.message });
      try {
        const chunks = chunkText(text);
        const rows = chunks.map((c, i) => ({
          legislation_id: leg.id, user_id: user.id, chunk_index: i, content: c,
        }));
        /* insert in slices of 500 rows - a long act can run to 1500+ chunks */
        for (let s = 0; s < rows.length; s += 500) {
          const { error: chErr } = await sb.from("legislation_chunks").insert(rows.slice(s, s + 500));
          if (chErr) throw new Error(chErr.message);
        }
      } catch (e) {
        await sb.from("legislation").delete().eq("id", leg.id).eq("user_id", user.id);
        return res.status(500).json({ error: "Chunk storage failed: " + e.message });
      }
      return res.status(201).json({ success: true, id: leg.id });
    }

    /* v5.62 Push D: name the judgments found in a multi-case file. The client
       detects the boundaries itself (case_law_split.js) and sends only the
       opening of each segment — a few thousand characters, not the whole
       bundle, which would not fit in a request body. Claude reads each
       opening and returns the case name, citation and jurisdiction.

       This never stores anything. The user sees the proposed names, edits
       what is wrong, and decides whether to store separate entries or one. */
    if (action === "name_case_law_segments") {
      const segments = Array.isArray(body.segments) ? body.segments : [];
      if (segments.length === 0) return res.status(400).json({ error: "segments required" });
      if (segments.length > 40) return res.status(400).json({ error: "Too many segments (max 40)" });

      const trimmed = segments.slice(0, 40).map((s, i) => ({
        index: typeof s.index === "number" ? s.index : i,
        excerpt: String(s.excerpt || "").slice(0, 3000),
      }));

      const listing = trimmed.map(seg =>
        "--- SEGMENT " + seg.index + " ---\n" + seg.excerpt
      ).join("\n\n");

      let named = [];
      try {
        const resp = await anthropic.messages.create({
          model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
          max_tokens: 4096,
          system: "You identify law reports. You are given the opening of each segment of a file that appears to hold several judgments. For each segment return the case name, the citation, and the jurisdiction, taken only from the text. Never invent a citation: if the opening does not show one, return an empty string for it.",
          messages: [{ role: "user", content:
            "For each segment below return one JSON object with keys: index (the segment number), name (the case or work name, e.g. \"Schmidt v Rosewood Trust Ltd\"), citation (e.g. \"[2003] 2 AC 709\", or \"\" if none is shown), jurisdiction (e.g. \"Cayman Islands\", \"Privy Council\", or \"\" if unclear).\n\nReturn ONLY a JSON array, no commentary and no code fence.\n\n" + listing }],
        });
        const text = resp.content?.find(b => b.type === "text")?.text || "";
        /* The model has been told not to fence the JSON, but a stray fence
           is the usual failure — strip one before parsing. */
        const cleaned = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
        const start = cleaned.indexOf("[");
        const end = cleaned.lastIndexOf("]");
        if (start !== -1 && end > start) named = JSON.parse(cleaned.slice(start, end + 1));
        if (!Array.isArray(named)) named = [];
      } catch (e) {
        /* Naming is a convenience, not a gate: hand back blanks and let the
           user type the names rather than failing the upload. */
        console.log("name_case_law_segments: " + e.message);
        named = [];
      }

      const byIndex = {};
      named.forEach(function (n) {
        if (n && typeof n.index === "number") byIndex[n.index] = n;
      });
      const out = trimmed.map(function (seg) {
        const n = byIndex[seg.index] || {};
        return {
          index: seg.index,
          name: String(n.name || "").trim(),
          citation: String(n.citation || "").trim(),
          jurisdiction: String(n.jurisdiction || "").trim(),
        };
      });
      return res.status(200).json({ segments: out, named: named.length > 0 });
    }

    /* v5.56 Push B: create a case law subject. UNIQUE (user_id, name), so a
       duplicate hands back the existing row rather than failing the caller. */
    if (action === "create_case_law_subject") {
      const name = (body.name || "").trim();
      if (!name) return res.status(400).json({ error: "name required" });
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data, error } = await sb.from("case_law_subjects")
        .insert({ user_id: user.id, name: name }).select("id").single();
      if (error) {
        const { data: existing } = await sb.from("case_law_subjects")
          .select("id").eq("user_id", user.id).eq("name", name).maybeSingle();
        if (existing) return res.status(200).json({ success: true, id: existing.id, existed: true });
        return res.status(500).json({ error: error.message });
      }
      return res.status(201).json({ success: true, id: data.id });
    }

    /* v5.56 Push B: store a case or textbook. Same shape as
       create_legislation - the text is extracted in the BROWSER (full text;
       the server-side PDF extractor's 4096-token ceiling silently truncates
       a long judgment) and posted as JSON.

       source_matter_id / source_document_id carry the dual-link: when the
       user ticks "also add to the current matter" the client uploads the
       same text through /api/upload first and passes the resulting document
       id here, so the library entry and the matter document stay tied.

       v5.57: batched, on the same contract /api/upload already uses for
       oversized files. A textbook's full text does not fit in one request -
       Vercel caps the body at 4.5 MB - so the client packs it into ~1 MB
       batches and posts them in order:
         batch 0            creates the case_law_docs row and chunks 0..n
         batch 1..total-1   append, numbering from the current max index
       Single-batch callers send no batch fields at all and behave exactly
       as before. char_count comes from total_char_count on the first batch,
       so the row records the whole document's size, not the first slice's.

       An append that fails part-way deletes the chunks it managed to insert
       before returning, so the client's retry resumes from a clean index
       rather than duplicating content. */
    if (action === "create_case_law") {
      const { name, citation, jurisdiction, subject_id, sub_tags, commentary,
              source_matter_id, source_document_id, text, pageTexts,
              batch_index, batch_total, case_law_id, total_char_count } = body;

      /* v5.64: the client sends pageTexts so each chunk can record the page it
         came from. A caller sending only `text` still works — those chunks
         simply have no page. */
      const pages = Array.isArray(pageTexts) && pageTexts.length > 0 ? pageTexts : null;
      const bodyText = pages ? pages.map(p => String((p && p.text) || "")).join("\n\n") : text;
      if (!bodyText || !bodyText.trim()) return res.status(400).json({ error: "text required" });

      const isBatched = typeof batch_total === "number" && batch_total > 1;
      const bIdx = typeof batch_index === "number" ? batch_index : 0;
      const bTotal = isBatched ? batch_total : 1;
      const isAppend = isBatched && bIdx > 0 && typeof case_law_id === "string" && case_law_id.length > 0;

      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

      /* ── Append batch ──────────────────────────────────────────────── */
      if (isAppend) {
        /* eq user_id as well as id: without it a client could append
           chunks to another user's entry by guessing a uuid. */
        const { data: existing, error: exErr } = await sb.from("case_law_docs")
          .select("id").eq("id", case_law_id).eq("user_id", user.id).maybeSingle();
        if (exErr) return res.status(500).json({ error: exErr.message });
        if (!existing) return res.status(404).json({ error: "Case law entry not found for append" });

        const { data: maxRows, error: mErr } = await sb.from("case_law_chunks")
          .select("chunk_index").eq("case_law_id", case_law_id)
          .order("chunk_index", { ascending: false }).limit(1);
        if (mErr) return res.status(500).json({ error: mErr.message });
        const baseIndex = (maxRows && maxRows.length > 0) ? (maxRows[0].chunk_index || 0) + 1 : 0;

        const source = pages ? chunkPages(pages) : chunkText(bodyText).map(c => ({ content: c, page_number: null }));
        const rows = source.map((c, i) => ({
          case_law_id: case_law_id, user_id: user.id, chunk_index: baseIndex + i,
          content: c.content, page_number: c.page_number,
        }));
        try {
          await insertCaseLawChunks(sb, rows);
        } catch (e) {
          /* Undo this batch's partial insert so a retry starts clean. */
          await sb.from("case_law_chunks").delete()
            .eq("case_law_id", case_law_id).eq("user_id", user.id).gte("chunk_index", baseIndex);
          return res.status(500).json({
            error: "Chunk storage failed: " + e.message,
            id: case_law_id, batchIndex: bIdx, batchTotal: bTotal,
          });
        }
        const complete = bIdx === bTotal - 1;
        if (complete && typeof total_char_count === "number" && total_char_count > 0) {
          await sb.from("case_law_docs")
            .update({ char_count: total_char_count }).eq("id", case_law_id).eq("user_id", user.id);
        }
        return res.status(200).json({
          success: true, id: case_law_id, chunks: rows.length,
          batchIndex: bIdx, batchTotal: bTotal, complete: complete,
        });
      }

      /* ── First batch, or the single-POST happy path ────────────────── */
      const docType = body.doc_type === "textbook" ? "textbook" : "case";
      if (!name || !name.trim()) return res.status(400).json({ error: "name required" });

      /* sub_tags is text[]. Accept either an array or a comma-separated
         string from the free-text field, and drop blanks. */
      let tags = Array.isArray(sub_tags) ? sub_tags
               : (typeof sub_tags === "string" ? sub_tags.split(",") : []);
      tags = tags.map(t => String(t).trim()).filter(Boolean);

      /* Only accept a matter the caller can actually reach - the service key
         bypasses RLS, so the foreign key alone is not a permission check. */
      let matterId = null;
      if (source_matter_id) {
        const { data: own } = await sb.from("matters")
          .select("id").eq("id", source_matter_id).eq("owner_id", user.id).maybeSingle();
        if (own) {
          matterId = source_matter_id;
        } else {
          const { data: share } = await sb.from("matter_shares")
            .select("permission").eq("matter_id", source_matter_id).eq("user_id", user.id).maybeSingle();
          if (share) matterId = source_matter_id;
        }
        if (!matterId) return res.status(403).json({ error: "No access to that matter" });
      }

      const { data: doc, error: docErr } = await sb.from("case_law_docs").insert({
        user_id: user.id,
        doc_type: docType,
        name: name.trim(),
        citation: (citation || "").trim(),
        jurisdiction: (jurisdiction || "").trim(),
        subject_id: subject_id || null,
        sub_tags: tags,
        commentary: (commentary || "").trim(),
        source_matter_id: matterId,
        source_document_id: matterId ? (source_document_id || null) : null,
        char_count: (typeof total_char_count === "number" && total_char_count > 0)
          ? total_char_count : bodyText.length,
      }).select("id").single();
      if (docErr) return res.status(500).json({ error: docErr.message });

      try {
        const source = pages ? chunkPages(pages) : chunkText(bodyText).map(c => ({ content: c, page_number: null }));
        const rows = source.map((c, i) => ({
          case_law_id: doc.id, user_id: user.id, chunk_index: i,
          content: c.content, page_number: c.page_number,
        }));
        /* insert in slices of 500 rows - a textbook can run to thousands */
        await insertCaseLawChunks(sb, rows);
      } catch (e) {
        /* Nothing else references the row yet, so drop it whole - chunks
           cascade - and let the client start over. */
        await sb.from("case_law_docs").delete().eq("id", doc.id).eq("user_id", user.id);
        return res.status(500).json({ error: "Chunk storage failed: " + e.message });
      }
      return res.status(201).json({
        success: true, id: doc.id,
        batchIndex: bIdx, batchTotal: bTotal, complete: !isBatched,
      });
    }

    if (action === "create_case_type") {
      const { name, jurisdiction, description, subcats = [], docTypes = [] } = body;
      const { data: ct, error } = await supabase.from("case_types").insert({
        user_id: user.id, name, jurisdiction: jurisdiction || null, description: description || null,
      }).select("id").single();
      if (error) return res.status(500).json({ error: error.message });
      if (subcats.length) {
        await supabase.from("case_subcategories").insert(
          subcats.map(s => ({ user_id: user.id, case_type_id: ct.id, name: s }))
        );
      }
      if (docTypes.length) {
        await supabase.from("doc_types").insert(
          docTypes.map(d => ({ user_id: user.id, case_type_id: ct.id, name: d }))
        );
      }
      return res.status(201).json({ success: true, id: ct.id });
    }

    // v2.3: Create individual subcat
    if (action === "create_subcat") {
      const { name, case_type_id } = body;
      if (!name || !case_type_id) return res.status(400).json({ error: "Name and case_type_id required" });
      const { data, error } = await supabase.from("case_subcategories").insert({
        user_id: user.id, case_type_id, name
      }).select("id").single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json({ success: true, id: data.id });
    }

    // v2.3: Create individual doc type
    if (action === "create_doc_type") {
      const { name, case_type_id } = body;
      if (!name || !case_type_id) return res.status(400).json({ error: "Name and case_type_id required" });
      const { data, error } = await supabase.from("doc_types").insert({
        user_id: user.id, case_type_id, name
      }).select("id").single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json({ success: true, id: data.id });
    }

    // v2.3: Create law firm
    if (action === "create_law_firm") {
      const { name } = body;
      if (!name) return res.status(400).json({ error: "Name required" });
      const { data, error } = await supabase.from("law_firms").insert({
        owner_id: user.id, name
      }).select("id").single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json({ success: true, id: data.id });
    }

    // v2.3: Update precedent (save changes from Library 5-box panel)
    if (action === "update_precedent") {
      const { id, case_type_id, subcat_id, doc_type_id, commentary, is_own_style, ai_instructions, context_relationship, party } = body;
      if (!id) return res.status(400).json({ error: "Precedent id required" });
      const updates = {};
      if (case_type_id !== undefined) updates.case_type_id = case_type_id;
      if (subcat_id !== undefined) updates.subcategory_id = subcat_id;
      if (doc_type_id !== undefined) updates.doc_type_id = doc_type_id;
      if (commentary !== undefined) updates.commentary = commentary;
      if (is_own_style !== undefined) updates.is_own_style = is_own_style;
      if (ai_instructions !== undefined) updates.ai_instructions = ai_instructions;
      if (context_relationship !== undefined) updates.context_relationship = context_relationship;
      if (party !== undefined) updates.party = party;
      const { error } = await supabase.from("precedent_docs")
        .update(updates).eq("id", id).eq("user_id", user.id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true });
    }

    // v2.3: Create precedent (JSON, no file — for quick-add from library panel)
    if (action === "create_precedent") {
      const { name, case_type_id, jurisdiction } = body;
      if (!name || !case_type_id) return res.status(400).json({ error: "Name and case_type_id required" });
      const { data, error } = await supabase.from("precedent_docs").insert({
        user_id: user.id, name, case_type_id, jurisdiction: jurisdiction || null
      }).select("id").single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json({ success: true, id: data.id });
    }

    if (action === "create_section") {
      const { title, content, case_type_id, subcategory_id, doc_type_id, notes } = body;
      const { data: sec, error } = await supabase.from("standard_sections").insert({
        user_id: user.id, title, content,
        case_type_id: case_type_id || null,
        subcategory_id: subcategory_id || null,
        doc_type_id: doc_type_id || null,
        notes: notes || null,
      }).select("id").single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json({ success: true, id: sec.id });
    }

    // Fetch library content for drafting (called by tools.js)
    if (action === "get_for_draft") {
      const { case_type_id, subcategory_id, doc_type_id } = body;
      const [secRes, precRes] = await Promise.all([
        supabase.from("standard_sections").select("*")
          .eq("user_id", user.id)
          .or(`case_type_id.eq.${case_type_id},case_type_id.is.null`)
          .limit(10),
        supabase.from("precedent_docs").select("id, name, description, is_own_style, ai_instructions, commentary")
          .eq("user_id", user.id)
          .eq("case_type_id", case_type_id)
          .limit(5),
      ]);
      const sections = secRes.data || [];
      const precedents = precRes.data || [];
      let precText = "";
      if (precedents.length) {
        const { data: chunks } = await supabase.from("precedent_chunks")
          .select("content, chunk_index")
          .eq("precedent_doc_id", precedents[0].id)
          .order("chunk_index").limit(40);
        precText = (chunks || []).map(c => c.content).join("\n\n");
      }
      return res.status(200).json({ sections, precedents, precText });
    }

    return res.status(400).json({ error: "Unknown action" });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
