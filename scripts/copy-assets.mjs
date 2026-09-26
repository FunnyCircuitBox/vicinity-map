// Copies open-source files from npm into public/ at build time, so the site hosts everything itself
// and never calls Google or anyone else:
//   - the two fonts (SIL Open Font License) → public/fonts/
//   - the QR code library for "wallet on my phone" (MIT) → public/vendor/qrcode.js
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pub = (p) => fileURLToPath(new URL(`../public/${p}`, import.meta.url));
mkdirSync(pub("fonts/"), { recursive: true });
mkdirSync(pub("vendor/"), { recursive: true });

const fonts = [
  ["@fontsource-variable/inter", "inter-latin-wght-normal.woff2", "inter"],
  ["@fontsource-variable/space-grotesk", "space-grotesk-latin-wght-normal.woff2", "space-grotesk"],
];
for (const [pkg, file, name] of fonts) {
  const dir = dirname(require.resolve(`${pkg}/package.json`));
  copyFileSync(join(dir, "files", file), join(pub("fonts/"), `${name}.woff2`));
  copyFileSync(join(dir, "LICENSE"), join(pub("fonts/"), `LICENSE-${name}.txt`));
  console.log(`font ready: ${name}`);
}

const qr = dirname(require.resolve("qrcode-generator/package.json"));
copyFileSync(join(qr, "qrcode.js"), pub("vendor/qrcode.js"));
console.log("qr code library ready");
