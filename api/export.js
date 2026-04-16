/* EX LIBRIS JURIS v3.6 — export.js
   Generates .docx files using pure JS ZIP creation.
   No npm packages, no shell commands — works on Vercel serverless. */

export const config = { maxDuration: 30 };

function esc(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function parseInline(text) {
  var runs = "";
  var parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (!p) continue;
    if (p.startsWith("**") && p.endsWith("**")) {
      runs += '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">' + esc(p.slice(2, -2)) + "</w:t></w:r>";
    } else if (p.startsWith("*") && p.endsWith("*")) {
      runs += '<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">' + esc(p.slice(1, -1)) + "</w:t></w:r>";
    } else {
      runs += '<w:r><w:t xml:space="preserve">' + esc(p) + "</w:t></w:r>";
    }
  }
  return runs;
}

function markdownToDocxXml(text, matterName, jurisdiction) {
  var dateStr = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  var body = "";

  body += '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/></w:pPr>'
    + '<w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>Ex Libris Juris</w:t></w:r></w:p>';
  body += '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>'
    + '<w:r><w:rPr><w:color w:val="1D6FA4"/><w:sz w:val="24"/></w:rPr><w:t>' + esc(matterName) + '</w:t></w:r></w:p>';
  body += '<w:p><w:pPr><w:jc w:val="center"/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="C5DDF0"/></w:pBdr><w:spacing w:after="400"/></w:pPr>'
    + '<w:r><w:rPr><w:color w:val="5A7A94"/><w:sz w:val="20"/></w:rPr><w:t>Jurisdiction: ' + esc(jurisdiction) + '   |   Date: ' + esc(dateStr) + '</w:t></w:r></w:p>';

  var lines = (text || "").split("\n");
  for (var i = 0; i < lines.length; i++) {
    var trimmed = lines[i].trim();

    if (trimmed.startsWith("#### ")) {
      body += '<w:p><w:pPr><w:pStyle w:val="Heading4"/></w:pPr>'
        + '<w:r><w:t>' + esc(trimmed.slice(5)) + '</w:t></w:r></w:p>';
    } else if (trimmed.startsWith("### ")) {
      body += '<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr>'
        + '<w:r><w:t>' + esc(trimmed.slice(4)) + '</w:t></w:r></w:p>';
    } else if (trimmed.startsWith("## ") || trimmed.startsWith("# ")) {
      body += '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr>'
        + '<w:r><w:t>' + esc(trimmed.replace(/^#+\s/, "")) + '</w:t></w:r></w:p>';
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("\u2022 ")) {
      body += '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>'
        + parseInline(trimmed.slice(2)) + '</w:p>';
    } else if (/^\d+\.\s/.test(trimmed)) {
      body += '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr>'
        + parseInline(trimmed.replace(/^\d+\.\s/, "")) + '</w:p>';
    } else if (trimmed.startsWith("> ")) {
      body += '<w:p><w:pPr><w:ind w:left="720"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="4" w:color="1D6FA4"/></w:pBdr></w:pPr>'
        + '<w:r><w:rPr><w:i/><w:color w:val="2D5070"/></w:rPr><w:t xml:space="preserve">' + esc(trimmed.slice(2)) + '</w:t></w:r></w:p>';
    } else if (trimmed.includes("\u26A0\uFE0F")) {
      body += '<w:p><w:pPr><w:shd w:val="clear" w:fill="FFF8E1"/></w:pPr>'
        + '<w:r><w:rPr><w:i/><w:color w:val="7A6020"/><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">' + esc(trimmed) + '</w:t></w:r></w:p>';
    } else if (trimmed === "") {
      body += '<w:p/>';
    } else {
      body += '<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>' + parseInline(trimmed) + '</w:p>';
    }
  }

  return body;
}

function buildDocxFiles(bodyXml) {
  var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + '</Types>';

  var rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>';

  var docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
    + '</Relationships>';

  var documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
    + 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:body>' + bodyXml
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
    + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>'
    + '</w:sectPr></w:body></w:document>';

  var stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Georgia"/><w:sz w:val="22"/><w:color w:val="0F2744"/></w:rPr></w:rPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:spacing w:before="160" w:after="60"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:pPr><w:spacing w:before="120" w:after="40"/><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style>'
    + '</w:styles>';

  var numberingXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="\u2022"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>'
    + '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>'
    + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    + '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>'
    + '</w:numbering>';

  return {
    "[Content_Types].xml": contentTypes,
    "_rels/.rels": rootRels,
    "word/_rels/document.xml.rels": docRels,
    "word/document.xml": documentXml,
    "word/styles.xml": stylesXml,
    "word/numbering.xml": numberingXml,
  };
}

/* ── Pure JS ZIP builder (no external tools) ─────────────────────────────── */
import { deflateRawSync } from "zlib";

function crc32(buf) {
  var table = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  var crc = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(files) {
  /* files: { "path/name.xml": Buffer } */
  var localHeaders = [];
  var centralHeaders = [];
  var offset = 0;

  var entries = Object.entries(files);
  for (var i = 0; i < entries.length; i++) {
    var name = entries[i][0];
    var data = entries[i][1];
    var nameBuf = Buffer.from(name, "utf-8");
    var crc = crc32(data);
    var compressed = deflateRawSync(data, { level: 6 });

    /* Local file header (30 bytes + name + compressed data) */
    var local = Buffer.alloc(30 + nameBuf.length + compressed.length);
    local.writeUInt32LE(0x04034B50, 0);       /* signature */
    local.writeUInt16LE(20, 4);               /* version needed */
    local.writeUInt16LE(0, 6);                /* flags */
    local.writeUInt16LE(8, 8);                /* compression: deflate */
    local.writeUInt16LE(0, 10);               /* mod time */
    local.writeUInt16LE(0, 12);               /* mod date */
    local.writeUInt32LE(crc, 14);             /* crc32 */
    local.writeUInt32LE(compressed.length, 18); /* compressed size */
    local.writeUInt32LE(data.length, 22);     /* uncompressed size */
    local.writeUInt16LE(nameBuf.length, 26);  /* name length */
    local.writeUInt16LE(0, 28);               /* extra length */
    nameBuf.copy(local, 30);
    compressed.copy(local, 30 + nameBuf.length);
    localHeaders.push(local);

    /* Central directory header (46 bytes + name) */
    var central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014B50, 0);     /* signature */
    central.writeUInt16LE(20, 4);             /* version made by */
    central.writeUInt16LE(20, 6);             /* version needed */
    central.writeUInt16LE(0, 8);              /* flags */
    central.writeUInt16LE(8, 10);             /* compression */
    central.writeUInt16LE(0, 12);             /* mod time */
    central.writeUInt16LE(0, 14);             /* mod date */
    central.writeUInt32LE(crc, 16);           /* crc32 */
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);             /* extra length */
    central.writeUInt16LE(0, 32);             /* comment length */
    central.writeUInt16LE(0, 34);             /* disk start */
    central.writeUInt16LE(0, 36);             /* internal attrs */
    central.writeUInt32LE(0, 38);             /* external attrs */
    central.writeUInt32LE(offset, 42);        /* local header offset */
    nameBuf.copy(central, 46);
    centralHeaders.push(central);

    offset += local.length;
  }

  /* End of central directory */
  var centralSize = centralHeaders.reduce(function(a, b) { return a + b.length; }, 0);
  var eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054B50, 0);          /* signature */
  eocd.writeUInt16LE(0, 4);                   /* disk number */
  eocd.writeUInt16LE(0, 6);                   /* central dir disk */
  eocd.writeUInt16LE(entries.length, 8);      /* entries on disk */
  eocd.writeUInt16LE(entries.length, 10);     /* total entries */
  eocd.writeUInt32LE(centralSize, 12);        /* central dir size */
  eocd.writeUInt32LE(offset, 16);             /* central dir offset */
  eocd.writeUInt16LE(0, 20);                  /* comment length */

  return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

const SERVER_VERSION = "v5.5";
export default async function handler(req, res) {
  console.log(SERVER_VERSION + " export handler: " + (req.method || "?") + " " + (req.url || ""));
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  var body = req.body || {};
  var content = body.content;
  var matterName = body.matterName || "Matter";
  var jurisdiction = body.jurisdiction || "Bermuda";
  var title = body.title || matterName;

  if (!content) return res.status(400).json({ error: "No content provided" });

  try {
    var bodyXml = markdownToDocxXml(content, matterName, jurisdiction);
    var xmlFiles = buildDocxFiles(bodyXml);

    /* Convert string files to Buffers */
    var bufferFiles = {};
    for (var [path, xml] of Object.entries(xmlFiles)) {
      bufferFiles[path] = Buffer.from(xml, "utf-8");
    }

    /* Build ZIP in memory */
    var zipBuffer = buildZip(bufferFiles);

    var safeName = (title || matterName || "analysis").replace(/[^a-z0-9]/gi, "-").toLowerCase();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", 'attachment; filename="' + safeName + '.docx"');
    res.setHeader("Content-Length", zipBuffer.length);
    return res.status(200).send(zipBuffer);
  } catch (err) {
    console.error("Export error:", err);
    return res.status(500).json({ error: err.message });
  }
}
