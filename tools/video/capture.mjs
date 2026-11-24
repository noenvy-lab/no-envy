// Records the page parts of the demo video: a real (headless) browser drives the real page, and what it
// shows is saved frame by frame. Nothing is drawn over the page except a pointer, because a headless
// browser has none to show.
//
// Usage: node tools/video/capture.mjs [--url <address>] [--out <folder>] [--only 1|2]
//   --url   the site to record (default: a local server started for the run; use the public address for
//           the real thing, so the story of the video is true)
//   --out   where shot-1-take1.mp4 and shot-2-take1.mp4 go (default ../work/video/raw-aw)
//
// Every step waits for what the caption will claim (a notice, a link, an amount) and stops the run when the
// page does not show it, so a recording cannot quietly show something else.
// The assistant parts (shots 3 and 4) need a real model and a key, so they are not recorded here.
// A lab tool: it uses the lab's copy of playwright-core and its headless browser, and ffmpeg on PATH.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../serve.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const lab = resolve(here, "..", "..", "..");
const { chromium } = createRequire(join(lab, "game", "package.json"))("playwright-core");
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const outDir = resolve(option("--out", join(lab, "work", "video", "raw-aw")));
const only = option("--only", "");
mkdirSync(outDir, { recursive: true });

// The picture area of the finished video is 1728x972 (see codegeist/tools/video/build.mjs). The page is
// laid out 1152 wide and drawn at 1.5x, so a frame is exactly that size and the text is large enough to read
// in a small player. (At 1728 wide the page is a narrow column with small print.)
const VW = 1152, VH = 648, SCALE = 1.5, FPS = 12;

let local = null;
let base = option("--url", "");
if (!base) {
  local = await startServer(join(here, "..", "..", "site"));
  base = local.url;
}
const browser = await chromium.launch({ executablePath: process.env.NOENVY_CHROME ?? join(lab, "work", "chromium", "chrome-win", "headless_shell.exe") });

// One browser profile per person in the story: nothing is shared between them but the links.
async function profile() {
  const context = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: SCALE });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  return context;
}

// A pointer that follows the real mouse events, and a ring where it presses.
const POINTER = `(() => {
  if (window.__pointer) return;
  const p = document.createElement("div");
  p.style.cssText = "position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px)";
  p.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2l15 9-7 1.6L7.6 20z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const ring = document.createElement("div");
  ring.style.cssText = "position:fixed;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid rgba(15,92,90,.75);z-index:2147483646;pointer-events:none;opacity:0;transition:opacity .35s, transform .35s";
  document.documentElement.append(ring, p);
  window.__pointer = p;
  addEventListener("mousemove", (e) => { p.style.transform = "translate(" + (e.clientX - 3) + "px," + (e.clientY - 2) + "px)"; }, true);
  addEventListener("mousedown", (e) => {
    ring.style.transition = "none"; ring.style.left = e.clientX + "px"; ring.style.top = e.clientY + "px"; ring.style.opacity = "1"; ring.style.transform = "scale(.5)";
    requestAnimationFrame(() => { ring.style.transition = "opacity .5s, transform .5s"; ring.style.opacity = "0"; ring.style.transform = "scale(1.4)"; });
  }, true);
})()`;

class Take {
  constructor(page, file) {
    this.page = page;
    this.mouse = { x: VW / 2, y: VH / 2 };
    this.frames = 0;
    this.marks = [];
    this.ffmpeg = spawn("ffmpeg", ["-y", "-v", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
      "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "17", file], { stdio: ["pipe", "inherit", "inherit"] });
    this.done = new Promise((ok, fail) => this.ffmpeg.on("close", (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited with ${code}`)))));
  }

  // Remember where in the recording something starts, for timing the captions (see plan.json).
  mark(label) {
    this.marks.push(`${(this.frames / FPS).toFixed(1)} ${label}`);
  }

  // Continue the same recording on another page (another person's browser); the pointer starts where it was.
  async switchTo(page) {
    this.page = page;
    await page.mouse.move(this.mouse.x, this.mouse.y);
  }

  async frame() {
    const started = Date.now();
    const jpeg = await this.page.screenshot({ type: "jpeg", quality: 92 });
    if (!this.ffmpeg.stdin.write(jpeg)) await new Promise((ok) => this.ffmpeg.stdin.once("drain", ok));
    this.frames++;
    // Keep real time and video time in step, so the page's own animations play at their own speed.
    const wait = 1000 / FPS - (Date.now() - started);
    if (wait > 0) await this.page.waitForTimeout(wait);
  }

  async hold(seconds) {
    for (let k = 0; k < Math.round(seconds * FPS); k++) await this.frame();
  }

  // Bring something to a comfortable height on screen, at reading speed.
  async scrollTo(selector, lift = 90, seconds = 1) {
    const target = await this.page.evaluate(([sel, up]) => {
      const top = document.querySelector(sel).getBoundingClientRect().top + window.scrollY - up;
      return Math.max(0, Math.min(top, document.documentElement.scrollHeight - window.innerHeight));
    }, [selector, lift]);
    const from = await this.page.evaluate(() => window.scrollY);
    if (Math.abs(target - from) < 4) return;
    const steps = Math.max(2, Math.round(seconds * FPS));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const ease = t * t * (3 - 2 * t);
      await this.page.evaluate((y) => window.scrollTo(0, y), from + (target - from) * ease);
      await this.frame();
    }
  }

  async moveTo(selector, seconds = 0.7) {
    const target = this.page.locator(selector).first();
    let box = await target.boundingBox();
    if (!box) throw new Error(`nothing to point at: ${selector}`);
    if (box.y < 60 || box.y + box.height > VH - 40) {
      await this.scrollTo(selector, Math.round(VH * 0.45), 0.8);
      box = await target.boundingBox();
    }
    const to = { x: box.x + Math.min(box.width / 2, 120), y: box.y + box.height / 2 };
    const steps = Math.max(2, Math.round(seconds * FPS));
    const from = { ...this.mouse };
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const ease = t * t * (3 - 2 * t);
      this.mouse = { x: from.x + (to.x - from.x) * ease, y: from.y + (to.y - from.y) * ease };
      await this.page.mouse.move(this.mouse.x, this.mouse.y);
      await this.frame();
    }
  }

  async click(selector, after = 0.6) {
    await this.moveTo(selector);
    await this.hold(0.2);
    await this.page.mouse.down();
    await this.frame();
    await this.page.mouse.up();
    await this.hold(after);
  }

  async type(selector, text) {
    await this.click(selector, 0.15);
    await this.page.keyboard.press("Control+A");
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      await this.frame();
    }
    await this.hold(0.25);
  }

  // Stop the run unless the page says this; the caption of the shot depends on it.
  async expectText(selector, part) {
    await this.page.waitForFunction(([sel, text]) => {
      const node = document.querySelector(sel);
      return Boolean(node) && !node.hidden && ((node.value ?? "") + " " + node.textContent).includes(text);
    }, [selector, part], { timeout: 5000 }).catch(() => {
      throw new Error(`the page does not show "${part}" in ${selector}`);
    });
  }

  async finish() {
    this.ffmpeg.stdin.end();
    await this.done;
    return this.frames / FPS;
  }
}

async function open(context, address) {
  const page = await context.newPage();
  await page.addInitScript(POINTER);
  await page.goto(address);
  await page.waitForSelector("#bids .person");
  await page.evaluate(POINTER);
  await page.waitForTimeout(500);
  return page;
}

const summary = [];
try {
  // ---------------------------------------------------------------- shot 1: the example and its proof
  if (!only || only === "1") {
    const visitor = await profile();
    const page = await open(visitor, base);
    const take = new Take(page, join(outDir, "shot-1-take1.mp4"));
    take.mark("the example");
    await take.hold(3.4);
    await take.click("#hero-solve", 0.2);
    await take.hold(1.2); // the page scrolls to the result by itself
    await take.expectText("#result", "Nobody would rather swap");
    await take.scrollTo("#result-heading", 60, 0.6);
    take.mark("who gets which room");
    await take.hold(5.2);
    await take.scrollTo("#result table", 130);
    take.mark("the table to check it");
    await take.moveTo("#result td.own", 1);
    await take.hold(4.8);
    await take.moveTo("#result .compare", 1);
    take.mark("compared with an even split");
    await take.hold(3.6);
    summary.push(["shot 1", await take.finish(), take.marks]);
    await visitor.close();
  }

  // ---------------------------------------------------------------- shot 2: your own place, each on their own link
  if (!only || only === "2") {
    const danas = await profile();
    const page = await open(danas, base);
    const take = new Take(page, join(outDir, "shot-2-take1.mp4"));
    take.mark("your own place");
    await take.scrollTo("#notice", 16, 0.7);
    await take.hold(0.4);
    await take.type("#people-name-0", "Dana");
    await page.locator("#people-name-0").blur();
    await take.expectText("#notice", "This is your sheet now");
    await take.moveTo("#notice", 0.6);
    await take.hold(2.2);
    take.mark("a link for each housemate");
    await take.scrollTo("#share-heading", 70);
    await take.click("#ask-list button:nth-child(2)", 0.3);
    await take.expectText("#share-status", "Link for Ben copied");
    const benLink = await page.inputValue("#share-output");
    if (!benLink.includes("#s=")) throw new Error("no link for Ben");
    await take.hold(1.8);

    // Ben opens that link in another browser: nothing is shared between the two but the link.
    const bens = await profile();
    const ben = await open(bens, benLink);
    await take.switchTo(ben);
    await take.expectText("#notice", "Ben, this is your copy of the rent sheet");
    take.mark("Ben opens that link");
    await take.hold(2.4);
    await take.click("#notice-action", 0.2);
    await take.hold(1.2);
    await take.scrollTo(".person.me", 150, 0.6);
    await take.type("#bid-1-0", "900");
    await take.type("#bid-1-1", "900");
    await take.type("#bid-1-2", "600");
    await ben.locator("#bid-1-2").blur();
    await take.expectText("#sum-1", "Adds up");
    take.mark("the reply link");
    await take.click("#me-copy", 0.3);
    await take.expectText("#me-status", "Your reply link copied");
    await take.scrollTo("#me-copy", 380, 0.5);
    const reply = await ben.inputValue("#me-output");
    if (!reply.includes("#in=")) throw new Error("no reply link");
    await take.hold(2.2);

    // Dana opens the reply link in the browser where the sheet lives: Ben's amounts drop in.
    const inbox = await open(danas, reply);
    await take.switchTo(inbox);
    await take.expectText("#notice", "Ben's amounts are in.");
    take.mark("the reply arrives");
    await take.scrollTo("#notice", 16, 0.4);
    await take.moveTo("#notice", 0.6);
    await take.hold(1.8);
    await take.scrollTo("#bids .person", 200, 0.9);
    await take.expectText("#bid-1-0", "900");
    await take.moveTo("#bid-1-0", 0.6);
    await take.hold(2.6);
    summary.push(["shot 2", await take.finish(), take.marks]);
    await bens.close();
    await danas.close();
  }
} finally {
  await browser.close();
  local?.server.close();
}
for (const [name, seconds, marks] of summary) console.log(`${name}: ${seconds.toFixed(1)} s\n  ${marks.join("\n  ")}`);
console.log(`recorded from ${base} into ${outDir}`);
