/* ═══════════════════════════════════════════════════════════════════════════════
   ELJ v5.0 — api/folders.js
   ═══════════════════════════════════════════════════════════════════════════════
   Manages document folders for matters. Folders are per-matter and many-to-many
   with documents (a document can sit in multiple folders, or none).

   Endpoints:
     GET    /api/folders?matter_id=...      List folders for a matter, with
                                            document_count per folder.
     POST   /api/folders                    Create a folder. Body: {matter_id,name}
                                            Also upserts user_folder_defaults.
     PATCH  /api/folders?id=...             Rename a folder. Body: {name}
                                            Does NOT touch user_folder_defaults.
     DELETE /api/folders?id=...             Delete a folder. Cascades document_folders
                                            join rows; documents become uncategorised
                                            if not in any other folder.

     GET    /api/folders?action=defaults    Per-user folder name suggestion list,
                                            ordered by last_used_at DESC.

     POST   /api/folders?action=assign      Replace a document's folder set.
                                            Body: {document_id, folder_ids: [...]}
                                            Idempotent.

   Authorisation: callers must have access to the matter via canAccessMatter
   (own or shared). Edit operations require canEdit.
   ═══════════════════════════════════════════════════════════════════════════════ */

import { createClient } from "@supabase/supabase-js";

/* v4.2j lesson: fresh client per invocation in any function running after a
   schema migration — the module-scope client caches the PostgREST schema and
   will not see the new tables until the next cold start. */
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

/* Look up the matter_id for a folder_id, for permission checks. */
async function folderMatterId(supabase, folderId) {
  const { data, error } = await supabase.from("folders").select("matter_id").eq("id", folderId).single();
  if (error || !data) return null;
  return data.matter_id;
}

/* Look up the matter_id for a document_id, for permission checks. */
async function documentMatterId(supabase, documentId) {
  const { data, error } = await supabase.from("documents").select("matter_id").eq("id", documentId).single();
  if (error || !data) return null;
  return data.matter_id;
}

export default async function handler(req, res) {
  const supabase = freshClient();
  const user = await getUser(req, supabase);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  try {
    const action = req.query.action || null;

    /* ── GET /api/folders?action=defaults ───────────────────────────────── */
    if (req.method === "GET" && action === "defaults") {
      const { data, error } = await supabase
        .from("user_folder_defaults")
        .select("name, last_used_at")
        .eq("user_id", user.id)
        .order("last_used_at", { ascending: false });
      if (error) throw error;
      return res.status(200).json({ defaults: (data || []).map(function (r) { return r.name; }) });
    }

    /* ── GET /api/folders?matter_id=... ─────────────────────────────────── */
    if (req.method === "GET") {
      const matterId = req.query.matter_id;
      if (!matterId) return res.status(400).json({ error: "matter_id required" });
      const { access } = await canAccessMatter(supabase, user.id, matterId);
      if (!access) return res.status(403).json({ error: "Access denied" });

      /* Pull folders for this matter */
      const { data: folders, error: foldersErr } = await supabase
        .from("folders")
        .select("id, name, sort_order, created_at")
        .eq("matter_id", matterId)
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true });
      if (foldersErr) throw foldersErr;

      /* Pull document counts per folder via the join table.
         We fetch all join rows for these folder ids in one query, then count
         in JS — Supabase JS client does not give a clean group-by count. */
      const folderIds = (folders || []).map(function (f) { return f.id; });
      let counts = {};
      if (folderIds.length > 0) {
        const { data: joinRows, error: joinErr } = await supabase
          .from("document_folders")
          .select("folder_id")
          .in("folder_id", folderIds);
        if (joinErr) throw joinErr;
        for (const row of (joinRows || [])) {
          counts[row.folder_id] = (counts[row.folder_id] || 0) + 1;
        }
      }

      const enriched = (folders || []).map(function (f) {
        return {
          id: f.id,
          name: f.name,
          sort_order: f.sort_order,
          created_at: f.created_at,
          document_count: counts[f.id] || 0
        };
      });
      return res.status(200).json({ folders: enriched });
    }

    /* ── POST /api/folders?action=assign ────────────────────────────────── */
    if (req.method === "POST" && action === "assign") {
      const { document_id, folder_ids } = req.body || {};
      if (!document_id || !Array.isArray(folder_ids)) {
        return res.status(400).json({ error: "document_id and folder_ids[] required" });
      }
      const matterId = await documentMatterId(supabase, document_id);
      if (!matterId) return res.status(404).json({ error: "Document not found" });
      const { canEdit } = await canAccessMatter(supabase, user.id, matterId);
      if (!canEdit) return res.status(403).json({ error: "No edit permission" });

      /* Validate that every supplied folder_id belongs to the same matter,
         to prevent cross-matter assignment. */
      if (folder_ids.length > 0) {
        const { data: validFolders, error: vfErr } = await supabase
          .from("folders")
          .select("id, matter_id")
          .in("id", folder_ids);
        if (vfErr) throw vfErr;
        for (const f of (validFolders || [])) {
          if (f.matter_id !== matterId) {
            return res.status(400).json({ error: "Folder " + f.id + " is not in the same matter as the document" });
          }
        }
        if ((validFolders || []).length !== folder_ids.length) {
          return res.status(400).json({ error: "One or more folder_ids not found" });
        }
      }

      /* Replace the document's folder set: delete all existing rows for this
         document, then insert the new set. Last-write-wins. */
      const { error: delErr } = await supabase.from("document_folders").delete().eq("document_id", document_id);
      if (delErr) throw delErr;

      if (folder_ids.length > 0) {
        const rows = folder_ids.map(function (fid) {
          return { document_id: document_id, folder_id: fid };
        });
        const { error: insErr } = await supabase.from("document_folders").insert(rows);
        if (insErr) throw insErr;
      }

      return res.status(200).json({ success: true, document_id: document_id, folder_ids: folder_ids });
    }

    /* ── POST /api/folders ──────────────────────────────────────────────── */
    if (req.method === "POST") {
      const { matter_id, name } = req.body || {};
      if (!matter_id || !name || !name.trim()) {
        return res.status(400).json({ error: "matter_id and name required" });
      }
      const cleanName = name.trim();
      const { canEdit } = await canAccessMatter(supabase, user.id, matter_id);
      if (!canEdit) return res.status(403).json({ error: "No edit permission" });

      /* Insert the folder. UNIQUE (matter_id, name) prevents duplicates. */
      const { data: folder, error: insErr } = await supabase
        .from("folders")
        .insert({ matter_id: matter_id, name: cleanName })
        .select()
        .single();
      if (insErr) {
        /* Postgres unique violation = 23505. PostgREST surfaces it as a 409
           or as a generic error message — handle by message text. */
        if (insErr.code === "23505" || (insErr.message || "").indexOf("duplicate") !== -1) {
          return res.status(409).json({ error: "A folder with that name already exists in this matter" });
        }
        throw insErr;
      }

      /* Upsert user_folder_defaults so the suggestion list grows organically. */
      const { error: defErr } = await supabase
        .from("user_folder_defaults")
        .upsert(
          { user_id: user.id, name: cleanName, last_used_at: new Date().toISOString() },
          { onConflict: "user_id,name" }
        );
      if (defErr) {
        /* Non-fatal — folder was created successfully, the suggestion list
           upsert is a nice-to-have. Log and continue. */
        console.log("v5.0 user_folder_defaults upsert failed:", defErr.message);
      }

      return res.status(201).json({ folder: folder });
    }

    /* ── PATCH /api/folders?id=... ──────────────────────────────────────── */
    if (req.method === "PATCH") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: "id required" });
      const { name } = req.body || {};
      if (!name || !name.trim()) return res.status(400).json({ error: "name required" });
      const cleanName = name.trim();

      const matterId = await folderMatterId(supabase, id);
      if (!matterId) return res.status(404).json({ error: "Folder not found" });
      const { canEdit } = await canAccessMatter(supabase, user.id, matterId);
      if (!canEdit) return res.status(403).json({ error: "No edit permission" });

      const { error } = await supabase.from("folders").update({ name: cleanName }).eq("id", id);
      if (error) {
        if (error.code === "23505" || (error.message || "").indexOf("duplicate") !== -1) {
          return res.status(409).json({ error: "A folder with that name already exists in this matter" });
        }
        throw error;
      }
      return res.status(200).json({ success: true });
    }

    /* ── DELETE /api/folders?id=... ─────────────────────────────────────── */
    if (req.method === "DELETE") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: "id required" });

      const matterId = await folderMatterId(supabase, id);
      if (!matterId) return res.status(404).json({ error: "Folder not found" });
      const { canEdit } = await canAccessMatter(supabase, user.id, matterId);
      if (!canEdit) return res.status(403).json({ error: "No edit permission" });

      /* document_folders join rows cascade automatically via FK ON DELETE CASCADE.
         Documents themselves are NOT deleted. */
      const { error } = await supabase.from("folders").delete().eq("id", id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
