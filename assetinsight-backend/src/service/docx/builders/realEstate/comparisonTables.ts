import { AlignmentType, BorderStyle, Paragraph, Table, TableCell, TableLayoutType, TableRow, TextRun, VerticalAlign, WidthType } from "docx";

/** Split horizontally wide evidence into bounded comparison tables; never drop records. */
export function buildRealEstateComparisonTables(
  records: Array<{ name: string; values: string[] }>,
  labels: string[],
  width = 9360,
): Table[] {
  const tables: Table[] = [];
  for (let start = 0; start < records.length; start += 3) {
    const group = records.slice(start, start + 3);
    const labelWidth = Math.round(width * 0.32);
    const columns = [labelWidth, ...group.map(() => Math.floor((width - labelWidth) / group.length))];
    columns[columns.length - 1] += width - columns.reduce((total, value) => total + value, 0);
    const cell = (text: string, index: number, header: boolean, row = 0) => new TableCell({
      width: { size: columns[index], type: WidthType.DXA },
      verticalAlign: VerticalAlign.CENTER,
      margins: { top: 85, bottom: 85, left: 110, right: 110 },
      shading: { fill: header ? "343A40" : row % 2 ? "F3F4F6" : "FFFFFF" },
      children: [new Paragraph({
        alignment: index === 0 ? AlignmentType.LEFT : AlignmentType.CENTER,
        spacing: { before: 0, after: 0, line: 252 },
        children: [new TextRun({ text: text || "—", size: 21, color: header ? "FFFFFF" : "202020", bold: header || index === 0 })],
      })],
    });
    const border = { style: BorderStyle.SINGLE, size: 5, color: "D9D9D9" };
    tables.push(new Table({
      width: { size: width, type: WidthType.DXA }, layout: TableLayoutType.FIXED,
      columnWidths: columns,
      borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
      rows: [
        new TableRow({ tableHeader: true, cantSplit: true, children: [cell("Feature", 0, true), ...group.map((record, index) => cell(record.name, index + 1, true))] }),
        ...labels.map((label, row) => new TableRow({ cantSplit: true, children: [cell(label, 0, false, row), ...group.map((record, index) => cell(record.values[row], index + 1, false, row))] })),
      ],
    }));
  }
  return tables;
}
