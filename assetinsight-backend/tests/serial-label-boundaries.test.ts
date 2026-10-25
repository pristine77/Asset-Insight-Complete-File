import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/openaiClient.js', () => ({ default: { responses: { create: vi.fn() } } }));
vi.mock('../src/service/systemSettingsService.js', () => ({ isAuctioneerSpecWebSearchEnabled: vi.fn(async () => false) }));
const renderer = vi.hoisted(() => ({ html: [] as string[] }));
vi.mock('puppeteer', () => ({ default: { launch: vi.fn(async () => ({
  once: vi.fn(), close: vi.fn(async () => undefined),
  newPage: vi.fn(async () => ({
    on: vi.fn(), setDefaultNavigationTimeout: vi.fn(), setDefaultTimeout: vi.fn(),
    setViewport: vi.fn(async () => undefined), evaluate: vi.fn(async () => undefined),
    setContent: vi.fn(async (html: string) => { renderer.html.push(html); }),
    pdf: vi.fn(async () => {
      const { PDFDocument } = await import('pdf-lib');
      const document = await PDFDocument.create(); document.addPage([612, 792]);
      return document.save();
    }),
  })),
})) } }));

import { buildAuctioneerSpecRows, deriveAuctioneerSerial, normalizeAuctioneerLotSpecs } from '../src/utils/auctioneerSpecRows.js';
import { generateAssetXlsxFromReport, generateLotListingXlsxFromReport } from '../src/service/xlsx/assetXlsxService.js';
import { buildDefaultAssetAdminScheduleSheet } from '../src/service/assetAdminScheduleSheetService.js';
import { enrichLotListingSpecs } from '../src/service/lotListingSpecEnrichmentService.js';
import { generateAuctioneerSpecSheetPdfFromReport } from '../src/service/auctioneerSpecSheetPdfService.js';

const lot = (description: string) => ({ lot_number: '1', title: description, description, categories: 'Furniture' });
const serialRow = (item: any) => buildAuctioneerSpecRows(item).find(row => row.field === 'Serial Number')?.value || '';
const vin = '1FTWW3DR9AEA01459';

describe('standalone VIN and serial labels', () => {
  it.each(['Vintage CRT Television', 'VINTAGE radio', 'Vinyl records', 'Vineyard equipment', 'Snowmobile trailer', 'Serialised collector prints', 'Equipment; Vintage CRT Television', 'Equipment, vinyl records', 'Equipment\nVintage television'])(
    'does not turn descriptive words into a serial: %s', description => {
      const item = lot(description);
      expect(serialRow(item)).toBe('');
      expect(deriveAuctioneerSerial(item)).toBe('');
      expect(normalizeAuctioneerLotSpecs(item).condition_report_specs?.['Serial Number'] || '').toBe('');
      expect(buildDefaultAssetAdminScheduleSheet({ lots: [item] } as any).rows[0].serial_number).toBe('');
      expect(item.description).toBe(description);
    },
  );

  it.each([`VIN: ${vin}`, `vin ${vin}`, `VIN#${vin}`, `VIN-${vin}`, 'SN: ABC-12345', 'S/N ABC-12345', 'Serial Number: ABC-12345', 'Serial No. ABC-12345', 'Serial#ABC-12345'])(
    'keeps real labelled values: %s', description => {
      expect(serialRow(lot(description))).toMatch(/1FTWW3DR9AEA01459|ABC-12345/);
      expect(deriveAuctioneerSerial(lot(description))).toMatch(/1FTWW3DR9AEA01459|ABC-12345/);
    },
  );

  it('finds a real VIN after an unrelated Vintage description and retains explicit values/clears', () => {
    expect(serialRow(lot(`Vintage truck; VIN: ${vin}`))).toBe(vin);
    expect(serialRow({ ...lot('Vintage CRT Television'), serial_number: 'VINTAGE-123' })).toBe('VINTAGE-123');
    expect(serialRow({ ...lot(`Vintage truck; VIN: ${vin}`), condition_report_specs_manual_overrides: { 'Serial Number': '' } })).toBe('');
    // Do not guess whether an already saved serial was intentional or historic bad parsing.
    expect(serialRow({ ...lot('Vintage CRT Television'), condition_report_specs: { 'Serial Number': 'Tage CRT Television' } })).toBe('Tage CRT Television');
  });

  it('does not inject word fragments during deterministic lot enrichment', async () => {
    const input = [lot('Vintage CRT Television'), lot('Snowmobile trailer')];
    const result = await enrichLotListingSpecs({ mode: 'pictureOnly', lots: input });
    for (const item of result.lots) expect(item.condition_report_specs?.['Serial Number'] || '').toBe('');
    expect(input.map(item => item.description)).toEqual(['Vintage CRT Television', 'Snowmobile trailer']);
  });

  it('passes empty serials and unchanged descriptions to the CR PDF renderer, retaining real VINs', async () => {
    renderer.html.length = 0;
    await generateAuctioneerSpecSheetPdfFromReport({ lots: [lot('Vintage CRT Television'), lot('Snowmobile trailer'), lot(`Vintage truck; VIN: ${vin}`)] });
    const html = renderer.html.join('\n');
    const serials = Array.from(html.matchAll(/<tr><th>Serial Number<\/th><td>([^<]*)<\/td><\/tr>/g), match => match[1]);
    expect(serials).toEqual(['', '', vin]);
    expect(html).toContain('<th>Description</th><td>Vintage CRT Television</td>');
    expect(html).toContain('<th>Description</th><td>Snowmobile trailer</td>');
  });
});

describe.each([
  ['Asset', generateAssetXlsxFromReport], ['Lot Listing', generateLotListingXlsxFromReport],
] as const)('%s serial label export', (_name, generate) => {
  it('round-trips Vintage descriptions without fabricating a Serial Number or condition-report row', async () => {
    const report = { lots: [lot('Vintage CRT Television'), lot('Vinyl records'), lot('Snowmobile trailer'), lot(`Vintage truck; VIN: ${vin}`)] };
    const before = JSON.stringify(report);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await generate(report));
    const sheet = workbook.getWorksheet('Sheet1')!;
    const headers = sheet.getRow(1).values as string[];
    for (let row = 2; row <= 4; row++) {
      expect(sheet.getRow(row).getCell(headers.indexOf('Serial Number')).value || '').toBe('');
      expect(String(sheet.getRow(row).getCell(headers.indexOf('Condition Report')).value)).not.toContain('<b>Serial Number</b>');
    }
    expect(String(sheet.getRow(2).getCell(headers.indexOf('Description')).value)).toContain('Vintage CRT Television');
    expect(String(sheet.getRow(5).getCell(headers.indexOf('Serial Number')).value)).toContain(vin);
    expect(JSON.stringify(report)).toBe(before);
  });
});
