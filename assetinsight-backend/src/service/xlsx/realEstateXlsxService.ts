import ExcelJS from "exceljs";
import {
  addWorksheetFromRows,
  setWorksheetColumnWidths,
  workbookToBuffer,
} from "../../utils/excel.js";

/**
 * Projects real-estate comparables into a matrix: one feature per row and one
 * property per column. This orientation mirrors the appraisal report and must
 * remain stable for side-by-side review and downstream spreadsheet templates.
 */
function safe(val?: any): string {
  if (val === undefined || val === null) return "";
  return String(val);
}

function getCompVal(obj: any, key: string, alt?: string): string {
  if (!obj) return "";
  if (obj[key] !== undefined && obj[key] !== null) return String(obj[key]);
  if (alt && obj[alt] !== undefined && obj[alt] !== null) return String(obj[alt]);
  const lowerKey = key.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lowerKey) return String(obj[k]);
  }
  return "";
}

/**
 * Generates an Excel sheet focusing on the Comparable Properties table.
 * Layout matches the HTML template style where features are rows and columns are Subject + Comparables.
 */
export async function generateRealEstateXlsx(reportData: any): Promise<Buffer> {
  // Unsupported locale values use the complete English dictionary rather than
  // allowing partially localized headings into the exported schema.
  const lang: 'en' | 'fr' | 'es' = ((): any => {
    const l = String((reportData as any)?.language || '').toLowerCase();
    return (l === 'fr' || l === 'es') ? l : 'en';
  })();
  const t = {
    en: {
      feature: 'Feature',
      subject: 'Subject Property',
      address: 'Address',
      listPrice: 'List Price',
      squareFootage: 'Square Footage',
      lotSize: 'Lot Size',
      rooms: 'Rooms/Bedrooms',
      bathrooms: 'Bathrooms',
      adjustedValue: 'Adjusted Value',
      na: 'N/A',
      half: 'Half',
      full: 'Full',
    },
    fr: {
      feature: 'Caractéristique',
      subject: 'Bien sujet',
      address: 'Adresse',
      listPrice: 'Prix affiché',
      squareFootage: 'Superficie (pi²)',
      lotSize: 'Superficie du lot',
      rooms: 'Pièces/Chambres',
      bathrooms: 'Salles de bain',
      adjustedValue: 'Valeur ajustée',
      na: 'S/O',
      half: 'Demi',
      full: 'Complète',
    },
    es: {
      feature: 'Característica',
      subject: 'Propiedad sujeta',
      address: 'Dirección',
      listPrice: 'Precio de lista',
      squareFootage: 'Superficie (ft²)',
      lotSize: 'Tamaño del lote',
      rooms: 'Habitaciones/Dormitorios',
      bathrooms: 'Baños',
      adjustedValue: 'Valor ajustado',
      na: 'N/D',
      half: 'Medio',
      full: 'Completo',
    },
  } as const;
  const tt = (t as any)[lang] as typeof t.en;
  const subject = {
    address: safe(reportData?.property_details?.address),
    listPrice: tt.na,
    squareFootage: safe(reportData?.house_details?.square_footage),
    lotSize: safe(reportData?.house_details?.lot_size_sqft),
    bedrooms: safe(reportData?.house_details?.number_of_rooms),
    bathrooms: `${safe(reportData?.house_details?.number_of_full_bathrooms) || "0"} ${tt.full}, ${safe(reportData?.house_details?.number_of_half_bathrooms) || "0"} ${tt.half}`,
    adjustedValue: tt.na,
  };

  // Accept persisted array, Map, and object shapes, but normalize once. Entry
  // order is preserved because it defines the left-to-right comparable order.
  const compsEntries: Array<[string, any]> = (() => {
    const cp = reportData?.comparableProperties;
    if (!cp) return [];
    if (Array.isArray(cp)) {
      return cp.map((c: any, idx: number) => [c?.name || `Comp ${idx + 1}`, c]);
    }
    if (cp instanceof Map) return Array.from(cp.entries());
    if (typeof cp === "object") return Object.entries(cp);
    return [];
  })();

  const headers = [
    tt.feature,
    tt.subject,
    ...compsEntries.map(([name]) => String(name)),
  ];

  const rows: any[][] = [];
  // Centralizing row projection keeps the subject and each comparable aligned
  // even when a legacy record uses an alternate, case-insensitive field name.
  const pushRow = (feature: string, subjectVal: string, key: string, alt?: string) => {
    rows.push([
      feature,
      subjectVal,
      ...compsEntries.map(([, c]) => getCompVal(c, key, alt) || "—"),
    ]);
  };

  pushRow(tt.address, subject.address, "address", "Address / Location");
  pushRow(tt.listPrice, subject.listPrice, "listPrice", "List Price");
  pushRow(tt.squareFootage, subject.squareFootage, "squareFootage", "Square Footage");
  pushRow(tt.lotSize, subject.lotSize, "lotSize", "Lot Size");
  pushRow(tt.rooms, subject.bedrooms, "bedrooms", "Bedrooms");
  pushRow(tt.bathrooms, subject.bathrooms, "bathrooms", "Bathrooms");
  pushRow(tt.adjustedValue, subject.adjustedValue, "adjustedValue", "Adjusted Value");

  const workbook = new ExcelJS.Workbook();
  const ws = addWorksheetFromRows(workbook, "Comparables", [headers, ...rows]);
  // Bound widths prevent user-supplied names from creating unusably wide sheets
  // while leaving enough room for feature labels and property values.
  setWorksheetColumnWidths(
    ws,
    headers.map((h) => Math.max(16, Math.min(48, String(h).length + 6)))
  );
  return workbookToBuffer(workbook);
}
