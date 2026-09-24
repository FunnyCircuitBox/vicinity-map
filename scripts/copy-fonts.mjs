// Copies the two open-source fonts (SIL Open Font License) from npm into public/fonts
// at build time, so the site hosts its own fonts and never calls Google or anyone else.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const out = fileURLToPath(new URL("../public/fonts/", import.meta.url));
mkdirSync(out, { recursive: true });

const fonts = [
  ["@fontsource-variable/inter", "inter-latin-wght-normal.woff2", "inter"],
  ["@fontsource-variable/space-grotesk", "space-grotesk-latin-wght-normal.woff2", "space-grotesk"],
];
for (const [pkg, file, name] of fonts) {
  const dir = dirname(require.resolve(`${pkg}/package.json`));
  copyFileSync(join(dir, "files", file), join(out, `${name}.woff2`));
  copyFileSync(join(dir, "LICENSE"), join(out, `LICENSE-${name}.txt`));
  console.log(`font ready: ${name}`);
}
