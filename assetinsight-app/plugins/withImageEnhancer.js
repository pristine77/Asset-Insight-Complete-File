const {
  withDangerousMod,
  withMainApplication,
  withAppBuildGradle,
  AndroidConfig,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MODULE_NAME = 'ImageEnhancer';

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeFileIfChanged(filePath, contents) {
  if (fs.existsSync(filePath)) {
    const current = fs.readFileSync(filePath, 'utf8');
    if (current === contents) return;
  }
  fs.writeFileSync(filePath, contents);
}

function addImportIfMissing(contents, importLine) {
  if (contents.includes(importLine)) return contents;
  const lines = contents.split('\n');
  const lastImportIdx = lines.reduce((idx, line, i) => (line.startsWith('import ') ? i : idx), -1);
  if (lastImportIdx >= 0) {
    lines.splice(lastImportIdx + 1, 0, importLine);
    return lines.join('\n');
  }
  return `${importLine}\n${contents}`;
}

function applyKotlinPackagesInjection(src, packageClassName) {
  if (src.includes(`${packageClassName}()`)) return src;

  // Typical Expo MainApplication.kt:
  // val packages = PackageList(this).packages
  // return packages
  const re = /(val\s+packages\s*=\s*PackageList\(this\)\.packages\s*\r?\n)/;
  if (re.test(src)) {
    return src.replace(re, `$1    packages.add(${packageClassName}())\n`);
  }

  // Some templates use `.packages.apply { ... }`
  const marker = 'PackageList(this).packages';
  if (src.includes(`${marker}.apply {`) && !src.includes(`add(${packageClassName}())`)) {
    return src.replace(
      `${marker}.apply {`,
      `${marker}.apply {\n            add(${packageClassName}())`
    );
  }

  return src;
}

function applyJavaPackagesInjection(src, packageClassName) {
  if (src.includes(`new ${packageClassName}()`)) return src;
  // Typical Expo MainApplication.java:
  // List<ReactPackage> packages = new PackageList(this).getPackages();
  // return packages;
  const re = /(List<ReactPackage>\s+packages\s*=\s*new\s+PackageList\(this\)\.getPackages\(\);)/;
  if (!re.test(src)) return src;
  return src.replace(
    re,
    `$1\n    packages.add(new ${packageClassName}());`
  );
}

module.exports = function withImageEnhancer(config) {
  config = withAppBuildGradle(config, (config) => {
    const contents = config.modResults.contents;
    if (contents.includes('androidx.exifinterface:exifinterface')) return config;

    // Insert into dependencies block.
    config.modResults.contents = contents.replace(
      /dependencies\s*\{/, 
      'dependencies {\n    implementation "androidx.exifinterface:exifinterface:1.3.7"'
    );
    return config;
  });

  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const androidRoot = config.modRequest.platformProjectRoot;
      const pkg = AndroidConfig.Package.getPackage(config);
      if (!pkg) {
        throw new Error('[withImageEnhancer] Missing android package name.');
      }

      const packagePath = pkg.split('.').join(path.sep);
      const targetDir = path.join(
        androidRoot,
        'app',
        'src',
        'main',
        'java',
        packagePath,
        'imageenhancer'
      );

      ensureDir(targetDir);

      const modulePath = path.join(targetDir, 'ImageEnhancerModule.kt');
      const pkgPath = path.join(targetDir, 'ImageEnhancerPackage.kt');

      const moduleCode = `package ${pkg}.imageenhancer\n\nimport com.facebook.react.bridge.Promise\nimport com.facebook.react.bridge.ReactApplicationContext\nimport com.facebook.react.bridge.ReactContextBaseJavaModule\nimport com.facebook.react.bridge.ReactMethod\nimport java.io.File\nimport java.io.FileOutputStream\nimport java.util.concurrent.Executors\nimport android.graphics.Bitmap\nimport android.graphics.BitmapFactory\nimport android.graphics.ImageDecoder\nimport android.os.Build\nimport androidx.exifinterface.media.ExifInterface\nimport kotlin.math.abs\n\nclass ImageEnhancerModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {\n  companion object {\n    const val NAME = \"${MODULE_NAME}\"\n  }\n\n  private val executor = Executors.newSingleThreadExecutor()\n\n  override fun getName(): String = NAME\n\n  @ReactMethod\n  fun autoEnhance(path: String, promise: Promise) {\n    executor.execute {\n      try {\n        val inPath = if (path.startsWith(\"file://\")) path.removePrefix(\"file://\") else path\n        val inFile = File(inPath)\n        if (!inFile.exists()) {\n          promise.reject(\"ENOENT\", \"File not found: $inPath\")\n          return@execute\n        }\n\n        val bitmap: Bitmap? = if (Build.VERSION.SDK_INT >= 28) {\n          val source = ImageDecoder.createSource(inFile)\n          ImageDecoder.decodeBitmap(source) { decoder, _, _ ->\n            decoder.setAllocator(ImageDecoder.ALLOCATOR_SHARED_MEMORY)\n            decoder.setMutableRequired(true)\n          }\n        } else {\n          val opts = BitmapFactory.Options().apply {\n            inPreferredConfig = Bitmap.Config.ARGB_8888\n            inMutable = true\n          }\n          BitmapFactory.decodeFile(inFile.absolutePath, opts)\n        }\n\n        if (bitmap == null) {\n          promise.reject(\"EDECODE\", \"Failed to decode image\")\n          return@execute\n        }\n\n        val width = bitmap.width\n        val height = bitmap.height\n\n        val contrast = 1.08f\n        val saturation = 1.10f\n\n        val invSat = 1f - saturation\n        val rW = 0.213f\n        val gW = 0.715f\n        val bW = 0.072f\n\n        val satR = invSat * rW\n        val satG = invSat * gW\n        val satB = invSat * bW\n\n        fun clamp(v: Int): Int = when {\n          v < 0 -> 0\n          v > 255 -> 255\n          else -> v\n        }\n\n        val row = IntArray(width)\n        for (y in 0 until height) {\n          bitmap.getPixels(row, 0, width, 0, y, width, 1)\n          for (x in 0 until width) {\n            val c = row[x]\n            val a = (c ushr 24) and 0xFF\n            var r = (c ushr 16) and 0xFF\n            var g = (c ushr 8) and 0xFF\n            var b = c and 0xFF\n\n            val rr = (r * (satR + saturation) + g * satG + b * satB)\n            val gg = (r * satR + g * (satG + saturation) + b * satB)\n            val bb = (r * satR + g * satG + b * (satB + saturation))\n\n            r = clamp(((rr - 128f) * contrast + 128f).toInt())\n            g = clamp(((gg - 128f) * contrast + 128f).toInt())\n            b = clamp(((bb - 128f) * contrast + 128f).toInt())\n\n            row[x] = (a shl 24) or (r shl 16) or (g shl 8) or b\n          }\n          bitmap.setPixels(row, 0, width, 0, y, width, 1)\n        }\n\n        val mp = (width.toLong() * height.toLong()).toDouble() / 1_000_000.0\n        val doSharpen = width >= 3 && height >= 3 && mp <= 32.0\n\n        if (doSharpen) {\n          val amount = 0.5f\n\n          fun luma(c: Int): Int {\n            val r = (c ushr 16) and 0xFF\n            val g = (c ushr 8) and 0xFF\n            val b = c and 0xFF\n            return (0.2126f * r + 0.7152f * g + 0.0722f * b).toInt()\n          }\n\n          var prev = IntArray(width)\n          var curr = IntArray(width)\n          var next = IntArray(width)\n\n          var lPrev = IntArray(width)\n          var lCurr = IntArray(width)\n          var lNext = IntArray(width)\n\n          bitmap.getPixels(prev, 0, width, 0, 0, width, 1)\n          for (i in 0 until width) lPrev[i] = luma(prev[i])\n\n          bitmap.getPixels(curr, 0, width, 0, 1, width, 1)\n          for (i in 0 until width) lCurr[i] = luma(curr[i])\n\n          for (y in 1 until height - 1) {\n            bitmap.getPixels(next, 0, width, 0, y + 1, width, 1)\n            for (i in 0 until width) lNext[i] = luma(next[i])\n\n            val out = curr.copyOf()\n\n            for (x in 1 until width - 1) {\n              val blur = (\n                lPrev[x - 1] + lPrev[x] + lPrev[x + 1] +\n                  lCurr[x - 1] + lCurr[x] + lCurr[x + 1] +\n                  lNext[x - 1] + lNext[x] + lNext[x + 1]\n                ) / 9\n\n              val baseY = lCurr[x]\n              val detail = baseY - blur\n              if (abs(detail) < 2) continue\n\n              val newYf = (baseY.toFloat() + amount * detail.toFloat()).coerceIn(0f, 255f)\n              val ratio = if (baseY <= 0) 1f else (newYf / baseY.toFloat())\n\n              val c = curr[x]\n              val a = (c ushr 24) and 0xFF\n              val r0 = (c ushr 16) and 0xFF\n              val g0 = (c ushr 8) and 0xFF\n              val b0 = c and 0xFF\n\n              val r = clamp((r0.toFloat() * ratio).toInt())\n              val g = clamp((g0.toFloat() * ratio).toInt())\n              val b = clamp((b0.toFloat() * ratio).toInt())\n\n              out[x] = (a shl 24) or (r shl 16) or (g shl 8) or b\n            }\n\n            bitmap.setPixels(out, 0, width, 0, y, width, 1)\n\n            val tmpP = prev\n            prev = curr\n            curr = next\n            next = tmpP\n\n            val tmpL = lPrev\n            lPrev = lCurr\n            lCurr = lNext\n            lNext = tmpL\n          }\n        }\n\n        val outFile = File(inFile.parentFile, inFile.nameWithoutExtension + \"-enhanced.jpg\")\n        FileOutputStream(outFile).use { out ->\n          bitmap.compress(Bitmap.CompressFormat.JPEG, 98, out)\n        }\n        bitmap.recycle()\n\n        try {\n          val inExif = ExifInterface(inFile.absolutePath)\n          val outExif = ExifInterface(outFile.absolutePath)\n          val tags = arrayOf(\n            ExifInterface.TAG_ORIENTATION,\n            ExifInterface.TAG_DATETIME,\n            ExifInterface.TAG_MAKE,\n            ExifInterface.TAG_MODEL,\n            ExifInterface.TAG_F_NUMBER,\n            ExifInterface.TAG_EXPOSURE_TIME,\n            ExifInterface.TAG_ISO_SPEED_RATINGS,\n            ExifInterface.TAG_FOCAL_LENGTH,\n            ExifInterface.TAG_WHITE_BALANCE,\n            ExifInterface.TAG_GPS_LATITUDE,\n            ExifInterface.TAG_GPS_LONGITUDE,\n            ExifInterface.TAG_GPS_LATITUDE_REF,\n            ExifInterface.TAG_GPS_LONGITUDE_REF\n          )\n          for (t in tags) {\n            val v = inExif.getAttribute(t)\n            if (v != null) outExif.setAttribute(t, v)\n          }\n          outExif.saveAttributes()\n        } catch (_: Throwable) {\n        }\n\n        promise.resolve(\"file://\" + outFile.absolutePath)\n      } catch (e: Throwable) {\n        promise.reject(\"EENHANCE\", e.message, e)\n      }\n    }\n  }\n}\n`;

      const pkgCode = `package ${pkg}.imageenhancer\n\nimport com.facebook.react.ReactPackage\nimport com.facebook.react.bridge.NativeModule\nimport com.facebook.react.bridge.ReactApplicationContext\nimport com.facebook.react.uimanager.ViewManager\n\nclass ImageEnhancerPackage : ReactPackage {\n  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {\n    return listOf(ImageEnhancerModule(reactContext))\n  }\n\n  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {\n    return emptyList()\n  }\n}\n`;

      writeFileIfChanged(modulePath, moduleCode);
      writeFileIfChanged(pkgPath, pkgCode);

      return config;
    },
  ]);

  config = withMainApplication(config, (config) => {
    const pkg = AndroidConfig.Package.getPackage(config);
    if (!pkg) return config;

    const importLineKt = `import ${pkg}.imageenhancer.ImageEnhancerPackage`;
    const importLineJava = `import ${pkg}.imageenhancer.ImageEnhancerPackage;`;

    let contents = config.modResults.contents;

    if (config.modResults.language === 'kt') {
      contents = addImportIfMissing(contents, importLineKt);
      contents = applyKotlinPackagesInjection(contents, 'ImageEnhancerPackage');
    } else {
      contents = addImportIfMissing(contents, importLineJava);
      contents = applyJavaPackagesInjection(contents, 'ImageEnhancerPackage');
    }

    config.modResults.contents = contents;
    return config;
  });

  return config;
};
