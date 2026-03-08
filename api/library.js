import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import formidable from "formidable";
import fs from "fs";

export const config = { maxDuration: 120, api: { bodyParser: false } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function getUser(req) {
  // Try Bearer token first, then form field
  const authHeader = req.headers.authorization?.replace("Bearer ", "");
  if (authHeader) {
    const { data: { user }, error } = await supabase.auth.getUser(authHeader);
    if (!error && user) return user;
  }
  return null;
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
  // Use same approach as upload.js — send PDF to Claude for text extraction
  const pdfBuffer = fs.readFileSync(filePath);
  const base64 = pdfBuffer.toString("base64");
  const response = await anthropic.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 4096,
    messages: [{
      role: "user",
      content: [{
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: base64 }
      }, {
        type: "text",
        text: "Extract all text from this document. Return only the text content, preserving paragraph structure. No commentary."
      }]
    }]
  });
  return response.content?.find(b => b.type === "text")?.text || "";
}

export default async function handler(req, res) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  // ── GET — fetch library data ──────────────────────────────────────────────
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

    // Fetch chunks for a precedent doc
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

    return res.status(400).json({ error: "Unknown type" });
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (req.method === "DELETE") {
    let body = await new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(new Error("Invalid JSON body")); }
      });
      req.on("error", reject);
    });
    const { action, id } = body;

    if (action === "delete_case_type") {
      // Cascade deletes subcats, doc_types, precedent_docs (chunks cascade from there), sections
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
    return res.status(400).json({ error: "Unknown action" });
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  if (req.method === "POST") {
    // Check content type to decide how to parse
    const contentType = req.headers["content-type"] || "";

    if (contentType.includes("multipart/form-data")) {
      // Precedent document upload
      const form = formidable({ maxFileSize: 50 * 1024 * 1024 });
      const [fields, files] = await new Promise((resolve, reject) =>
        form.parse(req, (err, f, fi) => err ? reject(err) : resolve([f, fi]))
      );

      const name        = Array.isArray(fields.name) ? fields.name[0] : fields.name;
      const caseTypeId  = Array.isArray(fields.case_type_id) ? fields.case_type_id[0] : fields.case_type_id;
      const subcatId    = Array.isArray(fields.subcategory_id) ? fields.subcategory_id[0] : fields.subcategory_id;
      const docTypeId   = Array.isArray(fields.doc_type_id) ? fields.doc_type_id[0] : fields.doc_type_id;
      const jurisdiction= Array.isArray(fields.jurisdiction) ? fields.jurisdiction[0] : fields.jurisdiction;
      const description = Array.isArray(fields.description) ? fields.description[0] : fields.description;
      const file        = Array.isArray(files.file) ? files.file[0] : files.file;

      if (!file) return res.status(400).json({ error: "No file uploaded" });

      // Insert precedent doc record
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

      // Extract text and chunk it
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
        // Don't fail — doc record exists, chunks can be retried
      }

      return res.status(201).json({ success: true, id: precDoc.id });
    }

    // JSON body actions — bodyParser is disabled so read raw stream
    let body = await new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(new Error("Invalid JSON body")); }
      });
      req.on("error", reject);
    });
    const { action } = body;


    if (action === "add_to_case_type") {
      const { id, name, jurisdiction, description, subcats = [], docTypes = [] } = body;
      // Update case type name/description if changed
      await supabase.from("case_types").update({
        name, jurisdiction: jurisdiction || null, description: description || null,
      }).eq("id", id).eq("user_id", user.id);
      // Insert new subcategories
      if (subcats.length) {
        await supabase.from("case_subcategories").insert(
          subcats.map(s => ({ user_id: user.id, case_type_id: id, name: s }))
        );
      }
      // Insert new doc types
      if (docTypes.length) {
        await supabase.from("doc_types").insert(
          docTypes.map(d => ({ user_id: user.id, case_type_id: id, name: d }))
        );
      }
      return res.status(200).json({ success: true });
    }

        if (action === "create_case_type") {
      const { name, jurisdiction, description, subcats = [], docTypes = [] } = body;
      const { data: ct, error } = await supabase.from("case_types").insert({
        user_id: user.id, name, jurisdiction: jurisdiction || null, description: description || null,
      }).select("id").single();
      if (error) return res.status(500).json({ error: error.message });

      // Insert subcategories
      if (subcats.length) {
        await supabase.from("case_subcategories").insert(
          subcats.map(s => ({ user_id: user.id, case_type_id: ct.id, name: s }))
        );
      }
      // Insert doc types
      if (docTypes.length) {
        await supabase.from("doc_types").insert(
          docTypes.map(d => ({ user_id: user.id, case_type_id: ct.id, name: d }))
        );
      }
      return res.status(201).json({ success: true, id: ct.id });
    }

    if (action === "create_section") {
      const { title, content, case_type_id, subcategory_id, doc_type_id, notes } = body;
      const { data: sec, error } = await supabase.from("standard_sections").insert({
        user_id: user.id,
        title,
        content,
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
        supabase.from("precedent_docs").select("id, name, description")
          .eq("user_id", user.id)
          .eq("case_type_id", case_type_id)
          .limit(5),
      ]);
      const sections = secRes.data || [];
      const precedents = precRes.data || [];
      // Fetch chunks for first precedent doc
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
