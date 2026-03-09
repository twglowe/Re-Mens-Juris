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

  // ── GET ───────────────────────────────────────────────────────────────────
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
    return res.status(400).json({ error: "Unknown type" });
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (req.method === "DELETE") {
    let body = await new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error("Invalid JSON")); } });
      req.on("error", reject);
    });
    const { action, id } = body;
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
    return res.status(400).json({ error: "Unknown action" });
  }

  // ── POST ──────────────────────────────────────────────────────────────────
  if (req.method === "POST") {
    const contentType = req.headers["content-type"] || "";

    if (contentType.includes("multipart/form-data")) {
      const form = formidable({ maxFileSize: 50 * 1024 * 1024 });
      const [fields, files] = await new Promise((resolve, reject) =>
        form.parse(req, (err, f, fi) => err ? reject(err) : resolve([f, fi]))
      );

      const name               = Array.isArray(fields.name) ? fields.name[0] : fields.name;
      const caseTypeId         = Array.isArray(fields.case_type_id) ? fields.case_type_id[0] : fields.case_type_id;
      const subcatId           = Array.isArray(fields.subcategory_id) ? fields.subcategory_id[0] : fields.subcategory_id;
      const docTypeId          = Array.isArray(fields.doc_type_id) ? fields.doc_type_id[0] : fields.doc_type_id;
      const jurisdiction       = Array.isArray(fields.jurisdiction) ? fields.jurisdiction[0] : fields.jurisdiction;
      const description        = Array.isArray(fields.description) ? fields.description[0] : fields.description;
      const contextRelationship= Array.isArray(fields.context_relationship) ? fields.context_relationship[0] : (fields.context_relationship || "");
      const contextDocId       = Array.isArray(fields.context_doc_id) ? fields.context_doc_id[0] : (fields.context_doc_id || "");
      const contextDescription = Array.isArray(fields.context_description) ? fields.context_description[0] : (fields.context_description || "");
      const aiInstructions     = Array.isArray(fields.ai_instructions) ? fields.ai_instructions[0] : (fields.ai_instructions || "");
      const isOwnStyleRaw      = Array.isArray(fields.is_own_style) ? fields.is_own_style[0] : (fields.is_own_style || "false");
      const isOwnStyle         = isOwnStyleRaw === "true";
      const file               = Array.isArray(files.file) ? files.file[0] : files.file;
      const contextFile        = Array.isArray(files.context_file) ? files.context_file[0] : (files.context_file || null);

      if (!file) return res.status(400).json({ error: "No file uploaded" });

      // If a context file was uploaded, insert it first
      let resolvedContextDocId = contextDocId || null;
      if (contextFile) {
        const { data: ctxDoc } = await supabase.from("precedent_docs").insert({
          user_id: user.id,
          case_type_id: caseTypeId,
          name: contextDescription || ("Context for " + name),
          description: contextDescription || null,
          jurisdiction: jurisdiction || null,
        }).select("id").single();
        if (ctxDoc) {
          resolvedContextDocId = ctxDoc.id;
          try {
            const ctxText = await extractPdfText(contextFile.filepath);
            const ctxChunks = chunkText(ctxText);
            await supabase.from("precedent_chunks").insert(
              ctxChunks.map((c, i) => ({ precedent_doc_id: ctxDoc.id, user_id: user.id, content: c, chunk_index: i }))
            );
          } catch(e) { console.error("Context chunk error:", e); }
        }
      }

      const { data: precDoc, error: precErr } = await supabase.from("precedent_docs").insert({
        user_id: user.id,
        case_type_id: caseTypeId,
        subcategory_id: subcatId || null,
        doc_type_id: docTypeId || null,
        name,
        description: description || null,
        jurisdiction: jurisdiction || null,
        context_relationship: contextRelationship || null,
        context_doc_id: resolvedContextDocId || null,
        context_description: contextDescription || null,
        ai_instructions: aiInstructions || null,
        is_own_style: isOwnStyle,
      }).select("id").single();

      if (precErr) return res.status(500).json({ error: precErr.message });

      try {
        const text = await extractPdfText(file.filepath);
        const chunks = chunkText(text);
        await supabase.from("precedent_chunks").insert(
          chunks.map((c, i) => ({ precedent_doc_id: precDoc.id, user_id: user.id, content: c, chunk_index: i }))
        );
      } catch (e) { console.error("Chunk error:", e); }

      return res.status(201).json({ success: true, id: precDoc.id });
    }

    // JSON body actions
    let body = await new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error("Invalid JSON body")); } });
      req.on("error", reject);
    });
    const { action } = body;

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

    if (action === "add_to_case_type") {
      const { id, name, jurisdiction, description, subcats = [], docTypes = [] } = body;
      await supabase.from("case_types").update({
        name, jurisdiction: jurisdiction || null, description: description || null,
      }).eq("id", id).eq("user_id", user.id);
      if (subcats.length) {
        await supabase.from("case_subcategories").insert(
          subcats.map(s => ({ user_id: user.id, case_type_id: id, name: s }))
        );
      }
      if (docTypes.length) {
        await supabase.from("doc_types").insert(
          docTypes.map(d => ({ user_id: user.id, case_type_id: id, name: d }))
        );
      }
      return res.status(200).json({ success: true });
    }

    if (action === "update_section") {
      const { id, title, content, case_type_id, subcategory_id, doc_type_id, notes } = body;
      const { error } = await supabase.from("standard_sections").update({
        title, content,
        case_type_id: case_type_id || null,
        subcategory_id: subcategory_id || null,
        doc_type_id: doc_type_id || null,
        notes: notes || null,
      }).eq("id", id).eq("user_id", user.id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true });
    }

    if (action === "update_precedent_meta") {
      const { id, name, case_type_id, subcategory_id, doc_type_id, jurisdiction, description } = body;
      const { error } = await supabase.from("precedent_docs").update({
        name,
        case_type_id: case_type_id || null,
        subcategory_id: subcategory_id || null,
        doc_type_id: doc_type_id || null,
        jurisdiction: jurisdiction || null,
        description: description || null,
      }).eq("id", id).eq("user_id", user.id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true });
    }

    if (action === "create_section") {
      const { title, content, case_type_id, subcategory_id, doc_type_id, notes } = body;
      const { data: sec, error } = await supabase.from("standard_sections").insert({
        user_id: user.id,
        title, content,
        case_type_id: case_type_id || null,
        subcategory_id: subcategory_id || null,
        doc_type_id: doc_type_id || null,
        notes: notes || null,
      }).select("id").single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json({ success: true, id: sec.id });
    }

    if (action === "get_precedent_chunks") {
      const { precedent_ids = [] } = body;
      if (!precedent_ids.length) return res.status(200).json({ results: [] });
      const results = [];
      for (const pid of precedent_ids.slice(0, 5)) {
        const { data: prec } = await supabase.from("precedent_docs")
          .select("id, name, description, context_relationship, context_doc_id, context_description")
          .eq("id", pid).eq("user_id", user.id).single();
        if (!prec) continue;
        const { data: chunks } = await supabase.from("precedent_chunks")
          .select("content, chunk_index")
          .eq("precedent_doc_id", pid)
          .order("chunk_index").limit(60);
        const text = (chunks || []).map(c => c.content).join("\n\n");
        let contextText = "";
        if (prec.context_doc_id) {
          const { data: ctxChunks } = await supabase.from("precedent_chunks")
            .select("content, chunk_index")
            .eq("precedent_doc_id", prec.context_doc_id)
            .order("chunk_index").limit(30);
          contextText = (ctxChunks || []).map(c => c.content).join("\n\n");
        }
        results.push({
          id: prec.id,
          name: prec.name,
          text,
          contextRelationship: prec.context_relationship,
          contextText,
          contextDescription: prec.context_description,
        });
      }
      return res.status(200).json({ results });
    }

    if (action === "get_for_draft") {
      const { case_type_id, subcategory_id, doc_type_id } = body;
      const [secRes, precRes] = await Promise.all([
        supabase.from("standard_sections").select("*")
          .eq("user_id", user.id)
          .or("case_type_id.eq." + case_type_id + ",case_type_id.is.null")
          .limit(10),
        supabase.from("precedent_docs").select("id, name, description")
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
