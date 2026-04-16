import { createClient } from "@supabase/supabase-js";
export const config = { maxDuration: 30 };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const SERVER_VERSION = "v5.5";
export default async function handler(req, res) {
  console.log(SERVER_VERSION + " library_fetch handler: " + (req.method || "?") + " " + (req.url || ""));
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const auth = req.headers.authorization?.replace("Bearer ", "");
  if (!auth) return res.status(401).json({ error: "Unauthorised" });

  const { data: { user }, error: authErr } = await supabase.auth.getUser(auth);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorised" });

  const action = req.query.action || req.body?.action;

  try {
    // All case types for this user
    if (action === "getCaseTypes") {
      const { data, error } = await supabase
        .from("case_types")
        .select("id, name")
        .eq("user_id", user.id)
        .order("name");
      if (error) throw error;
      return res.json({ caseTypes: data || [] });
    }

    // Subcategories for a case type
    if (action === "getSubcategories") {
      const caseTypeId = req.query.caseTypeId || req.body?.caseTypeId;
      const { data, error } = await supabase
        .from("case_subcategories")
        .select("id, name")
        .eq("user_id", user.id)
        .eq("case_type_id", caseTypeId)
        .order("name");
      if (error) throw error;
      return res.json({ subcategories: data || [] });
    }

    // Doc types for a case type
    if (action === "getDocTypes") {
      const caseTypeId = req.query.caseTypeId || req.body?.caseTypeId;
      const { data, error } = await supabase
        .from("doc_types")
        .select("id, name")
        .eq("user_id", user.id)
        .eq("case_type_id", caseTypeId)
        .order("name");
      if (error) throw error;
      return res.json({ docTypes: data || [] });
    }

    // Matching sections and precedents for draft context
    if (action === "getDraftContext") {
      const caseTypeId   = req.query.caseTypeId   || req.body?.caseTypeId;
      const subcategoryId= req.query.subcategoryId || req.body?.subcategoryId;
      const docTypeId    = req.query.docTypeId     || req.body?.docTypeId;

      // Standard sections for this case type
      let secQ = supabase
        .from("standard_sections")
        .select("id, title, content, doc_type_id")
        .eq("user_id", user.id);
      if (caseTypeId) {
        secQ = secQ.or(`case_type_id.eq.${caseTypeId},case_type_id.is.null`);
      }
      if (docTypeId) {
        secQ = secQ.or(`doc_type_id.eq.${docTypeId},doc_type_id.is.null`);
      }
      const { data: sections } = await secQ.order("title").limit(50);

      // Precedent docs for this case type
      let precQ = supabase
        .from("precedent_docs")
        .select("id, name, description, doc_type_id, subcategory_id")
        .eq("user_id", user.id);
      if (caseTypeId)    precQ = precQ.eq("case_type_id", caseTypeId);
      if (subcategoryId) precQ = precQ.eq("subcategory_id", subcategoryId);
      if (docTypeId)     precQ = precQ.eq("doc_type_id", docTypeId);
      const { data: precedents } = await precQ.order("name").limit(20);

      return res.json({ sections: sections || [], precedents: precedents || [] });
    }

    // Chunks for a specific precedent doc
    if (action === "getPrecedentChunks") {
      const docId = req.query.docId || req.body?.docId;
      const { data, error } = await supabase
        .from("precedent_chunks")
        .select("content, chunk_index")
        .eq("precedent_doc_id", docId)
        .eq("user_id", user.id)
        .order("chunk_index")
        .limit(200);
      if (error) throw error;
      return res.json({ text: (data || []).map(c => c.content).join("\n\n") });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error("library_fetch error:", err);
    return res.status(500).json({ error: err.message });
  }
}
