import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

export const config = { maxDuration: 300, api: { bodyParser: { sizeLimit: "50mb" } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
  const chunks = [];
  const paragraphs = text.split(/\n\s*\n/);
  let current = "";
  for (const para of paragraphs) {
    if ((current + para).length > chunkSize && current.length > 0) {
      chunks.push(current.trim());
      current = current.slice(-overlap) + "\n\n" + para;
    } else {
      current += (current ? "\n\n" : "") + para;
    }
  }
  if (current.trim().length > 50) chunks.push(current.trim());
  const final = [];
  for (const chunk of chunks) {
    if (chunk.length <= chunkSize * 1.5) { final.push(chunk); }
    else {
      let start = 0;
      while (start < chunk.length) { final.push(chunk.slice(start, start + chunkSize)); start += chunkSize - overlap; }
    }
  }
  return final.filter(c => c.length > 50);
}

async function extractText(base64Data) {
  const response = await anthropic.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-opus-4-5",
    max_tokens: 8192,
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } },
        { type: "text", text: "Extract all text from this document exactly as it appears. Preserve paragraph structure with blank lines between paragraphs. Include all headings, numbered paragraphs, dates, names, and legal citations exactly as written. Output only the extracted text with no commentary." }
      ]
    }]
  });
  return response.content?.find(b => b.type === "text")?.text || "";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { matterId, fileName, fileData, docType } = req.body;
  if (!matterId || !fileName || !fileData) return res.status(400).json({ error: "Missing fields" });

  const allowed = await canEdit(user.id, matterId);
  if (!allowed) return res.status(403).json({ error: "You do not have edit permission for this matter" });

  try {
    const extractedText = await extractText(fileData);
    if (!extractedText || extractedText.length < 50) {
      return res.status(400).json({ error: "Could not extract text. PDF may be a scanned image — please OCR it first." });
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
