import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const outDir = path.resolve("public/welcome");

const esc = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const svg = (width, height, body, defs = "") => `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="28" stdDeviation="24" flood-color="#0f172a" flood-opacity="0.18"/>
    </filter>
    <filter id="tightShadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="12" stdDeviation="12" flood-color="#0f172a" flood-opacity="0.14"/>
    </filter>
    <linearGradient id="paper" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#ffffff"/>
      <stop offset="1" stop-color="#edf3fb"/>
    </linearGradient>
    <linearGradient id="red" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#ef4444"/>
      <stop offset="1" stop-color="#b91c1c"/>
    </linearGradient>
    <linearGradient id="blue" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#38bdf8"/>
      <stop offset="1" stop-color="#2563eb"/>
    </linearGradient>
    <linearGradient id="green" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#34d399"/>
      <stop offset="1" stop-color="#059669"/>
    </linearGradient>
    ${defs}
  </defs>
  ${body}
</svg>`;

const label = (x, y, text, size = 28, color = "#0f172a", weight = 700, opacity = 1) =>
  `<text x="${x}" y="${y}" fill="${color}" opacity="${opacity}" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="${size}" font-weight="${weight}" letter-spacing="0">${esc(text)}</text>`;

async function writePng(name, width, height, body, defs) {
  await sharp(Buffer.from(svg(width, height, body, defs)))
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(path.join(outDir, name));
}

function machinery(x, y, scale = 1, color = "#27364d", accent = "#dc2626") {
  const s = scale;
  return `
    <g transform="translate(${x} ${y}) scale(${s})" filter="url(#tightShadow)">
      <rect x="88" y="84" width="254" height="58" rx="18" fill="${color}"/>
      <rect x="142" y="28" width="120" height="78" rx="20" fill="#334155"/>
      <rect x="160" y="44" width="34" height="30" rx="6" fill="#b7c9d9"/>
      <rect x="204" y="44" width="40" height="30" rx="6" fill="#dce7f2"/>
      <path d="M319 92C376 85 426 68 470 38" stroke="${color}" stroke-width="26" stroke-linecap="round"/>
      <path d="M462 40L530 64" stroke="${accent}" stroke-width="20" stroke-linecap="round"/>
      <circle cx="139" cy="146" r="51" fill="#101827"/>
      <circle cx="139" cy="146" r="24" fill="#94a3b8"/>
      <circle cx="295" cy="146" r="51" fill="#101827"/>
      <circle cx="295" cy="146" r="24" fill="#94a3b8"/>
      <rect x="52" y="118" width="328" height="16" rx="8" fill="${accent}"/>
    </g>`;
}

function reportSheet(x, y, w, h, title, tone = "red") {
  const fill = tone === "green" ? "url(#green)" : tone === "blue" ? "url(#blue)" : "url(#red)";
  return `
    <g transform="translate(${x} ${y})" filter="url(#softShadow)">
      <rect width="${w}" height="${h}" rx="22" fill="url(#paper)"/>
      <rect x="34" y="36" width="${w - 68}" height="18" rx="9" fill="#cbd5e1"/>
      <rect x="34" y="70" width="${w * 0.48}" height="36" rx="10" fill="#0f172a"/>
      ${label(52, 96, title, 19, "#ffffff", 800)}
      <rect x="34" y="130" width="${w - 68}" height="${Math.max(126, h * 0.32)}" rx="18" fill="${fill}" opacity="0.92"/>
      <circle cx="${w - 92}" cy="${h - 98}" r="46" fill="${fill}" opacity="0.14"/>
      <rect x="34" y="${h - 128}" width="${w - 68}" height="14" rx="7" fill="#cbd5e1"/>
      <rect x="34" y="${h - 94}" width="${w * 0.64}" height="14" rx="7" fill="#e2e8f0"/>
      <rect x="34" y="${h - 60}" width="${w * 0.36}" height="14" rx="7" fill="#e2e8f0"/>
    </g>`;
}

async function main() {
  await mkdir(outDir, { recursive: true });

  await writePng(
    "hero-asset-workspace.png",
    1800,
    1100,
    `
    <rect width="1800" height="1100" fill="url(#heroBg)"/>
    <path d="M0 746C266 670 474 702 724 634C1010 556 1290 468 1800 498V1100H0V746Z" fill="#d8e6f3"/>
    <path d="M0 824C320 772 586 812 864 742C1136 674 1436 635 1800 688V1100H0V824Z" fill="#edf3f8"/>
    <path d="M136 804H1664" stroke="#c4d4e4" stroke-width="5" stroke-linecap="round"/>
    ${machinery(1138, 606, 0.72, "#263449", "#dc2626")}
    ${machinery(980, 770, 0.48, "#334155", "#2563eb")}
    <g transform="translate(900 120)" filter="url(#softShadow)">
      <rect width="680" height="486" rx="38" fill="#111827"/>
      <rect x="24" y="24" width="632" height="438" rx="24" fill="#f8fafc"/>
      <rect x="54" y="58" width="220" height="28" rx="14" fill="#0f172a"/>
      <rect x="54" y="110" width="166" height="74" rx="18" fill="url(#red)" opacity="0.94"/>
      <rect x="242" y="110" width="166" height="74" rx="18" fill="url(#blue)" opacity="0.94"/>
      <rect x="430" y="110" width="166" height="74" rx="18" fill="url(#green)" opacity="0.94"/>
      <rect x="54" y="222" width="542" height="32" rx="16" fill="#dbe5ef"/>
      <rect x="54" y="282" width="132" height="118" rx="20" fill="#e2e8f0"/>
      <rect x="210" y="282" width="132" height="118" rx="20" fill="#cbd5e1"/>
      <rect x="366" y="282" width="230" height="118" rx="20" fill="#eff6ff"/>
      <path d="M398 362C425 330 449 344 471 310C497 270 534 292 560 254" stroke="#dc2626" stroke-width="12" stroke-linecap="round"/>
    </g>
    <g transform="translate(1288 330)" filter="url(#softShadow)">
      <rect width="238" height="488" rx="48" fill="#0f172a"/>
      <rect x="18" y="26" width="202" height="436" rx="34" fill="#ffffff"/>
      <rect x="42" y="58" width="154" height="74" rx="24" fill="url(#red)"/>
      <rect x="42" y="158" width="154" height="26" rx="13" fill="#0f172a"/>
      <rect x="42" y="210" width="154" height="84" rx="20" fill="#e2e8f0"/>
      <rect x="42" y="318" width="70" height="74" rx="18" fill="#dcfce7"/>
      <rect x="126" y="318" width="70" height="74" rx="18" fill="#fee2e2"/>
    </g>
    <g transform="translate(638 596)" filter="url(#softShadow)">
      <rect width="332" height="412" rx="30" fill="#ffffff"/>
      <rect x="34" y="36" width="130" height="20" rx="10" fill="#0f172a"/>
      <rect x="34" y="84" width="264" height="154" rx="22" fill="#dbeafe"/>
      <path d="M58 206L130 132L190 194L224 158L280 216V238H58V206Z" fill="#93c5fd"/>
      <rect x="34" y="274" width="264" height="18" rx="9" fill="#cbd5e1"/>
      <rect x="34" y="316" width="202" height="18" rx="9" fill="#e2e8f0"/>
      <rect x="34" y="358" width="150" height="18" rx="9" fill="#e2e8f0"/>
    </g>
    <circle cx="1630" cy="144" r="116" fill="#ffffff" opacity="0.36"/>
    `,
    `
    <linearGradient id="heroBg" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#f8fbff"/>
      <stop offset="0.46" stop-color="#dfeaf5"/>
      <stop offset="1" stop-color="#b9d0e4"/>
    </linearGradient>`
  );

  await writePng(
    "report-package.png",
    1200,
    900,
    `
    <rect width="1200" height="900" fill="#f5f8fc"/>
    <path d="M88 724C278 624 432 714 598 634C768 552 940 514 1114 578V900H88V724Z" fill="#dfeaf5"/>
    ${reportSheet(104, 128, 408, 604, "Asset Report", "red")}
    ${reportSheet(374, 84, 430, 632, "Valuation Summary", "blue")}
    <g transform="translate(720 204)" filter="url(#softShadow)">
      <rect width="342" height="386" rx="28" fill="#0f172a"/>
      <rect x="24" y="28" width="294" height="206" rx="22" fill="#e2e8f0"/>
      <path d="M48 202L122 126L188 194L226 154L294 220V234H48V202Z" fill="#94a3b8"/>
      <rect x="24" y="270" width="152" height="28" rx="14" fill="url(#green)"/>
      <rect x="24" y="324" width="260" height="14" rx="7" fill="#cbd5e1" opacity="0.72"/>
      <rect x="24" y="352" width="190" height="14" rx="7" fill="#cbd5e1" opacity="0.52"/>
    </g>
    <g transform="translate(826 610)" filter="url(#tightShadow)">
      <rect width="220" height="88" rx="24" fill="#ffffff"/>
      ${label(32, 54, "Ready to send", 24, "#059669", 900)}
    </g>
    `,
    ""
  );

  await writePng(
    "lot-gallery.png",
    1200,
    900,
    `
    <rect width="1200" height="900" fill="#eef4fa"/>
    <rect x="78" y="80" width="1044" height="738" rx="42" fill="#ffffff" filter="url(#softShadow)"/>
    <rect x="122" y="124" width="340" height="34" rx="17" fill="#0f172a"/>
    <rect x="900" y="124" width="144" height="34" rx="17" fill="url(#red)"/>
    ${[0,1,2,3,4,5].map((i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = 122 + col * 326;
      const y = 206 + row * 264;
      const tones = ["#dbeafe", "#dcfce7", "#fee2e2", "#e0f2fe", "#fef3c7", "#e2e8f0"];
      return `
      <g transform="translate(${x} ${y})">
        <rect width="278" height="218" rx="24" fill="#f8fafc" stroke="#d9e4ef" stroke-width="2"/>
        <rect x="18" y="18" width="242" height="120" rx="20" fill="${tones[i]}"/>
        <path d="M44 124L98 74L144 116L174 92L238 132V138H44V124Z" fill="#64748b" opacity="0.55"/>
        <circle cx="82" cy="92" r="20" fill="#334155"/>
        <circle cx="200" cy="92" r="20" fill="#334155"/>
        <rect x="18" y="158" width="96" height="16" rx="8" fill="#0f172a"/>
        <rect x="18" y="186" width="160" height="12" rx="6" fill="#cbd5e1"/>
        <rect x="192" y="160" width="68" height="28" rx="14" fill="${i % 2 ? "url(#green)" : "url(#red)"}"/>
      </g>`;
    }).join("")}
    `,
    ""
  );

  await writePng(
    "field-capture.png",
    1200,
    900,
    `
    <rect width="1200" height="900" fill="#f8fbff"/>
    <rect x="90" y="132" width="1020" height="548" rx="56" fill="#dfeaf5"/>
    <path d="M102 560C252 452 398 502 538 420C708 320 910 354 1110 284V680H102V560Z" fill="#c7d8e9"/>
    ${machinery(570, 414, 0.72, "#334155", "#dc2626")}
    <g transform="translate(260 98)" filter="url(#softShadow)">
      <rect width="316" height="672" rx="58" fill="#111827"/>
      <rect x="22" y="30" width="272" height="612" rx="42" fill="#ffffff"/>
      <rect x="48" y="62" width="220" height="96" rx="30" fill="url(#red)"/>
      <rect x="48" y="188" width="220" height="254" rx="28" fill="#dbeafe"/>
      <path d="M72 394L142 286L198 370L222 336L258 402V442H72V394Z" fill="#60a5fa"/>
      <circle cx="214" cy="274" r="24" fill="#ffffff" opacity="0.74"/>
      <rect x="48" y="474" width="94" height="76" rx="22" fill="#ecfdf5"/>
      <rect x="174" y="474" width="94" height="76" rx="22" fill="#fff7ed"/>
      <circle cx="158" cy="590" r="32" fill="#dc2626"/>
    </g>
    <g transform="translate(672 174)" filter="url(#tightShadow)">
      <rect width="318" height="116" rx="28" fill="#ffffff"/>
      ${label(34, 48, "Photos captured", 22, "#0f172a", 900)}
      ${label(34, 82, "Lots stay organized from the field", 18, "#475569", 700)}
    </g>
    <g transform="translate(720 604)" filter="url(#tightShadow)">
      <rect width="286" height="92" rx="26" fill="#ffffff"/>
      <circle cx="48" cy="46" r="22" fill="#dcfce7"/>
      ${label(84, 54, "Ready for review", 22, "#059669", 900)}
    </g>
    `,
    ""
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
