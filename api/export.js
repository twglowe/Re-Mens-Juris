/* EX LIBRIS JURIS v3.4.1 — export.js
   Generates a Word-compatible .doc file using HTML format.
   This avoids the docx npm package which crashes on some Vercel deployments.
   Word opens .doc HTML files natively with full formatting. */

export const config = { maxDuration: 30 };

function esc(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function markdownToHtml(text) {
  var lines = (text || "").split("\n");
  var html = "";
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = line.trim();

    if (trimmed.startsWith("#### ")) {
      html += "<h4>" + inlineFmt(esc(trimmed.slice(5))) + "</h4>\n";
    } else if (trimmed.startsWith("### ")) {
      html += "<h3>" + inlineFmt(esc(trimmed.slice(4))) + "</h3>\n";
    } else if (trimmed.startsWith("## ")) {
      html += "<h2>" + inlineFmt(esc(trimmed.slice(3))) + "</h2>\n";
    } else if (trimmed.startsWith("# ")) {
      html += "<h1>" + inlineFmt(esc(trimmed.slice(2))) + "</h1>\n";
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("• ")) {
      html += "<ul><li>" + inlineFmt(esc(trimmed.slice(2))) + "</li></ul>\n";
    } else if (/^\d+\.\s/.test(trimmed)) {
      html += "<ol><li>" + inlineFmt(esc(trimmed.replace(/^\d+\.\s/, ""))) + "</li></ol>\n";
    } else if (trimmed.startsWith("> ")) {
      html += '<blockquote style="border-left:3px solid #1d6fa4;padding-left:12px;color:#2d5070;font-style:italic">' + inlineFmt(esc(trimmed.slice(2))) + "</blockquote>\n";
    } else if (trimmed.includes("\u26A0\uFE0F")) {
      html += '<p style="background:#fff8e1;padding:8px 12px;color:#7a6020;font-style:italic;font-size:10pt">' + inlineFmt(esc(trimmed)) + "</p>\n";
    } else if (trimmed === "") {
      html += "<p>&nbsp;</p>\n";
    } else {
      html += "<p>" + inlineFmt(esc(trimmed)) + "</p>\n";
    }
  }
  return html;
}

function inlineFmt(text) {
  /* Bold: **text** */
  text = text.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  /* Italic: *text* */
  text = text.replace(/\*([^*]+)\*/g, "<i>$1</i>");
  return text;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  var body = req.body || {};
  var content = body.content;
  var matterName = body.matterName || "Matter";
  var jurisdiction = body.jurisdiction || "Bermuda";
  var title = body.title || matterName;

  if (!content) return res.status(400).json({ error: "No content provided" });

  try {
    var dateStr = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

    var htmlDoc = '<!DOCTYPE html>\n'
      + '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">\n'
      + "<head>\n"
      + '<meta charset="utf-8">\n'
      + "<title>" + esc(title) + "</title>\n"
      + "<style>\n"
      + "  @page { size: A4; margin: 2.5cm 2.5cm 2.5cm 2.5cm; }\n"
      + "  body { font-family: Georgia, 'Times New Roman', serif; font-size: 11pt; color: #0f2744; line-height: 1.5; }\n"
      + "  h1 { font-size: 16pt; color: #0f2744; margin-top: 24pt; margin-bottom: 8pt; }\n"
      + "  h2 { font-size: 14pt; color: #0f2744; margin-top: 20pt; margin-bottom: 6pt; border-bottom: 1px solid #c5ddf0; padding-bottom: 4pt; }\n"
      + "  h3 { font-size: 12pt; color: #1a3a5c; margin-top: 16pt; margin-bottom: 4pt; }\n"
      + "  h4 { font-size: 11pt; color: #5a7a94; margin-top: 12pt; margin-bottom: 4pt; }\n"
      + "  p { margin-top: 0; margin-bottom: 6pt; }\n"
      + "  ul, ol { margin-top: 0; margin-bottom: 6pt; }\n"
      + "  .header { text-align: center; margin-bottom: 24pt; padding-bottom: 12pt; border-bottom: 2px solid #c5ddf0; }\n"
      + "  .header h1 { border-bottom: none; }\n"
      + "  .meta { font-size: 9pt; color: #5a7a94; text-align: center; margin-bottom: 24pt; }\n"
      + "</style>\n"
      + "</head>\n"
      + "<body>\n"
      + '<div class="header">\n'
      + "  <h1>Ex Libris Juris \u2014 Legal Analysis</h1>\n"
      + "  <p><b>" + esc(matterName) + "</b></p>\n"
      + "</div>\n"
      + '<p class="meta">Jurisdiction: ' + esc(jurisdiction) + " &nbsp;|&nbsp; Date: " + esc(dateStr) + "</p>\n"
      + markdownToHtml(content)
      + "\n</body>\n</html>";

    var buffer = Buffer.from(htmlDoc, "utf-8");
    var safeName = (title || matterName || "analysis").replace(/[^a-z0-9]/gi, "-").toLowerCase();

    res.setHeader("Content-Type", "application/msword");
    res.setHeader("Content-Disposition", 'attachment; filename="' + safeName + '.doc"');
    res.setHeader("Content-Length", buffer.length);
    return res.status(200).send(buffer);
  } catch (err) {
    console.error("Export error:", err);
    return res.status(500).json({ error: err.message });
  }
}
