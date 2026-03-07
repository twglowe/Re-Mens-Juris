import { createClient } from "@supabase/supabase-js";
export const config = { maxDuration: 30 };

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const auth = req.headers.authorization?.replace("Bearer ", "");
  if (!auth) return res.status(401).json({ error: "Unauthorised" });

  const { data: { user }, error: authErr } = await supabase.auth.getUser(auth);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorised" });

  const action = req.method === "GET"
    ? req.query.action
    : (req.body?.action || req.query.action);

  try {
    // Get all case types for this user
    if (action === "getCaseTypes") {
      const { data, error } = await supabase
        .from("case_types")
        .select("id, name")
        .eq("owner_id", user.id)
        .order("name");
      if (error) throw error;
      return res.json({ caseTypes: data || [] });
    }

    // Get subcategories for a case type
    if (action === "getSubcategories") {
      const caseTypeId = req.query.caseTypeId || req.body?.caseTypeId;
      const { data, error } = await supabase
        .from("case_subcategories")
        .select("id, name")
        .eq("case_type_id", caseTypeId)
        .order("name");
      if (error) throw error;
      return res.json({ subcategories: data || [] });
    }

    // Get doc types for a case type (and optionally subcategory)
    if (action === "getDocTypes") {
      const caseTypeId = req.query.caseTypeId || req.body?.caseTypeId;
      const { data, error } = await supabase
        .from("doc_types")
        .select("id, name")
        .eq("case_type_id", caseTypeId)
        .order("name");
      if (error) throw error;
      return res.json({ docTypes: data || [] });
    }

    // Get matching library content for drafting
    if (action === "getDraftContext") {
      const { caseTypeId, subcategoryId, docTypeId } = req.method === "GET" ? req.query : req.body;

      // Fetch standard sections matching this case type / doc type
      let sectionsQuery = supabase
        .from("standard_sections")
        .select("id, title, content, applies_to_doc_type_id")
        .eq("owner_id", user.id);

      // Filter by case type via the tag table
      if (caseTypeId) {
        const { data: taggedIds } = await supabase
          .from("section_case_type_tags")
          .select("section_id")
          .eq("case_type_id", caseTypeId);
        const ids = (taggedIds || []).map(t => t.section_id);
        if (ids.length > 0) {
          sectionsQuery = sectionsQuery.in("id", ids);
        }
      }

      if (docTypeId) {
        sectionsQuery = sectionsQuery.or(`applies_to_doc_type_id.eq.${docTypeId},applies_to_doc_type_id.is.null`);
      }

      const { data: sections } = await sectionsQuery.order("title");

      // Fetch precedent document chunks matching this case type / doc type
      let precedentsQuery = supabase
        .from("precedent_docs")
        .select("id, title, doc_type_id, case_type_id, subcategory_id")
        .eq("owner_id", user.id);

      if (caseTypeId) precedentsQuery = precedentsQuery.eq("case_type_id", caseTypeId);
      if (subcategoryId) precedentsQuery = precedentsQuery.eq("subcategory_id", subcategoryId);
      if (docTypeId) precedentsQuery = precedentsQuery.eq("doc_type_id", docTypeId);

      const { data: precedents } = await precedentsQuery.order("title");

      return res.json({
        sections: sections || [],
        precedents: precedents || []
      });
    }

    // Get chunks for a specific precedent doc
    if (action === "getPrecedentChunks") {
      const docId = req.query.docId || req.body?.docId;
      const { data, error } = await supabase
        .from("precedent_chunks")
        .select("content, chunk_index")
        .eq("doc_id", docId)
        .order("chunk_index")
        .limit(200);
      if (error) throw error;
      const text = (data || []).map(c => c.content).join("\n\n");
      return res.json({ text });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error("library_fetch error:", err);
    return res.status(500).json({ error: err.message });
  }
}
