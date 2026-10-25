import { processImageWithLogo } from "../utils/imageProcessing.js";
import fs from "fs/promises";
import path from "path";

/**
 * Test script to verify image processing with logo works correctly
 * Takes an input image, adds logo, and saves output for visual inspection
 */
async function testImageProcessing() {
  try {
    console.log("🧪 Testing Image Processing with Logo...\n");

    // Input image path
    const inputImagePath = path.resolve(process.cwd(), "public/icon.png");
    console.log("📁 Input image:", inputImagePath);

    // Logo path
    const logoPath = path.resolve(process.cwd(), "public/logoNobg.png");
    console.log("🏷️  Logo path:", logoPath);

    // Check if files exist
    try {
      await fs.access(inputImagePath);
      console.log("✅ Input image exists");
    } catch {
      throw new Error(`Input image not found: ${inputImagePath}`);
    }

    try {
      await fs.access(logoPath);
      console.log("✅ Logo exists");
    } catch {
      throw new Error(`Logo not found: ${logoPath}. Please ensure public/logoNobg.png exists.`);
    }

    // Read input image
    console.log("\n📖 Reading input image...");
    const inputBuffer = await fs.readFile(inputImagePath);
    console.log(`   Original size: ${(inputBuffer.length / 1024).toFixed(2)} KB`);

    // Process with logo (original quality preserved - no resize/compression)
    console.log("\n🎨 Processing image with logo...");
    console.log("   Options:");
    console.log("   - Logo position: bottom_right");
    console.log("   - Logo scale: 16% of width");
    console.log("   - Quality: 98 (near lossless)");
    console.log("   - No resize - original dimensions preserved");

    const startTime = Date.now();
    const { buffer: outputBuffer, format } = await processImageWithLogo(
      inputBuffer,
      logoPath,
      {
        quality: 98,
        logoScale: 0.16,
        logoMarginPx: 12,
        logoMarginPct: 0.02,
        logoPosition: "bottom_right",
      }
    );
    const duration = Date.now() - startTime;

    console.log(`✅ Processing complete in ${duration}ms`);
    console.log(`   Output size: ${(outputBuffer.length / 1024).toFixed(2)} KB`);
    console.log(`   Format: ${format}`);
    console.log(`   Size reduction: ${(((inputBuffer.length - outputBuffer.length) / inputBuffer.length) * 100).toFixed(1)}%`);

    // Save output
    const outputDir = path.resolve(process.cwd(), "test-outputs");
    await fs.mkdir(outputDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outputPath = path.join(outputDir, `test-logo-${timestamp}.jpg`);
    await fs.writeFile(outputPath, outputBuffer);

    console.log(`\n💾 Output saved to: ${outputPath}`);
    console.log("\n✅ Test completed successfully!");
    console.log("\n📸 Open the output file to verify the logo appears in the bottom-right corner.");
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    process.exit(1);
  }
}

testImageProcessing();
