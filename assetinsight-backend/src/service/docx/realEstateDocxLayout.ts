import PizZip from "pizzip";

export const REAL_ESTATE_TOC_MARKER = "REAL_ESTATE_CONTENTS_PLACEHOLDER";

const escapeXml = (value: string): string => value
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * Finalize only this report's generated OOXML. Contents are derived from actual
 * headings, not an Asset template or guessed pagination. No media, relationships,
 * values, field results or legal copy are rewritten by this layout pass.
 */
export function finalizeRealEstateDocxLayout(buffer: Buffer, language = "en"): Buffer {
  const zip = new PizZip(buffer);
  let xml = zip.file("word/document.xml")?.asText();
  if (!xml) throw new Error("Real Estate DOCX is missing its document part");
  const labels = language === "fr"
    ? { contents: "Table des matières", certificate: "Certificat de valeur" }
    : language === "es"
      ? { contents: "Tabla de contenido", certificate: "Certificado de valor" }
      : { contents: "Table of Contents", certificate: "Certificate of Market Value" };
  const entries: Array<{ textXml: string; anchor: string }> = [];
  let bookmarkId = Math.max(0, ...Array.from(xml.matchAll(/<w:bookmarkStart\b[^>]*w:id="(\d+)"/g), (match) => Number(match[1]))) + 1;

  xml = xml.replace(/<w:p[ >][\s\S]*?<\/w:p>/g, (paragraph) => {
    if (paragraph.includes('w:name="RealEstateCertificate"')) {
      entries.push({ textXml: escapeXml(labels.certificate), anchor: "RealEstateCertificate" });
    }
    const level = paragraph.match(/<w:pStyle\b[^>]*w:val="Heading([123])"/)?.[1];
    if (level) {
      // Direct heading styles inherit black text and keep with the next block.
      paragraph = paragraph.replace(/<w:color\b[^>]*\/>/g, '<w:color w:val="000000"/>');
      if (!paragraph.includes("<w:keepNext")) paragraph = paragraph.replace("</w:pPr>", "<w:keepNext/></w:pPr>");
      if (level === "1") {
        const textXml = Array.from(paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g), (match) => match[1]).join("");
        if (textXml.trim()) {
          const anchor = `RealEstateSection${entries.length + 1}`;
          const id = bookmarkId++;
          entries.push({ textXml, anchor });
          paragraph = paragraph.replace("</w:pPr>", `</w:pPr><w:bookmarkStart w:id="${id}" w:name="${anchor}"/>`)
            .replace("</w:p>", `<w:bookmarkEnd w:id="${id}"/></w:p>`);
        }
      }
    }
    // Decorative divider-only paragraphs add space and rules under every
    // heading. Removing those does not remove text, photos or section breaks.
    if (paragraph.includes("<w:pBdr>") && !/<w:(?:t[ >]|drawing|sectPr)/.test(paragraph)) return "";
    // Empty page-break paragraphs before optional short summaries used to
    // strand a single sentence on its own page. Chapter headings retain their
    // own explicit breaks; section boundaries and real text are never removed.
    const visibleText = Array.from(paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g), (match) => match[1]).join("").trim();
    if (paragraph.includes("<w:pageBreakBefore") && !visibleText && !/<w:(?:drawing|sectPr|bookmarkStart)/.test(paragraph)) return "";
    return paragraph;
  });

  const contents = `<w:p><w:pPr><w:pStyle w:val="Title"/><w:spacing w:before="0" w:after="220"/><w:jc w:val="left"/></w:pPr><w:r><w:rPr><w:sz w:val="32"/><w:color w:val="000000"/></w:rPr><w:t>${escapeXml(labels.contents)}</w:t></w:r></w:p>`
    + entries.map(({ textXml, anchor }) => `<w:p><w:pPr><w:spacing w:before="0" w:after="90" w:line="260"/><w:keepLines/></w:pPr><w:hyperlink w:anchor="${anchor}" w:history="1"><w:r><w:rPr><w:color w:val="000000"/><w:sz w:val="22"/></w:rPr><w:t>${textXml}</w:t></w:r></w:hyperlink></w:p>`).join("");
  let replacements = 0;
  xml = xml.replace(/<w:p[ >][\s\S]*?<\/w:p>/g, (paragraph) => {
    if (!paragraph.includes(REAL_ESTATE_TOC_MARKER)) return paragraph;
    replacements += 1;
    // Word stores a section boundary on the final paragraph of the TOC.
    const section = paragraph.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/)?.[0];
    return contents + (section ? `<w:p><w:pPr>${section}</w:pPr></w:p>` : "");
  });
  if (replacements !== 1 || entries.length === 0) throw new Error("Real Estate DOCX contents could not be linked to its chapters");
  zip.file("word/document.xml", xml);
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
}
