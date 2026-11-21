// Screenshots <outdir>/*.html (the <article> element) to PNG with playwright-core.
// Usage: CHROME=/path/to/chrome-or-headless-shell [PLAYWRIGHT_CORE=/path/to/playwright-core] node scripts/shoot.mjs <outdir>
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const out = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: node scripts/shoot.mjs <outdir>");
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
const page = await (await browser.newContext({ viewport: { width: 860, height: 600 }, deviceScaleFactor: 2 })).newPage();
for (const f of readdirSync(out).filter((n) => n.endsWith(".html"))) {
	await page.goto(`file://${join(out, f)}`);
	await page.locator("article").screenshot({ path: join(out, f.replace(/\.html$/, ".png")) });
}
await browser.close();
