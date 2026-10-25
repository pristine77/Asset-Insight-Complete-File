const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const scanRoots = [path.join(root, "src"), path.join(root, "scripts")];
const allowedFiles = new Set([
  path.normalize(path.join(root, "src", "utils", "openaiClient.ts")),
  path.normalize(__filename),
]);
const allowedExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      files.push(...listFiles(fullPath));
    } else if (allowedExtensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function lineNumberForOffset(text, offset) {
  return text.slice(0, offset).split(/\r?\n/).length;
}

const violations = [];
const patterns = [
  { label: "direct OpenAI client construction", regex: /new\s+OpenAI\s*\(/g },
  { label: "direct OpenAI package import", regex: /from\s+["']openai["']/g },
  { label: "CommonJS OpenAI package require", regex: /require\s*\(\s*["']openai["']\s*\)/g },
];

for (const file of scanRoots.flatMap(listFiles)) {
  const normalizedFile = path.normalize(file);
  if (allowedFiles.has(normalizedFile)) continue;
  const text = fs.readFileSync(file, "utf8");
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    let match;
    while ((match = pattern.regex.exec(text))) {
      violations.push({
        file: path.relative(root, file).replace(/\\/g, "/"),
        line: lineNumberForOffset(text, match.index),
        label: pattern.label,
      });
    }
  }
}

if (violations.length) {
  console.error(
    "OpenAI requests must go through src/utils/openaiClient.ts so retry and API-key configuration stays centralized."
  );
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line} ${violation.label}`);
  }
  process.exit(1);
}

console.log("Provider client boundary guard passed.");
