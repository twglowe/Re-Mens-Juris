/* ═══════════════════════════════════════════════════════════════════════════════
   ELJ v5.7b — api/precedent_folders.js
   ═══════════════════════════════════════════════════════════════════════════════
   Manages folders for Library precedents. Folders are per-user (the Library
   itself is per-user) and many-to-many with precedents (a precedent can sit
   in multiple folders, or none).

   Endpoints:
     GET    /api/precedent_folders          List folders for the current user,
                                            with precedent_count per folder.
     POST   /api/precedent_folders          Create a folder. Body: {name}
     PATCH  /api/precedent_folders?id=...   Rename a folder. Body: {name}
     DELETE /api/precedent_folders?id=...   Delete a folder. Cascades the join
                                            rows; precedents become unfoldered
                                            if not in any other folder.

     POST   /api/precedent_folders?action=assign
                                            Replace a precedent's folder set.
                                            Body: {precedent_id, folder_ids: [...]}
                                            Idempotent (last-write-wins).

   Permission model: precedents are per-user; no sharing. Every operation
   checks user ownership via user_id (matching the precedent_docs convention).
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

/* Confirm a folder belongs to the current user, for permission checks. */
async function folderOwnerId(supabase, folderId) {
  const { data, error } = await supabase
    .from("precedent_folders")
    .select("user_id")
    .eq("id", folderId)
    .single();
  if (error || !data) return null;
  return data.user_id;
}

/* Confirm a precedent belongs to the current user, for permission checks. */
async function precedentOwnerId(supabase, precedentId) {
  const { data, error } = await supabase
    .from("precedent_docs")
    .select("user_id")
    .eq("id", precedentId)
    .single();
  if (error || !data) return null;
  return data.user_id;
}

const SERVER_VERSION = "v5.7b";
export default async function handler(req, res) {
  console.log(SERVER_VERSION + " precedent_folders handler: " + (req.method || "?") + " " + (req.url || ""));
  const supabase = freshClient();
  const user = await getUser(req, supabase);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  try {
    const action = req.query.action || null;

    /* ── GET /api/precedent_folders ─────────────────────────────────────── */
    if (req.method === "GET") {
      /* Pull folders for this user */
      const { data: folders, error: foldersErr } = await supabase
        .from("precedent_folders")
        .select("id, name, sort_order, created_at")
        .eq("user_id", user.id)
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true });
      if (foldersErr) throw foldersErr;

      /* Pull precedent counts per folder via the join table.
         We fetch all join rows for these folder ids in one query, then count
         in JS — Supabase JS client does not give a clean group-by count. */
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

      /* Confirm the precedent belongs to the current user. */
      const precOwner = await precedentOwnerId(supabase, precedent_id);
      if (!precOwner) return res.status(404).json({ error: "Precedent not found" });
      if (precOwner !== user.id) return res.status(403).json({ error: "Access denied" });

      /* Validate that every supplied folder_id belongs to the same user,
         to prevent cross-user assignment. */
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

      /* Replace the precedent's folder set: delete all existing rows for this
         precedent, then insert the new set. Last-write-wins. */
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
      const { name } = req.body || {};
      if (!name || !name.trim()) {
        return res.status(400).json({ error: "name required" });
      }
      const cleanName = name.trim();

      /* Insert the folder. UNIQUE (user_id, name) prevents duplicates. */
      const { data: folder, error: insErr } = await supabase
        .from("precedent_folders")
        .insert({ user_id: user.id, name: cleanName })
        .select()
        .single();
      if (insErr) {
        /* Postgres unique violation = 23505. PostgREST surfaces it as a 409
           or as a generic error message — handle by message text too. */
        if (insErr.code === "23505" || (insErr.message || "").indexOf("duplicate") !== -1) {
          return res.status(409).json({ error: "A folder with that name already exists" });
        }
        throw insErr;
      }

      return res.status(201).json({ folder: folder });
    }

    /* ── PATCH /api/precedent_folders?id=... ────────────────────────────── */
    if (req.method === "PATCH") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: "id required" });
      const { name } = req.body || {};
      if (!name || !name.trim()) return res.status(400).json({ error: "name required" });
      const cleanName = name.trim();

      const ownerId = await folderOwnerId(supabase, id);
      if (!ownerId) return res.status(404).json({ error: "Folder not found" });
      if (ownerId !== user.id) return res.status(403).json({ error: "Access denied" });

      const { error } = await supabase
        .from("precedent_folders")
        .update({ name: cleanName })
        .eq("id", id);
      if (error) {
        if (error.code === "23505" || (error.message || "").indexOf("duplicate") !== -1) {
          return res.status(409).json({ error: "A folder with that name already exists" });
        }
        throw error;
      }
      return res.status(200).json({ success: true });
    }

    /* ── DELETE /api/precedent_folders?id=... ───────────────────────────── */
    if (req.method === "DELETE") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: "id required" });

      const ownerId = await folderOwnerId(supabase, id);
      if (!ownerId) return res.status(404).json({ error: "Folder not found" });
      if (ownerId !== user.id) return res.status(403).json({ error: "Access denied" });

      /* precedent_folder_assignments rows cascade automatically via
         FK ON DELETE CASCADE. Precedents themselves are NOT deleted. */
      const { error } = await supabase.from("precedent_folders").delete().eq("id", id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
