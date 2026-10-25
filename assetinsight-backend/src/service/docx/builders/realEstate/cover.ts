import { AlignmentType, ImageRun, Paragraph, TextRun } from "docx";
import { loadCoverPhotoBuffers } from "../coverPhotos.js";
import { formatDateUS } from "../utils.js";
import sharp from "sharp";

/** Real Estate titles and long addresses need a flowing cover, not Asset artwork coordinates. */
export async function buildRealEstateCover(data: any, logo: Buffer | null, title: string): Promise<Paragraph[]> {
  const children: Paragraph[] = [];
  if (logo) children.push(new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { after: 500 },
    children: [new ImageRun({ type: "jpg", data: logo, transformation: { width: 240, height: 60 } })],
  }));
  children.push(new Paragraph({ text: title, style: "Title", alignment: AlignmentType.LEFT, spacing: { before: 200, after: 260 } }));
  children.push(new Paragraph({ text: String(data.property_details?.address || data.address || ""), spacing: { after: 280 }, children: [] }));
  for (const [label, value] of [
    ["Prepared for", data.owner_name || data.client_name || ""],
    ["Prepared by", data.inspector_name || data.inspector_info?.inspector_name || ""],
    ["Effective date", formatDateUS(data.effective_date || data.report_dates?.effective_date)],
    ["Report date", formatDateUS(data.report_dates?.report_date || data.createdAt)],
  ]) children.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: `${label}  `, bold: true }), new TextRun(String(value))] }));
  const photos = await loadCoverPhotoBuffers(data);
  if (photos.length) {
    const columns = photos.length === 1 ? 1 : 2;
    const rows = Math.ceil(photos.length / columns);
    const cellWidth = Math.floor(624 / columns);
    const cellHeight = Math.floor(300 / rows);
    const panels = await Promise.all(photos.map(async (photo, index) => ({
      input: await sharp(photo).rotate().resize(cellWidth, cellHeight, { fit: "contain", background: "#ffffff" }).png().toBuffer(),
      top: Math.floor(index / columns) * cellHeight,
      left: (index % columns) * cellWidth,
    })));
    const collage = await sharp({ create: { width: 624, height: 300, channels: 3, background: "#ffffff" } }).composite(panels).png().toBuffer();
    children.push(new Paragraph({
      spacing: { before: 320, after: 0 }, alignment: AlignmentType.CENTER,
      children: [new ImageRun({ type: "png", data: collage, transformation: { width: 624, height: 300 } })],
    }));
  }
  return children;
}
