// Phone-width screenshots of the whole page, including the assistant block, for a layout review.
// Starts its own local server and stops it. Usage: node tools/shot-phone.mjs [screenshot folder]
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./serve.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const lab = join(here, "..", "..");
const require = createRequire(join(lab, "game", "package.json"));
const { chromium } = require("playwright-core");
const executablePath = process.env.NOENVY_CHROME ?? join(lab, "work", "chromium", "chrome-win", "headless_shell.exe");
const shots = process.argv[2] ?? join(lab, "work", "shots", "aw");
await mkdir(shots, { recursive: true });

// NOENVY_URL=https://... looks at a published copy instead of serving the local folder.
const { server, url } = process.env.NOENVY_URL ? { server: { close() {} }, url: process.env.NOENVY_URL } : await startServer(join(here, "..", "site"));
const browser = await chromium.launch({ executablePath });
try {
  for (const [w, h] of [[360, 740], [390, 844]]) {
    const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const problems = [];
    page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
    page.on("pageerror", (e) => problems.push(String(e)));
    await page.goto(url);
    await page.waitForSelector("#bids .person");
    await page.click("#solve-button");
    await page.waitForTimeout(600);
    // Wait for the assistant block to mount (it loads the runtime after the page).
    await page.waitForTimeout(2500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    // One picture per section: a full-page picture of a phone layout is too tall to read.
    const sections = await page.evaluate(() => [...document.querySelectorAll('header.hero, section.step, footer')].map((el) => {
      const r = el.getBoundingClientRect();
      return { name: el.id || el.getAttribute('aria-labelledby') || el.tagName.toLowerCase(), top: Math.round(r.top + window.scrollY), height: Math.round(r.height) };
    }));
    for (const sec of sections) console.log(`   ${String(sec.height).padStart(5)}px  ${sec.name}`);
    const a = sections.find((x) => x.name === 'assistant');
    if (a) {
      await page.screenshot({ path: join(shots, `p-${w}-assistant.png`), fullPage: true, clip: { x: 0, y: a.top, width: w, height: Math.min(a.height, 2600) } });
      if (a.height > 2600) await page.screenshot({ path: join(shots, `p-${w}-assistant-2.png`), fullPage: true, clip: { x: 0, y: a.top + 2600, width: w, height: Math.min(a.height - 2600, 2600) } });
    }
    const r = sections.find((x) => x.name === 'result-heading');
    if (r) await page.screenshot({ path: join(shots, `p-${w}-result.png`), fullPage: true, clip: { x: 0, y: r.top, width: w, height: Math.min(r.height, 2600) } });
    const tall = await page.evaluate(() => document.documentElement.scrollHeight);
    console.log(`${w}x${h}: horizontal overflow ${overflow}px, page height ${tall}px, console problems ${problems.length}`);
    for (const p of problems.slice(0, 5)) console.log(`   ${p}`);
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
