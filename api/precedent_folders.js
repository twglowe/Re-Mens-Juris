/* ═══════════════════════════════════════════════════════════════════════════════
   ELJ v5.7c — api/precedent_folders.js
   ═══════════════════════════════════════════════════════════════════════════════
   Manages folders for Library precedents. Folders are per-user (the Library
   itself is per-user) and many-to-many with precedents (a precedent can sit
   in multiple folders, or none).

   v5.7c adds NESTED folder support via parent_id. Deletion is RESTRICT —
   a folder with subfolders cannot be deleted until those subfolders are
   removed or re-parented first.

   Endpoints:
     GET    /api/precedent_folders          List folders for the current user,
                                            with precedent_count per folder.
                                            Returns flat list; each folder row
                                            includes its parent_id. Client
                                            builds the tree.
     POST   /api/precedent_folders          Create a folder.
                                              Body: {name, parent_id?}
                                              parent_id omitted or null = top level.
     PATCH  /api/precedent_folders?id=...   Rename or re-parent a folder.
                                              Body: {name?, parent_id?}
                                              Omit a field to leave it unchanged.
                                              Send parent_id: null to move to top.
                                              Cycle detection prevents self-ancestry.
     DELETE /api/precedent_folders?id=...   Delete a folder.
                                              Refuses if subfolders still exist
                                              (returns 409 with a friendly error).
                                              Cascades the precedent_folder_assignments
                                              join rows automatically.

     POST   /api/precedent_folders?action=assign
                                            Replace a precedent's folder set.
                                            Body: {precedent_id, folder_ids: [...]}
                                            Idempotent (last-write-wins).

   Permission model: precedents and folders are per-user; no sharing. Every
   operation checks user ownership via user_id.
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

async function folderOwnerAndParent(supabase, folderId) {
  const { data, error } = await supabase
    .from("precedent_folders")
    .select("user_id, parent_id")
    .eq("id", folderId)
    .single();
  if (error || !data) return null;
  return data;
}

async function precedentOwnerId(supabase, precedentId) {
  const { data, error } = await supabase
    .from("precedent_docs")
    .select("user_id")
    .eq("id", precedentId)
    .single();
  if (error || !data) return null;
  return data.user_id;
}

/* Cycle detection. When a PATCH sets parent_id to newParentId for folder
   folderId, we must confirm that newParentId is not folderId itself and is
   not a descendant of folderId. We walk up the proposed parent chain; if we
   meet folderId along the way, it's a cycle.

   Also used at create time when parent_id is supplied: we confirm that the
   proposed parent belongs to the current user.

   Returns:
     { ok: true }                        safe
     { ok: false, reason: "..." }        rejected, with message
*/
async function validateParentChoice(supabase, userId, folderId, newParentId) {
  if (newParentId === null || newParentId === undefined) return { ok: true };
  if (newParentId === folderId) {
    return { ok: false, reason: "A folder cannot be its own parent" };
  }
  // Walk up. Bounded by max depth to avoid pathological corrupt chains.
  let cursor = newParentId;
  for (let i = 0; i < 64; i++) {
    const { data, error } = await supabase
      .from("precedent_folders")
      .select("id, user_id, parent_id")
      .eq("id", cursor)
      .single();
    if (error || !data) {
      return { ok: false, reason: "Parent folder not found" };
    }
    if (data.user_id !== userId) {
      return { ok: false, reason: "Parent folder not owned by current user" };
    }
    if (folderId && data.id === folderId) {
      return { ok: false, reason: "Cannot move a folder into its own descendant" };
    }
    if (!data.parent_id) return { ok: true }; // reached a top-level folder
    cursor = data.parent_id;
  }
  return { ok: false, reason: "Folder hierarchy is too deep (possible cycle)" };
}

const SERVER_VERSION = "v5.7c";
export default async function handler(req, res) {
  console.log(SERVER_VERSION + " precedent_folders handler: " + (req.method || "?") + " " + (req.url || ""));
  const supabase = freshClient();
  const user = await getUser(req, supabase);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  try {
    const action = req.query.action || null;

    /* ── GET /api/precedent_folders ─────────────────────────────────────── */
    if (req.method === "GET") {
      const { data: folders, error: foldersErr } = await supabase
        .from("precedent_folders")
        .select("id, name, parent_id, sort_order, created_at")
        .eq("user_id", user.id)
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true });
      if (foldersErr) throw foldersErr;

      const folderIds = (folders || []).map(function (f) { return f.id; });
      let counts = {};
      if (folderIds.length > 0) {
        const { data: joinRows, error: joinErr } = await supabase
          .from("precedent_folder_assignments")
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
          parent_id: f.parent_id,
          sort_order: f.sort_order,
          created_at: f.created_at,
          precedent_count: counts[f.id] || 0
        };
      });
      return res.status(200).json({ folders: enriched });
    }

    /* ── POST /api/precedent_folders?action=assign ──────────────────────── */
    if (req.method === "POST" && action === "assign") {
      const { precedent_id, folder_ids } = req.body || {};
      if (!precedent_id || !Array.isArray(folder_ids)) {
        return res.status(400).json({ error: "precedent_id and folder_ids[] required" });
      }

      const precOwner = await precedentOwnerId(supabase, precedent_id);
      if (!precOwner) return res.status(404).json({ error: "Precedent not found" });
      if (precOwner !== user.id) return res.status(403).json({ error: "Access denied" });

      if (folder_ids.length > 0) {
        const { data: validFolders, error: vfErr } = await supabase
          .from("precedent_folders")
          .select("id, user_id")
          .in("id", folder_ids);
        if (vfErr) throw vfErr;
        for (const f of (validFolders || [])) {
          if (f.user_id !== user.id) {
            return res.status(403).json({ error: "Folder " + f.id + " is not owned by the current user" });
          }
        }
        if ((validFolders || []).length !== folder_ids.length) {
          return res.status(400).json({ error: "One or more folder_ids not found" });
        }
      }

      const { error: delErr } = await supabase
        .from("precedent_folder_assignments")
        .delete()
        .eq("precedent_id", precedent_id);
      if (delErr) throw delErr;

      if (folder_ids.length > 0) {
        const rows = folder_ids.map(function (fid) {
          return { precedent_id: precedent_id, folder_id: fid };
        });
        const { error: insErr } = await supabase
          .from("precedent_folder_assignments")
          .insert(rows);
        if (insErr) throw insErr;
      }

      return res.status(200).json({ success: true, precedent_id: precedent_id, folder_ids: folder_ids });
    }

    /* ── POST /api/precedent_folders ────────────────────────────────────── */
    if (req.method === "POST") {
      const { name, parent_id } = req.body || {};
      if (!name || !name.trim()) {
        return res.status(400).json({ error: "name required" });
      }
      const cleanName = name.trim();
      const cleanParent = (parent_id === undefined || parent_id === "") ? null : parent_id;

      if (cleanParent !== null) {
        const validation = await validateParentChoice(supabase, user.id, null, cleanParent);
        if (!validation.ok) return res.status(400).json({ error: validation.reason });
      }

      const { data: folder, error: insErr } = await supabase
        .from("precedent_folders")
        .insert({ user_id: user.id, name: cleanName, parent_id: cleanParent })
        .select()
        .single();
      if (insErr) {
        if (insErr.code === "23505" || (insErr.message || "").indexOf("duplicate") !== -1) {
          return res.status(409).json({ error: "A folder with that name already exists at this level" });
        }
        throw insErr;
      }

      return res.status(201).json({ folder: folder });
    }

    /* ── PATCH /api/precedent_folders?id=... ────────────────────────────── */
    if (req.method === "PATCH") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: "id required" });
      const body = req.body || {};

      const current = await folderOwnerAndParent(supabase, id);
      if (!current) return res.status(404).json({ error: "Folder not found" });
      if (current.user_id !== user.id) return res.status(403).json({ error: "Access denied" });

      const updates = {};

      if (typeof body.name !== "undefined") {
        if (!body.name || !body.name.trim()) {
          return res.status(400).json({ error: "name cannot be empty" });
        }
        updates.name = body.name.trim();
      }

      if (typeof body.parent_id !== "undefined") {
        const newParent = body.parent_id === "" ? null : body.parent_id;
        if (newParent !== null) {
          const validation = await validateParentChoice(supabase, user.id, id, newParent);
          if (!validation.ok) return res.status(400).json({ error: validation.reason });
        }
        updates.parent_id = newParent;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "Nothing to update (supply name and/or parent_id)" });
      }

      const { error } = await supabase
        .from("precedent_folders")
        .update(updates)
        .eq("id", id);
      if (error) {
        if (error.code === "23505" || (error.message || "").indexOf("duplicate") !== -1) {
          return res.status(409).json({ error: "A folder with that name already exists at this level" });
        }
        throw error;
      }
      return res.status(200).json({ success: true });
    }

    /* ── DELETE /api/precedent_folders?id=... ───────────────────────────── */
    if (req.method === "DELETE") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: "id required" });

      const current = await folderOwnerAndParent(supabase, id);
      if (!current) return res.status(404).json({ error: "Folder not found" });
      if (current.user_id !== user.id) return res.status(403).json({ error: "Access denied" });

      /* Check for subfolders before attempting the delete — gives a clean
         400 error message rather than relying on the raw 23503. */
      const { data: kids, error: kidsErr } = await supabase
        .from("precedent_folders")
        .select("id")
        .eq("parent_id", id)
        .limit(1);
      if (kidsErr) throw kidsErr;
      if (kids && kids.length > 0) {
        return res.status(409).json({
          error: "Cannot delete — this folder contains subfolders. Delete or move them first."
        });
      }

      /* precedent_folder_assignments rows cascade automatically via
         FK ON DELETE CASCADE. Precedents themselves are NOT deleted. */
      const { error } = await supabase.from("precedent_folders").delete().eq("id", id);
      if (error) {
        if (error.code === "23503") {
          return res.status(409).json({
            error: "Cannot delete — this folder contains subfolders. Delete or move them first."
          });
        }
        throw error;
      }
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
