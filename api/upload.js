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
  const { matterId, fileName, fileData, docType } = req.body;
  if (!matterId || !fileName || !fileData) return res.status(400).json({ error: "Missing fields" });
  const allowed = await canEdit(user.id, matterId);
  if (!allowed) return res.status(403).json({ error: "No edit permission" });

  try {
    const buffer = Buffer.from(fileData, "base64");
    let extractedText = "";
    try {
      const parsed = await pdfParse(buffer);
      extractedText = parsed.text || "";
    } catch (e) {
      return res.status(400).json({ error: "Could not read this PDF. It may be password-protected or a scanned image. Please use ilovepdf.com to OCR it first." });
    }
    if (!extractedText || extractedText.trim().length < 50) {
      return res.status(400).json({ error: "No readable text found. This PDF may be a scanned image — please OCR it first at ilovepdf.com." });
    }
    const { data: doc, error: docError } = await supabase.from("documents")
      .insert({ matter_id: matterId, name: fileName, doc_type: docType || "Other", char_count: extractedText.length, chunk_count: 0 })
      .select().single();
    if (docError) throw docError;
    const chunks = chunkText(extractedText);
    const chunkRows = chunks.map((text, index) => ({
      matter_id: matterId, document_id: doc.id, document_name: fileName,
      doc_type: docType || "Other", chunk_index: index, content: text,
    }));
    for (let i = 0; i < chunkRows.length; i += 50) {
      const { error } = await supabase.from("chunks").insert(chunkRows.slice(i, i + 50));
      if (error) throw error;
    }
    await supabase.from("documents").update({ chunk_count: chunks.length }).eq("id", doc.id);
    const { count } = await supabase.from("documents").select("*", { count: "exact", head: true }).eq("matter_id", matterId);
    await supabase.from("matters").update({ document_count: count || 0 }).eq("id", matterId);
    return res.status(200).json({ success: true, documentId: doc.id, chunks: chunks.length, characters: extractedText.length });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Upload failed" });
  }
}
