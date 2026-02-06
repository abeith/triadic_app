#!/usr/bin/env node
// Generate a print-ready HTML grid of images with ID overlays.
// Usage: node bin/print-images.js --layout 2x2|1x2|2x3 [--dir path] [--out path]
// Optional: --include path (default .printinclude) --exclude path (default .printignore)

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const IMAGE_EXT_RE = /\.(jpg|jpeg|png|webp|gif|tif|tiff|bmp)$/i;
const ID_RE = /^(\d+)\.(jpg|jpeg|png|webp|gif|tif|tiff|bmp)$/i;

function parseArgs(argv) {
  const args = {
    layout: "2x2",
    dir: null,
    out: null,
    include: null,
    exclude: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--layout") args.layout = argv[i + 1] ?? args.layout;
    if (a === "--dir") args.dir = argv[i + 1] ?? null;
    if (a === "--out") args.out = argv[i + 1] ?? null;
    if (a === "--include") args.include = argv[i + 1] ?? null;
    if (a === "--exclude") args.exclude = argv[i + 1] ?? null;
  }
  return args;
}

function readList(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  const out = new Set();
  raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .forEach((line) => {
      const m = line.match(/^(\d+)$/);
      if (m) out.add(Number.parseInt(m[1], 10));
      else {
        const m2 = line.match(ID_RE);
        if (m2) out.add(Number.parseInt(m2[1], 10));
      }
    });
  return out;
}

function listImages(imagesDir) {
  const entries = fs.readdirSync(imagesDir).filter((f) => IMAGE_EXT_RE.test(f));
  const images = [];
  for (const name of entries) {
    const m = name.match(ID_RE);
    if (!m) continue;
    const id = Number.parseInt(m[1], 10);
    if (!Number.isFinite(id)) continue;
    images.push({ id, filename: name });
  }
  images.sort((a, b) => a.id - b.id);
  return images;
}

function layoutConfig(layout) {
  switch (layout) {
    case "1x2":
      return { cols: 1, rows: 2, orientation: "portrait" };
    case "2x3":
      return { cols: 2, rows: 3, orientation: "portrait" };
    case "2x2":
    default:
      return { cols: 2, rows: 2, orientation: "landscape" };
  }
}

function pageChunks(items, perPage) {
  const pages = [];
  for (let i = 0; i < items.length; i += perPage) {
    pages.push(items.slice(i, i + perPage));
  }
  return pages;
}

const args = parseArgs(process.argv.slice(2));
const imagesDir = args.dir || path.join(process.cwd(), "public", "images");
const outPath =
  args.out || path.join(process.cwd(), "print", `print_${args.layout}.html`);

if (!fs.existsSync(imagesDir)) {
  console.error(`Images directory not found: ${imagesDir}`);
  process.exit(1);
}

const includeFile = args.include || path.join(process.cwd(), ".printinclude");
const excludeFile = args.exclude || path.join(process.cwd(), ".printignore");
const includeSet = readList(includeFile);
const excludeSet = readList(excludeFile) ?? new Set();

let images = listImages(imagesDir);
if (includeSet && includeSet.size) {
  images = images.filter((img) => includeSet.has(img.id));
}
if (excludeSet.size) {
  images = images.filter((img) => !excludeSet.has(img.id));
}

if (!images.length) {
  console.error("No images matched the include/exclude filters.");
  process.exit(1);
}

const { cols, rows, orientation } = layoutConfig(args.layout);
const perPage = cols * rows;
const pages = pageChunks(images, perPage);

const css = `
@page { size: A4 ${orientation}; margin: 8mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; }
body { font-family: Arial, sans-serif; }
.page {
  page-break-after: always;
  width: 100%;
  height: 100%;
  display: grid;
  grid-template-columns: repeat(${cols}, 1fr);
  grid-template-rows: repeat(${rows}, 1fr);
  gap: 4mm;
}
.cell {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  overflow: hidden;
  align-items: end;
}
.cell img {
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
  object-fit: contain;
  display: block;
}
.id {
  position: absolute;
  left: 4mm;
  bottom: 4mm;
  font-size: 12pt;
  font-weight: 700;
  background: rgba(255,255,255,0.85);
  padding: 2mm 3mm;
  border-radius: 3mm;
}
`;

const htmlPages = pages
  .map((page) => {
    const cells = [];
    for (let i = 0; i < perPage; i += 1) {
      const item = page[i];
      if (!item) {
        cells.push(`<div class="cell"></div>`);
        continue;
      }
      const src = `../public/images/${item.filename}`;
      cells.push(`
        <div class="cell">
          <img src="${src}" alt="Image ${item.id}" />
          <div class="id">${item.id}</div>
        </div>
      `);
    }
    return `<section class="page">${cells.join("")}</section>`;
  })
  .join("\n");

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Print Images (${args.layout})</title>
    <style>${css}</style>
  </head>
  <body>
    ${htmlPages}
  </body>
</html>`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html, "utf8");
console.log(`Wrote ${outPath}`);
