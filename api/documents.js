import { createClient } from "@supabase/supabase-js";

/* v4.2j lesson: fresh client per invocation in any function running after a
   schema migration — module-scope clients cache the PostgREST schema. */
function freshClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

async function getUser(req, supabase) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  return error ? null : user;
}

async function canAccessMatter(supabase, userId, matterId) {
  const { data: own } = await supabase.from("matters").select("id").eq("id", matterId).eq("owner_id", userId).single();
  if (own) return { access: true, canEdit: true };
  const { data: share } = await supabase.from("matter_shares").select("permission").eq("matter_id", matterId).eq("user_id", userId).single();
  if (share) return { access: true, canEdit: share.permission === "edit" };
  return { access: false, canEdit: false };
}

export default async function handler(req, res) {
  const supabase = freshClient();
  const user = await getUser(req, supabase);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  try {
    if (req.method === "GET") {
      const { matter_id, doc_name } = req.query;
      const { access } = await canAccessMatter(supabase, user.id, matter_id);
      if (!access) return res.status(403).json({ error: "Access denied" });

      // If doc_name provided, return chunks for source passage panel
      if (doc_name) {
        const { data, error } = await supabase.from("chunks")
          .select("content, chunk_index")
          .eq("matter_id", matter_id)
          .eq("document_name", doc_name)
          .order("chunk_index", { ascending: true })
          .limit(500);
        if (error) throw error;
        return res.status(200).json({ chunks: data || [] });
      }

      /* v5.0: return document list including description and folder_ids.
         Two queries — documents, then document_folders for those documents —
         then merge in JS. */
      const { data: docs, error: docsErr } = await supabase.from("documents")
        .select("*").eq("matter_id", matter_id)
        .order("created_at", { ascending: false });
      if (docsErr) throw docsErr;

      const docIds = (docs || []).map(function (d) { return d.id; });
      let folderMap = {};
      if (docIds.length > 0) {
        const { data: joinRows, error: joinErr } = await supabase
          .from("document_folders")
          .select("document_id, folder_id")
          .in("document_id", docIds);
        if (joinErr) throw joinErr;
        for (const row of (joinRows || [])) {
          if (!folderMap[row.document_id]) folderMap[row.document_id] = [];
          folderMap[row.document_id].push(row.folder_id);
        }
      }

      const enriched = (docs || []).map(function (d) {
        return Object.assign({}, d, { folder_ids: folderMap[d.id] || [] });
      });
      return res.status(200).json({ documents: enriched });
    }

    /* v5.0: PATCH /api/documents?id=... — edit description and/or folder set.
       Body: { description?: string, folder_ids?: string[] }
       folder_ids replaces the document's folder set entirely (idempotent). */
    if (req.method === "PATCH") {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: "id required" });
      const body = req.body || {};

      const { data: doc } = await supabase.from("documents").select("matter_id").eq("id", id).single();
      if (!doc) return res.status(404).json({ error: "Document not found" });
      const { canEdit } = await canAccessMatter(supabase, user.id, doc.matter_id);
      if (!canEdit) return res.status(403).json({ error: "No edit permission" });

      /* Update description if provided */
      if (body.description !== undefined) {
        const desc = String(body.description || "");
        const { error } = await supabase.from("documents").update({ description: desc }).eq("id", id);
        if (error) throw error;
      }

      /* Replace folder set if provided */
      if (Array.isArray(body.folder_ids)) {
        /* Validate all folder ids belong to the same matter */
        if (body.folder_ids.length > 0) {
          const { data: validFolders, error: vfErr } = await supabase
            .from("folders")
            .select("id, matter_id")
            .in("id", body.folder_ids);
          if (vfErr) throw vfErr;
          for (const f of (validFolders || [])) {
            if (f.matter_id !== doc.matter_id) {
              return res.status(400).json({ error: "Folder " + f.id + " is not in the same matter as the document" });
            }
          }
          if ((validFolders || []).length !== body.folder_ids.length) {
            return res.status(400).json({ error: "One or more folder_ids not found" });
          }
        }

        const { error: delErr } = await supabase.from("document_folders").delete().eq("document_id", id);
        if (delErr) throw delErr;

        if (body.folder_ids.length > 0) {
          const rows = body.folder_ids.map(function (fid) {
            return { document_id: id, folder_id: fid };
          });
          const { error: insErr } = await supabase.from("document_folders").insert(rows);
          if (insErr) throw insErr;
        }
      }

      return res.status(200).json({ success: true });
    }

    if (req.method === "DELETE") {
      const { id } = req.query;
      const { data: doc } = await supabase.from("documents").select("matter_id").eq("id", id).single();
      if (!doc) return res.status(404).json({ error: "Document not found" });
      const { canEdit } = await canAccessMatter(supabase, user.id, doc.matter_id);
      if (!canEdit) return res.status(403).json({ error: "You do not have edit permission" });
      await supabase.from("chunks").delete().eq("document_id", id);
      /* document_folders join rows cascade automatically via FK ON DELETE CASCADE */
      await supabase.from("documents").delete().eq("id", id);
      const { count } = await supabase.from("documents").select("*", { count: "exact", head: true }).eq("matter_id", doc.matter_id);
      await supabase.from("matters").update({ document_count: count || 0 }).eq("id", doc.matter_id);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
