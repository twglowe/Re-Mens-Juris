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
    messages: [{ role: "user", content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
      { type: "text", text: "Extract all text from this document. Return only the text content, preserving paragraph structure. No commentary." }
    ] }]
  });
  return response.content?.find(b => b.type === "text")?.text || "";
}

const SERVER_VERSION = "v5.5";
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
