/* ══ v5.82 Push 3: LIST OF AUTHORITIES — the view switcher ═══════════════════
   The worker saves the alphabetical list as ordinary text, followed by the
   other two orders (by year of report; order of citation in each skeleton)
   inside one HTML comment:  <!--ELJ-AUTHORITIES-VIEWS:<base64 json>-->
   That comment must never reach the screen or a Word export, and the user
   must be able to switch order without re-running the tool — in History as
   much as on a fresh result.

   core.js calls these two from appendMsgTo when toolName is 'authorities':
     authPrepare(content)  -> the text to render and export (comment removed)
     authDecorate(w, bubble, content, title) -> adds the Order buttons under
       the bubble and re-renders it on a click; the Word button then exports
       whichever order is showing.
   Both are no-ops for a result without the comment, so an old or partial
   result still renders as plain text. Pure DOM; no state outside the
   message element. */

var AUTH_VIEW_MARKER = "<!--ELJ-AUTHORITIES-VIEWS:";

function authSplit(content) {
  var s = String(content || "");
  var at = s.indexOf(AUTH_VIEW_MARKER);
  if (at === -1) return { alpha: s, year: null, cited: null };
  var end = s.indexOf("-->", at);
  var alpha = s.slice(0, at).replace(/\s+$/, "");
  try {
    var b64 = s.slice(at + AUTH_VIEW_MARKER.length, end === -1 ? s.length : end);
    var bytes = atob(b64);
    var arr = new Uint8Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    var obj = JSON.parse(new TextDecoder("utf-8").decode(arr));
    return { alpha: alpha, year: obj.views.year || null, cited: obj.views.cited || null };
  } catch (e) {
    console.warn("v5.82 authorities: could not read the embedded views", e && e.message);
    return { alpha: alpha, year: null, cited: null };
  }
}

function authPrepare(content) {
  return authSplit(content).alpha;
}

function authDecorate(w, bubble, content, title) {
  var views = authSplit(content);
  if (!views.year && !views.cited) return;
  var orders = [["alpha", "Alphabetical"], ["year", "By year"], ["cited", "Order of citation"]];
  var bar = document.createElement("div");
  bar.className = "auth-order-bar";
  bar.style.cssText = "display:flex;align-items:center;gap:.35rem;flex-wrap:wrap;margin:.35rem 0 .1rem;font-size:.76rem;color:var(--text-faint)";
  var lab = document.createElement("span");
  lab.textContent = "Order:";
  bar.appendChild(lab);
  var current = "alpha";
  function render(key) {
    current = key;
    var text = views[key] || views.alpha;
    bubble.innerHTML = renderMdWithSourceLinks(text);
    bar.querySelectorAll("button").forEach(function (b) {
      var on = b.getAttribute("data-order") === key;
      b.style.background = on ? "var(--blue-pale)" : "var(--white)";
      b.style.color = on ? "var(--blue)" : "var(--text-mid)";
      b.style.borderColor = on ? "var(--blue-light)" : "var(--border)";
    });
  }
  orders.forEach(function (o) {
    if (!views[o[0]]) return;
    var b = document.createElement("button");
    b.type = "button";
    b.setAttribute("data-order", o[0]);
    b.textContent = o[1];
    b.style.cssText = "padding:.15rem .55rem;border:1px solid var(--border);border-radius:12px;background:var(--white);color:var(--text-mid);font-size:.74rem;font-weight:600;cursor:pointer";
    b.onclick = function () { render(o[0]); };
    bar.appendChild(b);
  });
  /* The Word button exports the order on screen. */
  var meta = w.querySelector(".msg-meta");
  if (meta) {
    meta.querySelectorAll("button.btn-dl").forEach(function (b) {
      if (/Word/.test(b.textContent)) {
        b.onclick = function () { downloadWord(views[current] || views.alpha, title || (currentMatter && currentMatter.name)); };
      }
    });
  }
  w.insertBefore(bar, bubble.nextSibling);
  render("alpha");
}

/* Node (the test) takes the pure functions through module.exports; the
   browser just gets them as globals from the script tag. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { authSplit, authPrepare, AUTH_VIEW_MARKER };
}
