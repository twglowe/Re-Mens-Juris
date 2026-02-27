import { Document, Paragraph, TextRun, HeadingLevel, AlignmentType, Packer, BorderStyle } from "docx";

export const config = { maxDuration: 30 };

function parseMarkdownToDocx(text, matterName, jurisdiction) {
  const children = [];

  // Title
  children.push(new Paragraph({
    children: [new TextRun({ text: "Mens Juris — Legal Analysis", bold: true, size: 28, color: "0f2744" })],
    spacing: { after: 120 },
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: `Matter: ${matterName}`, size: 22, color: "1d6fa4" })],
    spacing: { after: 60 },
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: `Jurisdiction: ${jurisdiction}   |   Date: ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`, size: 18, color: "5a7a94" })],
    spacing: { after: 400 },
    border: { bottom: { color: "c5ddf0", size: 6, style: BorderStyle.SINGLE } },
  }));

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

  const { content, matterName, jurisdiction, title } = req.body;
  if (!content) return res.status(400).json({ error: "No content provided" });

  try {
    const children = parseMarkdownToDocx(content, matterName || "Matter", jurisdiction || "Bermuda");

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
