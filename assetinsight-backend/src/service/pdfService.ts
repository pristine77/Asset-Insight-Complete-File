/**
 * Renders real-estate report data to PDF using the shared HTML template and Puppeteer
 * timeout policy. Browser lifecycle, local asset resolution, and print options remain
 * behind a buffer-returning boundary so worker retries start from a clean render state.
 */
import puppeteer from "puppeteer";
import {
  configurePuppeteerPageTimeouts,
  PUPPETEER_NAVIGATION_TIMEOUT_MS,
} from "../utils/puppeteerTimeout.js";
import handlebars from "handlebars";
import fs from "fs/promises";
import path from "path";

// Helper to format dates
handlebars.registerHelper("formatDate", function (dateString) {
  if (!dateString) return "";
  return new Date(dateString).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
});

handlebars.registerHelper("formatKey", function (key: string) {
  if (!key) return "";
  // Replace underscores with spaces and capitalize each word
  const withSpaces = key.replace(/_/g, " ");
  return withSpaces.replace(/\b\w/g, (char) => char.toUpperCase());
});

handlebars.registerHelper("objectToArray", function (obj) {
  if (!obj) return [];
  return Object.entries(obj).map(([key, value]) => ({ key, value }));
});

handlebars.registerHelper("numberFormat", function (number) {
  if (number === undefined || number === null) return "N/A";
  return new Intl.NumberFormat("en-CA", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(number);
});

export async function generatePdfFromReport(reportData: any): Promise<Buffer> {
  try {
    // 1. Read the HTML template
    const templatePath = path.resolve(
      process.cwd(),
      "src/templates/real-estate.html"
    );
    const htmlTemplate = await fs.readFile(templatePath, "utf-8");

    // Read and encode the logo image
    const logoPath = path.resolve(process.cwd(), "public/logo.jpg");
    const logoImage = await fs.readFile(logoPath);
    const logoBase64 = logoImage.toString("base64");
    const logoUrl = `data:image/jpeg;base64,${logoBase64}`;

    // 2. Compile the template with Handlebars
    // Register a custom helper for date formatting
    handlebars.registerHelper("formatDate", function (dateString) {
      if (!dateString) return "";
      try {
        const date = new Date(dateString);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0"); // Months are 0-indexed
        const day = String(date.getDate()).padStart(2, "0");
        return `${year}-${day}-${month}`;
      } catch (e) {
        return dateString; // Return original string if formatting fails
      }
    });

    const template = handlebars.compile(htmlTemplate);

    // 3. Prepare data for the template
    // Sanitize the entire reportData object to remove any Mongoose-specific properties
    // and ensure it's a plain object that Handlebars can safely process.
    const sanitizedData = JSON.parse(JSON.stringify(reportData));

    // Ensure comparableProperties is an object for the template
    if (Array.isArray(sanitizedData.comparableProperties)) {
      sanitizedData.comparableProperties =
        sanitizedData.comparableProperties.reduce(
          (obj: { [key: string]: any }, item: { name?: string }) => {
            obj[item.name || `comp_${Math.random()}`] = item;
            return obj;
          },
          {}
        );
    }

    // Ensure marketTrend is an array for the template
    if (!Array.isArray(sanitizedData.marketTrend)) {
      sanitizedData.marketTrend = [];
    }

    const dataForPdf = {
      logo_url: logoUrl,
      ...sanitizedData,
      owner_name: sanitizedData.property_details?.owner_name || "",
    };

    const finalHtml = template(dataForPdf);

    // 4. Launch Puppeteer and generate PDF
    const browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      timeout: 120000, // 2 minutes
    });
    const page = await browser.newPage();
    configurePuppeteerPageTimeouts(page);
    await page.setContent(finalHtml, {
      waitUntil: "networkidle0",
      timeout: PUPPETEER_NAVIGATION_TIMEOUT_MS,
    });

    const pdfBuffer = await page.pdf({
      timeout: PUPPETEER_NAVIGATION_TIMEOUT_MS,
      format: "A4",
      printBackground: true,
      margin: {
        top: "20px",
        right: "20px",
        bottom: "20px",
        left: "20px",
      },
    });

    await browser.close();

    return Buffer.from(pdfBuffer);
  } catch (error) {
    console.error("Error generating PDF:", error);
    throw new Error("Failed to generate PDF report.");
  }
}
