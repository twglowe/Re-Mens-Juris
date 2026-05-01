/* EX LIBRIS JURIS v5.12a — index-library.js
   Bulk fingerprinter + status endpoint for the Library tab "Index N
   documents" button. Two actions:

     GET  /api/index-library?action=status
       Returns counts of documents owned by the user, broken down as:
         total, fingerprinted, failed, unindexed, in_progress
       The frontend polls this every few seconds while indexing.

     POST /api/index-library  body={action:"index"}
       Kicks off a sequential pass over all unindexed (and failed-with-retry)
       documents owned by the user. Calls fingerprint.js once per document,
       internally, with the shared secret. Returns when the whole pass is
       done OR when the elapsed-time guard fires (300s, leaving 60s margin
       below Vercel's 360s limit for this endpoint).
       Idempotent — pressing Index twice runs the pass again; failed
       documents get retried; already-fingerprinted documents are skipped
       at the fingerprint.js level.

   This endpoint deliberately does NOT use a tool_jobs row. The whole pass
   is short-lived and the frontend can poll the status endpoint to get a
   live count. If a pass times out, the next press of the button picks up
   from where the last one stopped (because every successful row reduces
   the unindexed count).

   v5.12a: created. */

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 360 };

const SERVER_VERSION = "v5.12a";
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

/* Status: count documents and their fingerprint status across all owned
   matters. Single round-trip with two queries: documents owned (to get the
   total) and fingerprint rows for those documents (to bucket them). */
async function getStatus(supabase, userId) {
  var matterIds = await getOwnedMatterIds(supabase, userId);
  if (matterIds.length === 0) {
    return { total: 0, fingerprinted: 0, failed: 0, unindexed: 0, failures: [] };
  }

  var docsResp = await supabase
    .from("documents")
    .select("id, matter_id, name")
    .in("matter_id", matterIds);
  if (docsResp.error) throw new Error("Could not load documents: " + docsResp.error.message);
  var docs = docsResp.data || [];
  var total = docs.length;
  if (total === 0) {
    return { total: 0, fingerprinted: 0, failed: 0, unindexed: 0, failures: [] };
  }

  var docIds = docs.map(function(d) { return d.id; });

  /* Supabase IN clauses cap somewhere around 1000 entries. We're well below
     that today (135) but split into chunks of 500 just in case. */
  var fpRows = [];
  for (var i = 0; i < docIds.length; i += 500) {
    var slice = docIds.slice(i, i + 500);
    var fpResp = await supabase
      .from("document_fingerprints")
      .select("document_id, failed, failure_reason")
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

  var fingerprinted = 0;
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
    } else {
      fingerprinted++;
    }
  }

  return {
    total: total,
    fingerprinted: fingerprinted,
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

    return res.status(400).json({ error: "Unknown action: " + action });
  } catch (e) {
    console.error("index-library error:", e);
    return res.status(500).json({ error: e.message || "Indexer failed" });
  }
}
