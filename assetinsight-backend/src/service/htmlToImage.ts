/**
 * Renders report HTML fragments into raster images for document-generation consumers.
 * This module owns Puppeteer pooling, request interception, asset readiness, viewport
 * sizing, and cleanup; callers receive deterministic buffers without sharing mutable
 * browser-page state across concurrent renders.
 */
import puppeteer from "puppeteer";
import { readFile, access } from "fs/promises";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import {
  configurePuppeteerPageTimeouts,
  PUPPETEER_NAVIGATION_TIMEOUT_MS,
} from "../utils/puppeteerTimeout.js";

/**
 * Find template file across multiple possible locations
 * (handles both dist/ and src/ directories)
 */
async function findTemplate(templateName: string): Promise<string | null> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  
  // Check multiple possible paths
  const candidates = [
    join(__dirname, './docx/templates', templateName),                    // dist/service/docx/templates/
    join(__dirname, '../docx/templates', templateName),                   // dist/docx/templates/
    resolve(process.cwd(), 'src/service/docx/templates', templateName),   // src/service/docx/templates/
    resolve(process.cwd(), 'server/src/service/docx/templates', templateName), // server/src/service/docx/templates/
  ];
  
  for (const candidate of candidates) {
    try {
      await access(candidate);
      console.log(`Found template at: ${candidate}`);
      return candidate;
    } catch {}
  }
  
  console.warn(`Template ${templateName} not found. Checked: ${candidates.join(', ')}`);
  return null;
}

/**
 * Convert HTML string to image buffer using Puppeteer
 * @param html - The HTML string to render
 * @param options - Rendering options
 * @returns Buffer containing the image
 */
export async function htmlToImageBuffer(
  html: string,
  options: {
    width?: number;
    height?: number;
    format?: "png" | "jpeg";
    quality?: number;
  } = {}
): Promise<Buffer> {
  const { width = 1200, height = 1605, format = "png", quality = 95 } = options;

  let browser;
  try {
    // Launch headless browser
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const page = await browser.newPage();
    configurePuppeteerPageTimeouts(page);

    // Set viewport size
    await page.setViewport({
      width,
      height,
      deviceScaleFactor: 2, // High DPI for better quality
    });

    // Set HTML content
    await page.setContent(html, {
      waitUntil: "networkidle0",
      timeout: PUPPETEER_NAVIGATION_TIMEOUT_MS,
    });

    // Take screenshot
    const screenshotBuffer = await page.screenshot({
      type: format,
      quality: format === "jpeg" ? quality : undefined,
      fullPage: false,
    });

    await browser.close();

    // Return the screenshot buffer directly
    // Puppeteer already handles quality via screenshot options
    return Buffer.from(screenshotBuffer);
  } catch (error) {
    if (browser) {
      await browser.close();
    }
    console.error("Error converting HTML to image:", error);
    throw new Error("Failed to convert HTML to image");
  }
}

/**
 * Build certificate HTML from template file
 */
async function buildCertificateHTMLFromTemplate(data: {
  title: string;
  clientName: string;
  effectiveDate: string;
  purpose: string;
  preparedBy: string;
  totalValue?: string;
  reportDate: string;
}): Promise<string> {
  try {
    // Find template file (checks multiple paths)
    const templatePath = await findTemplate('certificate.html');
    
    if (!templatePath) {
      console.warn('Certificate template not found, using fallback HTML');
      return buildCertificateHTMLFallback(data);
    }
    
    console.log('Reading certificate template from:', templatePath);
    let html = await readFile(templatePath, 'utf-8');
    
    // Replace placeholders
    html = html.replace(/\{\{TITLE\}\}/g, data.title || 'Certificate of Appraisal');
    html = html.replace(/\{\{CLIENT_NAME\}\}/g, data.clientName || '—');
    html = html.replace(/\{\{EFFECTIVE_DATE\}\}/g, data.effectiveDate || '—');
    html = html.replace(/\{\{PURPOSE\}\}/g, data.purpose || '—');
    html = html.replace(/\{\{PREPARED_BY\}\}/g, data.preparedBy || '—');
    html = html.replace(/\{\{REPORT_DATE\}\}/g, data.reportDate || '—');
    
    // Handle optional total value section
    if (data.totalValue) {
      html = html.replace(/\{\{TOTAL_VALUE\}\}/g, data.totalValue);
      html = html.replace(/\{\{VALUE_SECTION_START\}\}/g, '');
      html = html.replace(/\{\{VALUE_SECTION_END\}\}/g, '');
    } else {
      // Remove entire value section if no value provided
      const valueSectionRegex = /\{\{VALUE_SECTION_START\}\}[\s\S]*?\{\{VALUE_SECTION_END\}\}/g;
      html = html.replace(valueSectionRegex, '');
    }
    
    return html;
  } catch (error) {
    console.error('Failed to read certificate template, using fallback:', error);
    // Fallback to inline HTML if template file not found
    return buildCertificateHTMLFallback(data);
  }
}

function buildCertificateHTMLFallback(data: {
  title: string;
  clientName: string;
  effectiveDate: string;
  purpose: string;
  preparedBy: string;
  totalValue?: string;
  reportDate: string;
}): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Inter:wght@400;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    body { font-family: 'Inter', sans-serif; background: #ffffff; width: 794px; height: 1123px; margin: 0; padding: 0; overflow: hidden; }
    .playfair { font-family: 'Playfair Display', serif; }
    .cert-wrapper { width: 100%; height: 100%; margin: 0; padding: 40px; display: flex; flex-direction: column; justify-content: space-between; box-sizing: border-box; border-radius: 0; border: none; }
  </style>
</head>
<body>
  <div class="cert-wrapper bg-gradient-to-br from-red-50 to-white overflow-hidden">
    <div class="bg-gradient-to-r from-red-600 to-red-700 p-8 text-center relative">
      <div class="absolute top-0 left-0 w-full h-1 bg-amber-400"></div>
      <i class="fas fa-award text-white text-5xl mb-4"></i>
      <h1 class="playfair text-5xl font-bold text-white uppercase tracking-wider mb-3">${data.title}</h1>
      <p class="text-red-100 text-lg tracking-widest uppercase">Professional Business Valuation</p>
      <div class="absolute bottom-0 left-0 w-full h-1.5 bg-amber-400"></div>
    </div>
    
    <div class="p-8">
      <p class="text-gray-700 text-center leading-relaxed mb-8">
        This document certifies that a comprehensive professional appraisal has been conducted 
        in accordance with applicable industry standards and regulatory requirements.
      </p>
      
      ${data.totalValue ? `
      <div class="bg-gradient-to-br from-red-500 to-red-700 rounded-lg p-8 text-center mb-8 relative">
        <div class="absolute top-0 left-0 w-full h-1 bg-amber-400"></div>
        <div class="flex items-center justify-center mb-3">
          <i class="fas fa-dollar-sign text-amber-300 text-2xl mr-2"></i>
          <p class="text-red-100 text-sm font-bold tracking-widest uppercase">Total Appraised Value</p>
        </div>
        <p class="playfair text-6xl font-bold text-white">${data.totalValue}</p>
      </div>
      ` : ''}
      
      <div class="grid grid-cols-2 gap-4 mb-8">
        <div class="bg-red-50 border-l-4 border-red-600 rounded p-5">
          <div class="flex items-center mb-2">
            <i class="fas fa-user text-red-600 mr-2"></i>
            <p class="text-xs font-bold text-gray-500 uppercase">Client</p>
          </div>
          <p class="text-lg font-semibold text-gray-900">${data.clientName}</p>
        </div>
        <div class="bg-red-50 border-l-4 border-red-600 rounded p-5">
          <div class="flex items-center mb-2">
            <i class="fas fa-calendar text-red-600 mr-2"></i>
            <p class="text-xs font-bold text-gray-500 uppercase">Effective Date</p>
          </div>
          <p class="text-lg font-semibold text-gray-900">${data.effectiveDate}</p>
        </div>
        <div class="bg-red-50 border-l-4 border-red-600 rounded p-5">
          <div class="flex items-center mb-2">
            <i class="fas fa-clipboard-list text-red-600 mr-2"></i>
            <p class="text-xs font-bold text-gray-500 uppercase">Purpose</p>
          </div>
          <p class="text-lg font-semibold text-gray-900">${data.purpose}</p>
        </div>
        <div class="bg-red-50 border-l-4 border-red-600 rounded p-5">
          <div class="flex items-center mb-2">
            <i class="fas fa-user-tie text-red-600 mr-2"></i>
            <p class="text-xs font-bold text-gray-500 uppercase">Prepared By</p>
          </div>
          <p class="text-lg font-semibold text-gray-900">${data.preparedBy}</p>
        </div>
      </div>
      
      <div class="grid grid-cols-2 gap-12 mt-10 pt-8 border-t-2">
        <div>
          <div class="h-16 mb-2"></div>
          <div class="border-t-2 border-gray-800 pt-2">
            <div class="flex items-center justify-center">
              <i class="fas fa-pen-fancy text-gray-600 text-sm mr-2"></i>
              <p class="text-sm font-semibold text-gray-600 uppercase">Authorized Signature</p>
            </div>
          </div>
        </div>
        <div>
          <div class="h-12 mb-2 flex items-end justify-center">
            <p class="text-base font-semibold text-gray-900">${data.reportDate}</p>
          </div>
          <div class="border-t-2 border-gray-800 pt-2">
            <div class="flex items-center justify-center">
              <i class="fas fa-calendar text-gray-600 text-sm mr-2"></i>
              <p class="text-sm font-semibold text-gray-600 uppercase">Date</p>
            </div>
          </div>
        </div>
      </div>
    </div>
    
    <div class="bg-gradient-to-r from-red-600 to-red-700 p-5 text-center">
      <div class="flex items-center justify-center">
        <i class="fas fa-shield-alt text-red-200 mr-2"></i>
        <p class="text-sm text-red-50">This certificate is valid for business purposes and complies with professional appraisal standards.</p>
      </div>
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * Generate certificate image from data
 * @param certificateData - Data for the certificate
 * @returns Buffer containing the certificate image
 */
export async function generateCertificateImage(certificateData: {
  title: string;
  clientName: string;
  effectiveDate: string;
  purpose: string;
  preparedBy: string;
  totalValue?: string;
  appraiserSignature?: string;
  reportDate: string;
}): Promise<Buffer> {
  const html = await buildCertificateHTMLFromTemplate(certificateData);

  return await htmlToImageBuffer(html, {
    width: 794,
    height: 1123, // A4 dimensions - matches HTML canvas exactly
    format: "png",
    quality: 95,
  });
}

/**
 * Build beautiful certificate HTML
 */
/**
 * Build beautiful cover page HTML
 */
function buildCoverPageHTML(data: {
  logoBase64?: string;
  companyName: string;
  title: string;
  subtitle?: string;
  clientName: string;
  reportDate: string;
  additionalInfo?: string;
}): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cover Page</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: #ffffff;
      width: 1200px;
      height: 1553px;
      display: flex;
      align-items: stretch;
      justify-content: stretch;
      padding: 0;
      margin: 0;
      overflow: hidden;
    }
    
    .cover-container {
      width: 1200px;
      height: 1553px;
      background: linear-gradient(135deg, #fee2e2 0%, #fecaca 25%, #fca5a5 50%, #f87171 75%, #ef4444 100%);
      position: relative;
      overflow: hidden;
    }
    
    .cover-container::before {
      content: '';
      position: absolute;
      top: -50%;
      right: -20%;
      width: 800px;
      height: 800px;
      background: radial-gradient(circle, rgba(255,255,255,0.4) 0%, transparent 70%);
      border-radius: 50%;
    }
    
    .cover-container::after {
      content: '';
      position: absolute;
      bottom: -30%;
      left: -10%;
      width: 600px;
      height: 600px;
      background: radial-gradient(circle, rgba(255,255,255,0.3) 0%, transparent 70%);
      border-radius: 50%;
    }
    
    .content-wrapper {
      position: relative;
      z-index: 1;
      height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 80px 100px;
    }
    
    .header-section {
      text-align: center;
    }
    
    .company-name {
      font-size: 48px;
      font-weight: 300;
      color: #7f1d1d;
      letter-spacing: 4px;
      text-transform: uppercase;
      margin-bottom: 20px;
      text-shadow: 2px 2px 4px rgba(255,255,255,0.5);
    }
    
    .divider {
      width: 200px;
      height: 3px;
      background: linear-gradient(90deg, transparent, #dc2626, transparent);
      margin: 0 auto 60px;
    }
    
    .title-section {
      text-align: center;
      margin: 60px 0;
    }
    
    .logo {
      width: 320px;
      height: auto;
      margin: 0 auto 60px;
      display: block;
      filter: drop-shadow(0 4px 12px rgba(0,0,0,0.2));
    }
    
    .main-title {
      font-size: 72px;
      font-weight: 700;
      color: #7f1d1d;
      margin-bottom: 30px;
      text-shadow: 2px 2px 4px rgba(255,255,255,0.5);
      line-height: 1.2;
    }
    
    .subtitle {
      font-size: 32px;
      font-weight: 300;
      color: #dc2626;
      font-style: italic;
      margin-bottom: 60px;
    }
    
    .info-cards {
      display: flex;
      justify-content: center;
      gap: 40px;
      margin-top: 60px;
    }
    
    .info-card {
      background: rgba(255, 255, 255, 0.7);
      backdrop-filter: blur(10px);
      border: 2px solid rgba(220, 38, 38, 0.3);
      border-radius: 20px;
      padding: 40px 60px;
      min-width: 350px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
    }
    
    .info-label {
      font-size: 16px;
      font-weight: 600;
      color: #dc2626;
      text-transform: uppercase;
      letter-spacing: 2px;
      margin-bottom: 15px;
    }
    
    .info-value {
      font-size: 28px;
      font-weight: 600;
      color: #7f1d1d;
    }
    
    .footer-section {
      text-align: center;
      padding-top: 40px;
      border-top: 1px solid rgba(220, 38, 38, 0.2);
    }
    
    .footer-text {
      font-size: 18px;
      color: #7f1d1d;
    }
  </style>
</head>
<body>
  <div class="cover-container">
    <div class="content-wrapper">
      <div class="header-section">
        <div class="company-name">${data.companyName}</div>
        <div class="divider"></div>
      </div>
      
      <div class="title-section">
        ${data.logoBase64 ? `<img src="data:image/png;base64,${data.logoBase64}" class="logo" alt="Logo" />` : ''}
        <h1 class="main-title">${data.title}</h1>
        ${data.subtitle ? `<p class="subtitle">${data.subtitle}</p>` : ''}
        
        <div class="info-cards">
          <div class="info-card">
            <div class="info-label">Prepared For</div>
            <div class="info-value">${data.clientName}</div>
          </div>
          <div class="info-card">
            <div class="info-label">Date</div>
            <div class="info-value">${data.reportDate}</div>
          </div>
        </div>
      </div>
      
      <div class="footer-section">
        ${data.additionalInfo ? `<p class="footer-text">${data.additionalInfo}</p>` : ''}
      </div>
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * Build professional certificate HTML
 */
function buildCertificateHTML(data: {
  title: string;
  clientName: string;
  effectiveDate: string;
  purpose: string;
  preparedBy: string;
  totalValue?: string;
  appraiserSignature?: string;
  reportDate: string;
}): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Certificate of Appraisal</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: transparent;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 1600px;
      padding: 0;
      margin: 0;
    }
    
    .certificate-container {
      width: 1100px;
      background: transparent;
      box-shadow: none;
      position: relative;
      overflow: hidden;
    }
    
    .certificate-header {
      background: linear-gradient(135deg, #fee2e2 0%, #fecaca 25%, #fca5a5 50%, #f87171 75%, #ef4444 100%);
      padding: 60px;
      text-align: center;
      position: relative;
    }
    
    .certificate-header::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 6px;
      background: #D4AF37;
    }
    
    .certificate-title {
      font-size: 52px;
      font-weight: 700;
      color: #7f1d1d;
      text-transform: uppercase;
      letter-spacing: 6px;
      margin-bottom: 20px;
      text-shadow: 2px 2px 4px rgba(255,255,255,0.5);
    }
    
    .certificate-subtitle {
      font-size: 22px;
      color: #dc2626;
      font-weight: 500;
      letter-spacing: 3px;
      text-transform: uppercase;
    }
    
    .certificate-body {
      padding: 70px 90px;
    }
    
    .certificate-statement {
      text-align: center;
      font-size: 19px;
      color: #4B5563;
      line-height: 1.9;
      margin-bottom: 60px;
      font-weight: 400;
    }
    
    .value-showcase {
      background: linear-gradient(135deg, #fee2e2 0%, #f87171 60%, #ef4444 100%);
      border-radius: 10px;
      padding: 50px;
      text-align: center;
      margin: 60px 0;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1);
      position: relative;
    }
    
    .value-showcase::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 4px;
      background: #D4AF37;
    }
    
    .value-label {
      font-size: 20px;
      color: #7f1d1d;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 4px;
      margin-bottom: 25px;
    }
    
    .value-amount {
      font-size: 64px;
      font-weight: 700;
      color: #ffffff;
      letter-spacing: 2px;
    }
    
    .details-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 25px;
      margin: 60px 0;
    }
    
    .detail-item {
      background: rgba(255,255,255,0.9);
      border-left: 4px solid #dc2626;
      padding: 28px 35px;
      border-radius: 6px;
    }
    
    .detail-label {
      font-size: 14px;
      color: #6B7280;
      font-weight: 600;
      margin-bottom: 12px;
      text-transform: uppercase;
      letter-spacing: 2px;
    }
    
    .detail-value {
      font-size: 22px;
      color: #1F2937;
      font-weight: 600;
    }
    
    .signature-section {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 80px;
      margin-top: 90px;
      padding-top: 50px;
      border-top: 2px solid #E5E7EB;
    }
    
    .signature-box {
      text-align: center;
    }
    
    .signature-line {
      border-top: 2px solid #1F2937;
      margin-bottom: 20px;
      padding-top: 70px;
    }
    
    .signature-label {
      font-size: 16px;
      color: #6B7280;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    
    .footer-bar {
      background: linear-gradient(135deg, #fee2e2 0%, #ef4444 100%);
      padding: 30px;
      text-align: center;
      margin-top: 60px;
    }
    
    .footer-text {
      font-size: 14px;
      color: rgba(255, 255, 255, 0.9);
      letter-spacing: 1px;
    }
  </style>
</head>
<body>
  <div class="certificate-container">
    <div class="certificate-header">
      <h1 class="certificate-title">${data.title || "Certificate of Appraisal"}</h1>
      <p class="certificate-subtitle">Professional Business Valuation</p>
    </div>
    
    <div class="certificate-body">
      <p class="certificate-statement">
        This document certifies that a comprehensive professional appraisal has been conducted 
        in accordance with applicable industry standards and regulatory requirements. The 
        valuation opinion presented herein represents our professional expertise and thorough 
        market analysis.
      </p>
      
      ${
        data.totalValue
          ? `
      <div class="value-showcase">
        <div class="value-label">Total Appraised Value</div>
        <div class="value-amount">${data.totalValue}</div>
      </div>
      `
          : ""
      }
      
      <div class="details-grid">
        <div class="detail-item">
          <div class="detail-label">Client</div>
          <div class="detail-value">${data.clientName || "—"}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Effective Date</div>
          <div class="detail-value">${data.effectiveDate || "—"}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Purpose</div>
          <div class="detail-value">${data.purpose || "—"}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Prepared By</div>
          <div class="detail-value">${data.preparedBy || "—"}</div>
        </div>
      </div>
      
      <div class="signature-section">
        <div class="signature-box">
          <div class="signature-line"></div>
          <div class="signature-label">Authorized Signature</div>
        </div>
        <div class="signature-box">
          <div class="signature-line"></div>
          <div class="signature-label">Date: ${data.reportDate || '—'}</div>
        </div>
      </div>
    </div>
    
    <div class="footer-bar">
      <p class="footer-text">This certificate is valid for business purposes and complies with professional appraisal standards.</p>
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * Build real estate certificate HTML from template file
 */
async function buildRealEstateCertificateHTMLFromTemplate(data: {
  title: string;
  propertyType: string;
  ownerName: string;
  propertyAddress: string;
  effectiveDate: string;
  appraiser: string;
  marketValue?: string;
  reportDate: string;
}): Promise<string> {
  try {
    // Find template file (checks multiple paths)
    const templatePath = await findTemplate('realEstateCertificate.html');
    
    if (!templatePath) {
      console.warn('Real estate certificate template not found, using fallback HTML');
      return buildRealEstateCertificateHTMLFallback(data);
    }
    
    console.log('Reading real estate certificate template from:', templatePath);
    let html = await readFile(templatePath, 'utf-8');
    
    // Replace placeholders
    html = html.replace(/\{\{TITLE\}\}/g, data.title || 'Certificate of Market Value');
    html = html.replace(/\{\{PROPERTY_TYPE\}\}/g, data.propertyType || 'Real Estate');
    html = html.replace(/\{\{OWNER_NAME\}\}/g, data.ownerName || '—');
    html = html.replace(/\{\{PROPERTY_ADDRESS\}\}/g, data.propertyAddress || '—');
    html = html.replace(/\{\{EFFECTIVE_DATE\}\}/g, data.effectiveDate || '—');
    html = html.replace(/\{\{APPRAISER\}\}/g, data.appraiser || '—');
    html = html.replace(/\{\{REPORT_DATE\}\}/g, data.reportDate || '—');
    
    // Handle optional market value section
    if (data.marketValue) {
      html = html.replace(/\{\{MARKET_VALUE\}\}/g, data.marketValue);
      html = html.replace(/\{\{VALUE_SECTION_START\}\}/g, '');
      html = html.replace(/\{\{VALUE_SECTION_END\}\}/g, '');
    } else {
      // Remove entire value section if no value provided
      const valueSectionRegex = /\{\{VALUE_SECTION_START\}\}[\s\S]*?\{\{VALUE_SECTION_END\}\}/g;
      html = html.replace(valueSectionRegex, '');
    }
    
    return html;
  } catch (error) {
    console.error('Failed to read real estate certificate template, using fallback:', error);
    // Fallback to inline HTML if template file not found
    return buildRealEstateCertificateHTMLFallback(data);
  }
}

function buildRealEstateCertificateHTMLFallback(data: {
  title: string;
  propertyType: string;
  ownerName: string;
  propertyAddress: string;
  effectiveDate: string;
  appraiser: string;
  marketValue?: string;
  reportDate: string;
}): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Inter:wght@400;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    body { font-family: 'Inter', sans-serif; background: #ffffff; width: 794px; height: 1123px; margin: 0; padding: 0; overflow: hidden; }
    .playfair { font-family: 'Playfair Display', serif; }
    .cert-wrapper { width: 100%; height: 100%; margin: 0; padding: 40px; display: flex; flex-direction: column; justify-content: space-between; box-sizing: border-box; border-radius: 0; border: none; }
  </style>
</head>
<body>
  <div class="cert-wrapper bg-gradient-to-br from-emerald-50 to-white overflow-hidden">
    <div class="bg-gradient-to-r from-emerald-600 to-emerald-700 p-8 text-center relative">
      <div class="absolute top-0 left-0 w-full h-1 bg-amber-400"></div>
      <i class="fas fa-home text-white text-5xl mb-4"></i>
      <h1 class="playfair text-5xl font-bold text-white uppercase tracking-wider mb-3">${data.title}</h1>
      <p class="text-emerald-100 text-lg tracking-widest uppercase">${data.propertyType} Valuation</p>
      <div class="absolute bottom-0 left-0 w-full h-1.5 bg-amber-400"></div>
    </div>
    
    <div class="p-8">
      <p class="text-gray-700 text-center leading-relaxed mb-8">
        This document certifies that a comprehensive professional real estate appraisal has been 
        conducted in accordance with CUSPAP standards.
      </p>
      
      ${data.marketValue ? `
      <div class="bg-gradient-to-br from-emerald-500 to-emerald-700 rounded-lg p-8 text-center mb-8 relative">
        <div class="absolute top-0 left-0 w-full h-1 bg-amber-400"></div>
        <div class="flex items-center justify-center mb-3">
          <i class="fas fa-dollar-sign text-amber-300 text-2xl mr-2"></i>
          <p class="text-emerald-100 text-sm font-bold tracking-widest uppercase">Fair Market Value</p>
        </div>
        <p class="playfair text-6xl font-bold text-white">${data.marketValue}</p>
      </div>
      ` : ''}
      
      <div class="grid grid-cols-2 gap-4 mb-8">
        <div class="bg-emerald-50 border-l-4 border-emerald-600 rounded p-5">
          <div class="flex items-center mb-2">
            <i class="fas fa-user text-emerald-600 mr-2"></i>
            <p class="text-xs font-bold text-gray-500 uppercase">Property Owner</p>
          </div>
          <p class="text-lg font-semibold text-gray-900">${data.ownerName}</p>
        </div>
        <div class="bg-emerald-50 border-l-4 border-emerald-600 rounded p-5">
          <div class="flex items-center mb-2">
            <i class="fas fa-map-marker-alt text-emerald-600 mr-2"></i>
            <p class="text-xs font-bold text-gray-500 uppercase">Property Address</p>
          </div>
          <p class="text-lg font-semibold text-gray-900">${data.propertyAddress}</p>
        </div>
        <div class="bg-emerald-50 border-l-4 border-emerald-600 rounded p-5">
          <div class="flex items-center mb-2">
            <i class="fas fa-calendar text-emerald-600 mr-2"></i>
            <p class="text-xs font-bold text-gray-500 uppercase">Effective Date</p>
          </div>
          <p class="text-lg font-semibold text-gray-900">${data.effectiveDate}</p>
        </div>
        <div class="bg-emerald-50 border-l-4 border-emerald-600 rounded p-5">
          <div class="flex items-center mb-2">
            <i class="fas fa-user-tie text-emerald-600 mr-2"></i>
            <p class="text-xs font-bold text-gray-500 uppercase">Prepared By</p>
          </div>
          <p class="text-lg font-semibold text-gray-900">${data.appraiser}</p>
        </div>
      </div>
      
      <div class="grid grid-cols-2 gap-12 mt-10 pt-8 border-t-2">
        <div>
          <div class="h-16 mb-2"></div>
          <div class="border-t-2 border-gray-800 pt-2">
            <div class="flex items-center justify-center">
              <i class="fas fa-pen-fancy text-gray-600 text-sm mr-2"></i>
              <p class="text-sm font-semibold text-gray-600 uppercase">Appraiser Signature</p>
            </div>
          </div>
        </div>
        <div>
          <div class="h-12 mb-2 flex items-end justify-center">
            <p class="text-base font-semibold text-gray-900">${data.reportDate}</p>
          </div>
          <div class="border-t-2 border-gray-800 pt-2">
            <div class="flex items-center justify-center">
              <i class="fas fa-calendar text-gray-600 text-sm mr-2"></i>
              <p class="text-sm font-semibold text-gray-600 uppercase">Date</p>
            </div>
          </div>
        </div>
      </div>
    </div>
    
    <div class="bg-gradient-to-r from-emerald-600 to-emerald-700 p-5 text-center">
      <div class="flex items-center justify-center">
        <i class="fas fa-shield-alt text-emerald-200 mr-2"></i>
        <p class="text-sm text-emerald-50">This certificate complies with CUSPAP and professional real estate appraisal standards.</p>
      </div>
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * Generate real estate certificate image from data
 * @param certificateData - Data for the real estate certificate
 * @returns Buffer containing the certificate image
 */
export async function generateRealEstateCertificateImage(certificateData: {
  title: string;
  propertyType: string;
  ownerName: string;
  propertyAddress: string;
  effectiveDate: string;
  appraiser: string;
  marketValue?: string;
  reportDate: string;
}): Promise<Buffer> {
  const html = await buildRealEstateCertificateHTMLFromTemplate(certificateData);

  return await htmlToImageBuffer(html, {
    width: 794,
    height: 1123, // A4 dimensions - matches HTML canvas exactly
    format: "png",
    quality: 95,
  });
}

/**
 * Generate cover page image from data
 */
export async function generateCoverPageImage(
  coverData: {
    companyName: string;
    title: string;
    subtitle?: string;
    clientName: string;
    reportDate: string;
    additionalInfo?: string;
  },
  logoBuffer?: Buffer | null
): Promise<Buffer> {
  // Convert logo buffer to base64 if provided
  const logoBase64 = logoBuffer ? logoBuffer.toString('base64') : undefined;
  
  const html = buildCoverPageHTML({
    ...coverData,
    logoBase64,
  });

  return await htmlToImageBuffer(html, {
    width: 1200,
    height: 1553, // 8.5:11 aspect ratio (1200 * 11/8.5 = 1553)
    format: "png",
    quality: 95,
  });
}
