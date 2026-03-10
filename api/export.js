import { Document, Paragraph, TextRun, HeadingLevel, AlignmentType, Packer, BorderStyle } from "docx";

export const config = { maxDuration: 30 };

function parseMarkdownToDocx(text, matterName, jurisdiction, h) {
  const children = [];

  // Legal heading
  const dateStr = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  if (h && (h.court || h.plaintiff)) {
    // Full formal legal heading
    if (h.court) children.push(new Paragraph({ children: [new TextRun({ text: h.court.toUpperCase(), bold: true, size: 24, color: "0f2744" })], alignment: AlignmentType.CENTER, spacing: { after: 80 } }));
    if (h.actionNo) children.push(new Paragraph({ children: [new TextRun({ text: "Cause No. " + h.actionNo, size: 22, color: "0f2744" })], alignment: AlignmentType.CENTER, spacing: { after: 80 } }));
    children.push(new Paragraph({ children: [new TextRun({ text: "IN THE MATTER OF " + matterName.toUpperCase(), size: 22, color: "0f2744", bold: true })], alignment: AlignmentType.CENTER, spacing: { before: 120, after: 160 } }));
    if (h.plaintiff || h.defendant) {
      children.push(new Paragraph({ children: [new TextRun({ text: "BETWEEN:", bold: true, size: 22, color: "0f2744" })], spacing: { after: 80 } }));
      if (h.plaintiff) {
        children.push(new Paragraph({ children: [new TextRun({ text: h.plaintiff, size: 22, color: "0f2744" })], spacing: { after: 40 } }));
        children.push(new Paragraph({ children: [new TextRun({ text: "Plaintiff / Petitioner / Applicant", size: 20, color: "5a7a94", italics: true })], indent: { left: 3600 }, spacing: { after: 80 } }));
        children.push(new Paragraph({ children: [new TextRun({ text: "— and —", size: 22, color: "0f2744" })], alignment: AlignmentType.CENTER, spacing: { before: 60, after: 60 } }));
      }
      if (h.defendant) {
        children.push(new Paragraph({ children: [new TextRun({ text: h.defendant, size: 22, color: "0f2744" })], spacing: { after: 40 } }));
        children.push(new Paragraph({ children: [new TextRun({ text: "Defendant / Respondent", size: 20, color: "5a7a94", italics: true })], indent: { left: 3600 }, spacing: { after: 160 } }));
      }
    }
    if (h.docType) children.push(new Paragraph({ children: [new TextRun({ text: h.docType.toUpperCase(), bold: true, size: 26, color: "0f2744" })], alignment: AlignmentType.CENTER, spacing: { before: 160, after: 80 } }));
    if (h.firm) children.push(new Paragraph({ children: [new TextRun({ text: "Filed by: " + h.firm, size: 20, color: "1d6fa4" })], alignment: AlignmentType.CENTER, spacing: { after: 40 } }));
    if (h.counselFor) children.push(new Paragraph({ children: [new TextRun({ text: "Counsel for the " + h.counselFor, size: 20, color: "1d6fa4" })], alignment: AlignmentType.CENTER, spacing: { after: 40 } }));
    children.push(new Paragraph({ children: [new TextRun({ text: "Jurisdiction: " + jurisdiction + "   |   Date: " + dateStr, size: 18, color: "5a7a94" })], alignment: AlignmentType.CENTER, spacing: { after: 400 }, border: { bottom: { color: "c5ddf0", size: 6, style: BorderStyle.SINGLE } } }));
  } else {
    // Simple heading fallback
    children.push(new Paragraph({ children: [new TextRun({ text: "Ex Libris Juris — Legal Analysis", bold: true, size: 28, color: "0f2744" })], spacing: { after: 120 } }));
    children.push(new Paragraph({ children: [new TextRun({ text: "Matter: " + matterName, size: 22, color: "1d6fa4" })], spacing: { after: 60 } }));
    children.push(new Paragraph({ children: [new TextRun({ text: "Jurisdiction: " + jurisdiction + "   |   Date: " + dateStr, size: 18, color: "5a7a94" })], spacing: { after: 400 }, border: { bottom: { color: "c5ddf0", size: 6, style: BorderStyle.SINGLE } } }));
  }

  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    if (line.startsWith("## ") || line.startsWith("# ")) {
      children.push(new Paragraph({
        text: line.replace(/^#+\s/, ""),
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 300, after: 120 },
      }));
    } else if (line.startsWith("### ")) {
      children.push(new Paragraph({
        text: line.slice(4),
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 200, after: 80 },
      }));
    } else if (line.startsWith("#### ")) {
      children.push(new Paragraph({
        text: line.slice(5),
        heading: HeadingLevel.HEADING_4,
        spacing: { before: 160, after: 60 },
      }));
    } else if (line.startsWith("- ") || line.startsWith("• ")) {
      children.push(new Paragraph({
        children: [new TextRun({ text: line.slice(2), size: 22 })],
        bullet: { level: 0 },
        spacing: { after: 60 },
      }));
    } else if (/^\d+\. /.test(line)) {
      children.push(new Paragraph({
        children: [new TextRun({ text: line.replace(/^\d+\. /, ""), size: 22 })],
        numbering: { reference: "default-numbering", level: 0 },
        spacing: { after: 60 },
      }));
    } else if (line.startsWith("> ")) {
      children.push(new Paragraph({
        children: [new TextRun({ text: line.slice(2), italics: true, color: "2d5070", size: 22 })],
        indent: { left: 720 },
        border: { left: { color: "1d6fa4", size: 12, style: BorderStyle.SINGLE } },
        spacing: { before: 80, after: 80 },
      }));
    } else if (line.includes("⚠️")) {
      children.push(new Paragraph({
        children: [new TextRun({ text: line, size: 20, color: "7a6020", italics: true })],
        spacing: { before: 200, after: 80 },
        shading: { fill: "fff8e1" },
      }));
    } else if (line) {
      // Parse inline bold/italic
      const runs = [];
      const parts = line.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
      for (const part of parts) {
        if (part.startsWith("**") && part.endsWith("**")) {
          runs.push(new TextRun({ text: part.slice(2, -2), bold: true, size: 22, color: "0f2744" }));
        } else if (part.startsWith("*") && part.endsWith("*")) {
          runs.push(new TextRun({ text: part.slice(1, -1), italics: true, size: 22, color: "1d6fa4" }));
        } else if (part) {
          runs.push(new TextRun({ text: part, size: 22 }));
        }
      }
      children.push(new Paragraph({ children: runs, spacing: { after: 120 } }));
    } else {
      children.push(new Paragraph({ text: "", spacing: { after: 60 } }));
    }
    i++;
  }

  return children;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { content, matterName, jurisdiction, title, court, actionNo, plaintiff, defendant, firm, counselFor, docType } = req.body;
  if (!content) return res.status(400).json({ error: "No content provided" });

  try {
    const headingOpts = (court || plaintiff || defendant) ? { court, actionNo, plaintiff, defendant, firm: firm, counselFor, docType } : null;
    const children = parseMarkdownToDocx(content, matterName || "Matter", jurisdiction || "Bermuda", headingOpts);

    const doc = new Document({
      numbering: {
        config: [{
          reference: "default-numbering",
          levels: [{ level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.START }]
        }]
      },
      styles: {
        default: {
          document: { run: { font: "Georgia", size: 22, color: "0f2744" } },
        },
        paragraphStyles: [
          {
            id: "Heading2", name: "Heading 2", basedOn: "Normal",
            run: { bold: true, size: 26, color: "0f2744", font: "Georgia" },
          },
          {
            id: "Heading3", name: "Heading 3", basedOn: "Normal",
            run: { bold: true, size: 24, color: "1a3a5c", font: "Georgia" },
          },
          {
            id: "Heading4", name: "Heading 4", basedOn: "Normal",
            run: { bold: true, size: 20, color: "5a7a94", font: "Georgia" },
          },
        ],
      },
      sections: [{
        properties: {
          page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } }
        },
        children,
      }],
    });

    const buffer = await Packer.toBuffer(doc);
    const safeName = (title || matterName || "analysis").replace(/[^a-z0-9]/gi, "-").toLowerCase();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.docx"`);
    res.setHeader("Content-Length", buffer.length);
    return res.status(200).send(buffer);
  } catch (err) {
    console.error("Export error:", err);
    return res.status(500).json({ error: err.message });
  }
}
