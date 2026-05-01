/* EX LIBRIS JURIS v5.12b — index-library.js
   Bulk fingerprinter + status endpoint for the Library tab "Index N
   documents" button. Three actions:

     GET  /api/index-library?action=status
       Returns counts of documents owned by the user, broken down as:
         total, indexed_relevant, indexed_not_relevant, failed, unindexed
       The frontend polls this every few seconds while indexing.

     POST /api/index-library  body={action:"index"}  or  {action:"retry"}
       Kicks off a sequential pass over all unindexed (and failed-with-retry)
       documents owned by the user.

     POST /api/index-library  body={action:"mark_not_relevant", documentId:"..."}
       v5.12b: flip a failed (or any) row to indexed-but-not-relevant. The
       row stays in the table but is_relevant=false, failed=false. The AI
       hunt in Build 3 ignores rows where is_relevant=false.

     POST /api/index-library  body={action:"retry_one", documentId:"..."}
       v5.12b: retry a single document by id. Used by the per-row Retry
       link in the Show details panel.

   v5.12b: added is_relevant bucket to status; new actions mark_not_relevant
           and retry_one.
   v5.12a: created. */

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 360 };

const SERVER_VERSION = "v5.12b";
const TIME_LIMIT_MS = 300000;

function freshClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

async function getUser(req, supabase) {
  var token = req.headers.authorization ? req.headers.authorization.replace("Bearer ", "") : "";
  if (!token) return null;
  try {
    var resp = await supabase.auth.getUser(token);
    if (resp.error || !resp.data || !resp.data.user) return null;
    return resp.data.user;
  } catch (e) {
    return null;
  }
}

/* Fetch all matters owned by this user (we do NOT include shared matters in
   the count — sharing is for collaboration on a single matter, not for
   borrowing fingerprints across users). Returns array of matter ids. */
async function getOwnedMatterIds(supabase, userId) {
  var resp = await supabase
    .from("matters")
    .select("id")
    .eq("owner_id", userId);
  if (resp.error) throw new Error("Could not load matters: " + resp.error.message);
  return (resp.data || []).map(function(m) { return m.id; });
}

/* v5.12b: verify a document belongs to a matter owned by this user.
   Returns {id, matter_id, name} on success, null on no access. */
async function checkDocAccess(supabase, userId, documentId) {
  var resp = await supabase
    .from("documents")
    .select("id, matter_id, name, matters!inner(owner_id)")
    .eq("id", documentId)
    .single();
  if (resp.error || !resp.data) return null;
  var ownerId = resp.data.matters && resp.data.matters.owner_id;
  if (ownerId === userId) {
    return { id: resp.data.id, matter_id: resp.data.matter_id, name: resp.data.name };
  }
  var shareResp = await supabase
    .from("matter_shares")
    .select("permission")
    .eq("matter_id", resp.data.matter_id)
    .eq("user_id", userId)
    .single();
  if (shareResp.data && shareResp.data.permission === "edit") {
    return { id: resp.data.id, matter_id: resp.data.matter_id, name: resp.data.name };
  }
  return null;
}

/* v5.12b: flip a document to indexed-but-not-relevant. Counted as
   indexed; AI hunt in Build 3 ignores rows where is_relevant=false. */
async function markNotRelevant(supabase, userId, documentId) {
  var doc = await checkDocAccess(supabase, userId, documentId);
  if (!doc) return { ok: false, error: "Document not found or no access" };
  await supabase.from("document_fingerprints").delete().eq("document_id", documentId);
  var insertResp = await supabase.from("document_fingerprints").insert({
    document_id: doc.id,
    matter_id: doc.matter_id,
    likely_types: [],
    is_likely_bundle: false,
    structural_hint: "",
    fingerprint_version: "v1",
    failed: false,
    failure_reason: null,
    is_relevant: false,
  }).select("id").single();
  if (insertResp.error) {
    return { ok: false, error: "Could not save: " + insertResp.error.message };
  }
  return { ok: true };
}

/* v5.12b: retry a single document. Force a fresh fingerprint by
   deleting any existing row first, then call fingerprint.js. */
async function retryOne(supabase, userId, documentId, hostUrl) {
  var doc = await checkDocAccess(supabase, userId, documentId);
  if (!doc) return { ok: false, error: "Document not found or no access" };
  var internalSecret = process.env.FINGERPRINT_INTERNAL_SECRET || "";
  if (!internalSecret) {
    return { ok: false, error: "FINGERPRINT_INTERNAL_SECRET env var is not set." };
  }
  await supabase.from("document_fingerprints").delete().eq("document_id", documentId);
  try {
    var fpUrl = hostUrl + "/api/fingerprint?documentId=" + documentId;
    var fpRespHttp = await fetch(fpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": internalSecret,
      },
    });
    var fpJson = await fpRespHttp.json();
    if (fpJson && fpJson.ok) {
      return { ok: true, status: "fingerprinted" };
    }
    return { ok: false, error: (fpJson && fpJson.reason) || "Retry failed", reason: fpJson && fpJson.reason };
  } catch (e) {
    return { ok: false, error: e.message || "Retry failed" };
  }
}

/* Status: count documents and their fingerprint status across all owned
   matters. Single round-trip with two queries: documents owned (to get the
   total) and fingerprint rows for those documents (to bucket them).
   v5.12b: split fingerprinted into indexed_relevant + indexed_not_relevant. */
async function getStatus(supabase, userId) {
  var matterIds = await getOwnedMatterIds(supabase, userId);
  if (matterIds.length === 0) {
    return { total: 0, indexed_relevant: 0, indexed_not_relevant: 0, failed: 0, unindexed: 0, failures: [] };
  }

  var docsResp = await supabase
    .from("documents")
    .select("id, matter_id, name")
    .in("matter_id", matterIds);
  if (docsResp.error) throw new Error("Could not load documents: " + docsResp.error.message);
  var docs = docsResp.data || [];
  var total = docs.length;
  if (total === 0) {
    return { total: 0, indexed_relevant: 0, indexed_not_relevant: 0, failed: 0, unindexed: 0, failures: [] };
  }

  var docIds = docs.map(function(d) { return d.id; });

  /* Supabase IN clauses cap somewhere around 1000 entries. We're well below
     that today (135) but split into chunks of 500 just in case. */
  var fpRows = [];
  for (var i = 0; i < docIds.length; i += 500) {
    var slice = docIds.slice(i, i + 500);
    var fpResp = await supabase
      .from("document_fingerprints")
      .select("document_id, failed, failure_reason, is_relevant")
      .in("document_id", slice);
    if (fpResp.error) throw new Error("Could not load fingerprints: " + fpResp.error.message);
    fpRows = fpRows.concat(fpResp.data || []);
  }

  var fpMap = {};
  for (var f = 0; f < fpRows.length; f++) {
    fpMap[fpRows[f].document_id] = fpRows[f];
  }

  /* Matter-name lookup for failure list */
  var matterNameMap = {};
  var matterResp = await supabase
    .from("matters")
    .select("id, name")
    .in("id", matterIds);
  if (matterResp.data) {
    for (var mi = 0; mi < matterResp.data.length; mi++) {
      matterNameMap[matterResp.data[mi].id] = matterResp.data[mi].name;
    }
  }

  var indexedRelevant = 0;
  var indexedNotRelevant = 0;
  var failed = 0;
  var unindexed = 0;
  var failures = [];
  for (var d = 0; d < docs.length; d++) {
    var doc = docs[d];
    var fp = fpMap[doc.id];
    if (!fp) {
      unindexed++;
    } else if (fp.failed) {
      failed++;
      failures.push({
        document_id: doc.id,
        document_name: doc.name,
        matter_name: matterNameMap[doc.matter_id] || "(unknown matter)",
        reason: fp.failure_reason || "Unknown reason.",
      });
    } else if (fp.is_relevant === false) {
      indexedNotRelevant++;
    } else {
      indexedRelevant++;
    }
  }

  return {
    total: total,
    indexed_relevant: indexedRelevant,
    indexed_not_relevant: indexedNotRelevant,
    failed: failed,
    unindexed: unindexed,
    failures: failures,
  };
}

/* Run the pass: fingerprint every unindexed document, optionally retry
   failed ones too (controlled by retryFailed param).

   We call fingerprint.js as a same-deployment HTTP call rather than
   importing its handler directly. Why: keeping the boundary HTTP means
   the auth/permission/idempotency guarantees are exactly the same whether
   the call comes from upload.js, from index-library.js, or from a future
   test harness. The shared-secret header gates server-to-server use. */
async function runPass(supabase, userId, hostUrl, retryFailed) {
  var startTime = Date.now();
  var matterIds = await getOwnedMatterIds(supabase, userId);
  if (matterIds.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0, timed_out: false };
  }

  var docsResp = await supabase
    .from("documents")
    .select("id, matter_id")
    .in("matter_id", matterIds);
  if (docsResp.error) throw new Error("Could not load documents: " + docsResp.error.message);
  var docs = docsResp.data || [];
  var docIds = docs.map(function(d) { return d.id; });
  if (docIds.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0, timed_out: false };
  }

  /* Find which need work. */
  var fpRows = [];
  for (var i = 0; i < docIds.length; i += 500) {
    var slice = docIds.slice(i, i + 500);
    var fpResp = await supabase
      .from("document_fingerprints")
      .select("document_id, failed")
      .in("document_id", slice);
    if (fpResp.error) throw new Error("Could not load fingerprints: " + fpResp.error.message);
    fpRows = fpRows.concat(fpResp.data || []);
  }
  var fpMap = {};
  for (var f = 0; f < fpRows.length; f++) {
    fpMap[fpRows[f].document_id] = fpRows[f];
  }

  var queue = [];
  for (var d = 0; d < docs.length; d++) {
    var fp = fpMap[docs[d].id];
    if (!fp) {
      queue.push(docs[d].id);
    } else if (fp.failed && retryFailed) {
      queue.push(docs[d].id);
    }
  }

  if (queue.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0, timed_out: false };
  }

  console.log("v5.12a index-library: pass starting, queue size " + queue.length + ", retryFailed=" + retryFailed);

  var internalSecret = process.env.FINGERPRINT_INTERNAL_SECRET || "";
  if (!internalSecret) {
    throw new Error("FINGERPRINT_INTERNAL_SECRET env var is not set. Configure it in Vercel before running the indexer.");
  }

  var processed = 0;
  var succeeded = 0;
  var failedCount = 0;
  var timedOut = false;

  for (var q = 0; q < queue.length; q++) {
    if (Date.now() - startTime > TIME_LIMIT_MS) {
      timedOut = true;
      console.log("v5.12a index-library: time limit reached after " + processed + " documents, " + (queue.length - processed) + " remaining");
      break;
    }
    var docId = queue[q];
    try {
      var fpUrl = hostUrl + "/api/fingerprint?documentId=" + docId;
      var fpRespHttp = await fetch(fpUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": internalSecret,
        },
      });
      var fpJson = await fpRespHttp.json();
      processed++;
      if (fpJson && fpJson.ok) {
        succeeded++;
      } else {
        failedCount++;
        console.log("v5.12a index-library: doc " + docId + " failed: " + (fpJson && fpJson.reason));
      }
    } catch (e) {
      processed++;
      failedCount++;
      console.log("v5.12a index-library: doc " + docId + " threw: " + (e.message || e));
    }
  }

  return {
    processed: processed,
    succeeded: succeeded,
    failed: failedCount,
    timed_out: timedOut,
  };
}

export default async function handler(req, res) {
  console.log(SERVER_VERSION + " index-library handler: " + (req.method || "?") + " " + (req.url || ""));

  var supabase = freshClient();
  var user = await getUser(req, supabase);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  var action = req.query.action || (req.body && req.body.action) || "status";

  try {
    if (action === "status") {
      var status = await getStatus(supabase, user.id);
      return res.status(200).json({ ok: true, status: status, serverVersion: SERVER_VERSION });
    }

    if (action === "index" || action === "retry") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
      var hostUrl = "https://" + req.headers.host;
      var retryFailed = (action === "retry") || (req.body && req.body.retryFailed === true);
      var result = await runPass(supabase, user.id, hostUrl, retryFailed);
      return res.status(200).json({ ok: true, result: result, serverVersion: SERVER_VERSION });
    }

    /* v5.12b: per-row actions from the Show details panel. */
    if (action === "mark_not_relevant") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
      var docId1 = req.body && req.body.documentId;
      if (!docId1) return res.status(400).json({ error: "documentId required" });
      var mr = await markNotRelevant(supabase, user.id, docId1);
      if (!mr.ok) return res.status(400).json({ error: mr.error });
      return res.status(200).json({ ok: true, serverVersion: SERVER_VERSION });
    }

    if (action === "retry_one") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
      var docId2 = req.body && req.body.documentId;
      if (!docId2) return res.status(400).json({ error: "documentId required" });
      var hostUrl2 = "https://" + req.headers.host;
      var ro = await retryOne(supabase, user.id, docId2, hostUrl2);
      if (!ro.ok) return res.status(400).json({ error: ro.error, reason: ro.reason });
      return res.status(200).json({ ok: true, status: ro.status, serverVersion: SERVER_VERSION });
    }

    return res.status(400).json({ error: "Unknown action: " + action });
  } catch (e) {
    console.error("index-library error:", e);
    return res.status(500).json({ error: e.message || "Indexer failed" });
  }
}
