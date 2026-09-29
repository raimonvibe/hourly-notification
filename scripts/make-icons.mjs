// Renders public/icon.svg to the PNG sizes Android and iOS expect.
// Run with: node scripts/make-icons.mjs
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const svg = await readFile(new URL("../public/icon.svg", import.meta.url));
const targets = [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["icon-maskable-512.png", 512], // artwork already sits inside the 80% safe zone
  ["apple-touch-icon.png", 180],
];

for (const [name, size] of targets) {
  await sharp(svg, { density: 384 })
    .resize(size, size)
    .png()
    .toFile(fileURLToPath(new URL(`../public/${name}`, import.meta.url)));
  console.log("wrote", name);
}
