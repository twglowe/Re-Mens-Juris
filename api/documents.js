import { createClient } from "@supabase/supabase-js";

/* v5.3: serverVersion marker per the v5.2b Lambda-pinning lesson. Every
   response stamps this so the client (and a console-side curl) can verify
   which version of this Lambda is actually live. */
const SERVER_VERSION = "v5.4a";

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
  console.log("documents " + SERVER_VERSION + " handler: " + req.method + " " + (req.query?.id || req.query?.matter_id || ""));
  const supabase = freshClient();
  const user = await getUser(req, supabase);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  try {
    if (req.method === "GET") {
      const { matter_id, doc_name } = req.query;
      const { access } = await canAccessMatter(supabase, user.id, matter_id);
      if (!access) return res.status(403).json({ error: "Access denied" });

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
         v5.4: SELECT * naturally pulls the new file_size and doc_date
         columns once the migration has run. */
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
      return res.status(200).json({ documents: enriched, serverVersion: SERVER_VERSION });
    }

    /* v5.0: PATCH /api/documents?id=... — edit description and/or folder set.
       v5.3: also accepts doc_type. */
    if (req.method === "PATCH") {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: "id required" });
      const body = req.body || {};

      const { data: doc } = await supabase.from("documents").select("matter_id").eq("id", id).single();
      if (!doc) return res.status(404).json({ error: "Document not found" });
      const { canEdit } = await canAccessMatter(supabase, user.id, doc.matter_id);
      if (!canEdit) return res.status(403).json({ error: "No edit permission" });

      if (body.description !== undefined) {
        const desc = String(body.description || "");
        const { error } = await supabase.from("documents").update({ description: desc }).eq("id", id);
        if (error) throw error;
      }

      /* v5.4a: rename document. Cascades to chunks.document_name so
         source-passage lookups by name keep working. Both updates run
         sequentially — if the chunks update fails after the document
         update succeeded, the document row is rolled back to the old name. */
      if (body.name !== undefined) {
        const newName = String(body.name || "").trim();
        if (!newName) return res.status(400).json({ error: "Filename cannot be empty" });
        /* Get the old name first so we can roll back on cascade failure */
        const { data: existing, error: exErr } = await supabase.from("documents").select("name").eq("id", id).single();
        if (exErr) throw exErr;
        const oldName = existing.name;
        if (newName !== oldName) {
          const { error: nErr } = await supabase.from("documents").update({ name: newName }).eq("id", id);
          if (nErr) throw nErr;
          const { error: cErr } = await supabase.from("chunks").update({ document_name: newName }).eq("document_id", id);
          if (cErr) {
            /* Best-effort rollback of the documents row */
            await supabase.from("documents").update({ name: oldName }).eq("id", id);
            throw cErr;
          }
        }
      }

      /* v5.3: update doc_type if provided. */
      if (body.doc_type !== undefined) {
        const dt = String(body.doc_type || "").trim();
        if (dt) {
          const { error: dtErr } = await supabase.from("documents").update({ doc_type: dt }).eq("id", id);
          if (dtErr) throw dtErr;
        }
      }

      if (Array.isArray(body.folder_ids)) {
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

      return res.status(200).json({ success: true, serverVersion: SERVER_VERSION });
    }

    if (req.method === "DELETE") {
      const { id } = req.query;
      const { data: doc } = await supabase.from("documents").select("matter_id").eq("id", id).single();
      if (!doc) return res.status(404).json({ error: "Document not found" });
      const { canEdit } = await canAccessMatter(supabase, user.id, doc.matter_id);
      if (!canEdit) return res.status(403).json({ error: "You do not have edit permission" });
      await supabase.from("chunks").delete().eq("document_id", id);
      await supabase.from("documents").delete().eq("id", id);
      const { count } = await supabase.from("documents").select("*", { count: "exact", head: true }).eq("matter_id", doc.matter_id);
      await supabase.from("matters").update({ document_count: count || 0 }).eq("id", doc.matter_id);
      return res.status(200).json({ success: true, serverVersion: SERVER_VERSION });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
