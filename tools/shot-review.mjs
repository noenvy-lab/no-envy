// Pictures of what a first-time visitor sees, one screenful at a time, for a look with fresh eyes.
// Starts its own local server and stops it. Usage: node tools/shot-review.mjs [folder]
// A lab tool: it uses the lab's copy of playwright-core and its headless browser (see tools/e2e.mjs).
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./serve.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const lab = join(here, "..", "..");
const { chromium } = createRequire(join(lab, "game", "package.json"))("playwright-core");
const executablePath = process.env.NOENVY_CHROME ?? join(lab, "work", "chromium", "chrome-win", "headless_shell.exe");
const out = process.argv[2] ?? join(lab, "work", "shots", "aw-review");
await mkdir(out, { recursive: true });

const { server, url } = await startServer(join(here, "..", "site"));
const browser = await chromium.launch({ executablePath });
const problems = [];

async function open(context, address = url) {
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
  page.on("pageerror", (e) => problems.push(String(e)));
  await page.goto(address);
  await page.waitForSelector("#bids .person");
  await page.waitForTimeout(400);
  return page;
}

// One screenful with the given element at the top (a little above it, for context).
async function view(page, selector, name, lift = 70) {
  await page.evaluate(([sel, up]) => {
    const node = document.querySelector(sel);
    window.scrollTo(0, Math.max(0, node.getBoundingClientRect().top + window.scrollY - up));
  }, [selector, lift]);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(out, `${name}.png`) });
}

try {
  // ------------------------------------------------------------ desktop, 1280 x 800
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await open(desktop);
  await view(page, "header.hero", "d01-first-visit-top", 0);
  await view(page, "#bids-heading", "d02-example-amounts");
  await page.click("#solve-button");
  await page.waitForSelector("#result .card");
  await view(page, "#result-heading", "d03-example-result");
  await view(page, "#result table", "d04-example-check-table", 120);

  // Make it a real place: the made-up amounts go, then one housemate fills in a row that does not add up.
  await page.fill("#people-name-0", "Dana");
  await page.locator("#people-name-0").blur();
  await view(page, "header.hero", "d05-after-renaming-top", 0);
  await page.fill("#bid-0-0", "1300");
  await view(page, "#bids-heading", "d06-a-row-that-does-not-add-up");
  await page.click("#solve-button");
  await view(page, "#result-heading", "d07-split-refused");
  await page.click("#sum-0 button");
  await page.click("#solve-button");
  await page.waitForSelector("#result .card");
  await view(page, "#result-heading", "d08-result-with-unanswered-rows");

  await page.click("#ask-list button:nth-child(2)");
  await page.waitForFunction(() => document.getElementById("share-output").value.includes("#s="));
  const benLink = await page.inputValue("#share-output");
  await view(page, "#share-heading", "d09-share-section");
  await page.waitForTimeout(2500); // the assistant block mounts after the page
  await view(page, "#assistant-heading", "d10-assistant-no-key");
  await view(page, "#about-heading", "d11-how-it-works");
  await desktop.close();

  // A rent below zero, on a blank sheet.
  const second = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const blank = await open(second);
  await blank.click("#notice-action");
  await blank.fill("#total", "1000");
  await blank.locator("#total").blur();
  const rows = [[1000, 0, 0], [1000, 0, 0], [500, 500, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) await blank.fill(`#bid-${i}-${j}`, String(rows[i][j]));
  await blank.click("#solve-button");
  await blank.waitForSelector("#result .card");
  await view(blank, "#result-heading", "d12-rent-below-zero");
  await second.close();

  // ------------------------------------------------------------ phone, 390 x 780
  const phone = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const small = await open(phone);
  await view(small, "header.hero", "p01-phone-first-visit-top", 0);
  await view(small, "#bids-heading", "p02-phone-amounts");
  await small.click("#solve-button");
  await small.waitForSelector("#result .card");
  await view(small, "#result-heading", "p03-phone-result");
  await view(small, "#result table", "p04-phone-check-table", 140);
  await phone.close();

  // A housemate opens their own link on a phone.
  const theirs = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const ben = await open(theirs, benLink);
  await view(ben, "header.hero", "p05-housemate-opens-their-link", 0);
  await view(ben, ".names-grid", "p05b-housemate-names-locked", 300);
  await view(ben, "#me-banner", "p06-housemate-banner-and-cards", 20);
  await view(ben, ".person.me", "p07-housemate-own-card", 20);
  await theirs.close();
} finally {
  await browser.close();
  server.close();
}
console.log(problems.length ? `console problems:\n${problems.join("\n")}` : `review pictures written to ${out}`);
