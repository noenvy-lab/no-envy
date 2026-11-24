// Checks the page in a real headless browser and saves screenshots for review.
// It starts its own server on a free local port and stops it at the end.
// Usage: node tools/e2e.mjs [screenshot folder]
// playwright-core and the browser are optional tools, not dependencies of the site (see below).
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./serve.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const lab = join(here, "..", "..");
// playwright-core is not a dependency of the site. Use this project's own copy if one was installed
// (npm i --no-save playwright-core); otherwise the copy of the lab this was built in.
let chromium;
try {
  ({ chromium } = createRequire(join(here, "..", "package.json"))("playwright-core"));
} catch {
  try {
    ({ chromium } = createRequire(join(lab, "game", "package.json"))("playwright-core"));
  } catch {
    console.error("playwright-core is not installed. Run: npm i --no-save playwright-core");
    process.exit(2);
  }
}
const labChrome = join(lab, "work", "chromium", "chrome-win", "headless_shell.exe");
const executablePath = process.env.NOENVY_CHROME ?? (existsSync(labChrome) ? labChrome : undefined);
if (!executablePath) {
  console.error("No browser to run the checks in. Set NOENVY_CHROME to the path of a Chromium or Chrome.");
  process.exit(2);
}
const shots = process.argv[2] ?? (existsSync(join(lab, "work")) ? join(lab, "work", "shots", "aw") : join(here, "..", "e2e-shots"));
await mkdir(shots, { recursive: true });

const { server, url } = await startServer(join(here, "..", "site"));
const browser = await chromium.launch({ executablePath });
const failures = [];
let passed = 0;

async function check(name, body) {
  try {
    await body();
    passed++;
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name}\n     ${String(error.message).split("\n")[0]}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function open(context, address = url) {
  const page = await context.newPage();
  page.problems = [];
  page.on("console", (m) => { if (m.type() === "error") page.problems.push(m.text()); });
  page.on("pageerror", (e) => page.problems.push(String(e)));
  page.on("dialog", (d) => { page.problems.push(`dialog: ${d.message()}`); d.dismiss(); });
  await page.goto(address);
  await page.waitForSelector("#bids .person");
  return page;
}

const text = (page, selector) => page.locator(selector).innerText();

const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await open(desktop);

await check("first visit shows the example, ready to split", async () => {
  expect((await text(page, "#notice")).includes("example"), "no example notice");
  expect(await page.locator("#bids .person").count() === 3, "expected 3 cards");
  expect(await page.locator("#bids .sum.ok").count() === 3, "all rows should add up");
  expect((await text(page, "#result")).includes("Press the button"), "placeholder missing");
  expect(await page.inputValue("#total") === "2400", "total");
  expect((await text(page, "#hero-solve")) === "See the example's fair split", "the top of the page offers the example's result");
  await page.screenshot({ path: join(shots, "d-01-start.png"), fullPage: true });
});

await check("solving shows rooms, rents, the check table and the comparison", async () => {
  // The button at the top of the page does the same as the one in step 3.
  await page.click("#hero-solve");
  await page.waitForSelector("#result .card");
  const cards = await page.locator("#result .card").allInnerTexts();
  expect(cards.length === 3, "3 result cards");
  expect(cards[0].includes("Ana") && cards[0].includes("Big room with balcony") && cards[0].includes("$1,083"), `Ana's card: ${cards[0]}`);
  expect((await text(page, "#result .verdict")).includes("Nobody would rather swap"), "verdict");
  expect(await page.locator("#result td.own").count() === 3, "one highlighted cell per person");
  expect(await page.locator("#result td.envied").count() === 0, "no envied cells");
  expect((await text(page, "#result .compare")).includes("Ben and Chloe would rather have Big room with balcony (by $100 and $200)"), await text(page, "#result .compare"));
  // Every row: the highlighted number is the largest.
  const rows = await page.locator("#result tbody tr").evaluateAll((trs) => trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => ({ own: td.classList.contains("own"), v: Number(td.textContent.replace(/[^0-9−-]/g, "").replace("−", "-")) }))));
  for (const row of rows) expect(Math.max(...row.map((c) => c.v)) === row.find((c) => c.own).v, "own room is not the best in its row");
  await page.screenshot({ path: join(shots, "d-02-result.png"), fullPage: true });
});

await check("a row that does not add up blocks the split and can be fixed", async () => {
  await page.fill("#bid-1-0", "1150");
  expect((await text(page, "#sum-1")).includes("$200 over the rent"), await text(page, "#sum-1"));
  expect(await page.inputValue("#range-1-0") === "1150", "slider follows the box");
  expect((await text(page, "#result")).includes("Before splitting: Ben's amounts are $200 over"), "result should be cleared");
  await page.click("#solve-button");
  expect((await text(page, "#solve-error")).includes("Ben's amounts are $200 over"), "solve error");
  // The reason is said once; under it comes the way out, not the same sentence again.
  expect(!(await text(page, "#result")).includes("Ben's amounts") && (await text(page, "#result")).includes("Scale to"), await text(page, "#result"));
  await page.click("#sum-1 button");
  expect((await text(page, "#sum-1")).includes("Adds up to $2,400"), "balanced");
  expect(await page.locator("#solve-error").isHidden(), "error cleared");
  const values = await Promise.all([0, 1, 2].map((j) => page.inputValue(`#bid-1-${j}`)));
  expect(values.reduce((a, v) => a + Number(v), 0) === 2400, `row sums to ${values}`);
  await page.click("#solve-button");
  await page.waitForSelector("#result .card");
});

await check("typing keeps focus and a too-large number is capped", async () => {
  await page.click("#bid-0-1");
  await page.keyboard.press("Control+A");
  await page.keyboard.type("99999");
  expect(await page.inputValue("#bid-0-1") === "2400", "capped at the total");
  expect(await page.evaluate(() => document.activeElement.id) === "bid-0-1", "focus lost while typing");
  await page.keyboard.press("Control+A");
  await page.keyboard.type("750");
  await page.fill("#bid-0-0", "1200");
  await page.fill("#bid-0-2", "450");
  expect((await text(page, "#sum-0")).includes("Adds up"), "Ana adds up again");
});

await check("sliders move the number", async () => {
  await page.locator("#range-2-2").focus();
  const before = Number(await page.inputValue("#bid-2-2"));
  await page.keyboard.press("ArrowRight");
  const after = Number(await page.inputValue("#bid-2-2"));
  expect(after === before + 10, `slider step: ${before} -> ${after}`);
  await page.keyboard.press("ArrowLeft");
  expect((await text(page, "#sum-2")).includes("Adds up"), "back to adding up");
});

await check("adding a housemate and changing the total", async () => {
  await page.click("#count-plus");
  expect(await text(page, "#count-value") === "4", "count");
  expect(await page.locator("#bids .person").count() === 4, "4 cards");
  expect(await page.inputValue("#people-name-3") === "Housemate 4", "new name");
  expect(await page.inputValue("#bid-3-0") === "600", "even split to start");
  await page.fill("#total", "3000");
  await page.locator("#total").blur();
  expect(await page.inputValue("#bid-3-0") === "750", "rescaled");
  // Changing the head count started every row again: they add up, but nobody has entered them, and they say so.
  expect(await page.locator("#bids .sum.pending").count() === 4 && await page.locator("#bids .sum.off").count() === 0, "four placeholder rows after rescale");
  expect((await text(page, "#sum-3")).includes("Not entered yet"), await text(page, "#sum-3"));
  await page.fill("#people-name-3", "ana");
  await page.locator("#people-name-3").blur();
  expect((await text(page, "#setup-error")).includes("appears twice"), "duplicate name refused");
  await page.fill("#people-name-3", "Dev");
  await page.locator("#people-name-3").blur();
  expect(await page.locator("#setup-error").isHidden(), "error cleared");
  expect((await text(page, "#person-title-3")) === "Dev", "card renamed");
  await page.fill("#rooms-name-3", "Attic");
  await page.locator("#rooms-name-3").blur();
  await page.fill("#currency", "NT$");
  await page.locator("#currency").blur();
  await page.click("#solve-button");
  await page.waitForSelector("#result .card");
  expect((await text(page, "#result")).includes("NT$"), "currency shown");
  expect(await page.locator("#result .card").count() === 4, "4 result cards");
  await page.screenshot({ path: join(shots, "d-03-four.png"), fullPage: true });
});

await check("the sheet survives a reload", async () => {
  await page.reload();
  await page.waitForSelector("#bids .person");
  expect(await page.locator("#bids .person").count() === 4, "4 cards after reload");
  expect(await page.inputValue("#people-name-3") === "Dev", "name kept");
  expect(await page.inputValue("#total") === "3000", "total kept");
  expect(await page.locator("#notice").isHidden(), "no example notice on an edited sheet");
});

let replyAddress = "";
let benLink = "";
await check("a housemate fills in their own numbers from a link", async () => {
  // The organiser has entered Ana's amounts. Ben's link must not show them.
  for (const [room, amount] of [1500, 500, 500, 500].entries()) await page.fill(`#bid-0-${room}`, String(amount));
  await page.click("#ask-list button:nth-child(2)");
  await page.waitForFunction(() => document.getElementById("share-output").value.includes("#s="));
  const link = await page.inputValue("#share-output");
  expect(link.endsWith("&me=1"), "link names the person");
  benLink = link;
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const theirs = await open(phone, link);
  expect(!(await theirs.evaluate(() => window.location.hash)), "numbers removed from the address after loading");
  expect((await text(theirs, "#me-text")).startsWith("Ben, fill in your amounts"), "banner");
  expect(await theirs.locator("#bids .person.me").count() === 1, "own card outlined");
  expect(await theirs.inputValue("#people-name-3") === "Dev", "same sheet");
  expect((await text(theirs, "#notice")).startsWith("Ben, this is your copy of the rent sheet"), await text(theirs, "#notice"));
  // Only Ben's card is a form here: the others' amounts did not travel, and the set-up is not his to change.
  expect(await theirs.locator("#bid-0-0").count() === 0 && await theirs.locator("#bids .person.other").count() === 3, "the other housemates' cards are not forms");
  expect(await theirs.locator("#total").isDisabled() && await theirs.locator("#people-name-0").isDisabled() && await theirs.locator("#count-plus").isDisabled(), "the set-up is locked on a housemate's copy");
  expect((await text(theirs, "#person-title-1")) === "Ben (you)", await text(theirs, "#person-title-1"));
  // His copy has nobody else's amounts, so it does not offer a split (it would rest on placeholders) or
  // links for the others (they would carry an incomplete sheet). It says who works out the split.
  expect(await theirs.locator("#solve-button").isHidden() && await theirs.locator("#hero-solve").isHidden(), "a housemate's copy still offers to find the split");
  expect(await theirs.locator("#share-step").isHidden() && await theirs.locator("#share-hint").isHidden(), "a housemate's copy still offers links for the others");
  expect((await text(theirs, "#guest-split-note")).includes("worked out by whoever sent you this page"), "no word on who works out the split");
  // A reply has to be his own answer, not the placeholder he was sent.
  await theirs.click(".person.me .reply");
  expect((await text(theirs, "#me-status")).includes("still shows the even placeholder"), await text(theirs, "#me-status"));
  // The answer to the button is where the housemate is looking: inside their card, on screen.
  expect(await theirs.locator("#me-status").evaluate((node) => { const box = node.getBoundingClientRect(); return node.closest(".person.me") !== null && box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight; }), "the answer to the reply button is on screen, in the card");
  expect((await text(theirs, "#me-text")).includes("does not carry the other housemates' amounts"), "banner says the others are left out");
  await theirs.fill("#bid-1-0", "500");
  await theirs.fill("#bid-1-1", "1500");
  await theirs.fill("#bid-1-2", "400");
  await theirs.click("#me-copy");
  expect((await text(theirs, "#me-status")).includes("need to add up"), "refuses a reply that does not add up");
  await theirs.fill("#bid-1-3", "600");
  await theirs.click("#me-copy");
  await theirs.waitForFunction(() => document.getElementById("me-output")?.value.includes("#in="));
  replyAddress = await theirs.inputValue("#me-output");
  // (Waited for: the page writes this once the browser has answered about the clipboard.)
  await theirs.waitForFunction(() => document.getElementById("me-status").textContent.includes("Your reply link"));
  await theirs.screenshot({ path: join(shots, "m-01-housemate.png"), fullPage: true });
  await theirs.reload();
  await theirs.waitForSelector("#bids .person");
  expect(await theirs.locator("#bids .person.me").count() === 1, "still their card after a reload");
  expect(await theirs.inputValue("#bid-1-1") === "1500", "their numbers kept");
  expect(theirs.problems.length === 0, `phone page errors: ${theirs.problems.join(" | ")}`);
  await phone.close();
});

await check("the reply link drops their numbers into the organiser's sheet", async () => {
  const back = await open(desktop, replyAddress);
  expect((await text(back, "#notice")).includes("Ben's amounts are in."), await text(back, "#notice"));
  expect(await back.inputValue("#bid-1-1") === "1500", "Ben's number arrived");
  expect(await back.inputValue("#bid-0-0") === "1500", "others untouched");
  expect(!(await back.evaluate(() => window.location.hash)), "address cleaned");
  await back.click("#solve-button");
  await back.waitForSelector("#result .card");
  expect(back.problems.length === 0, back.problems.join(" | "));
  await back.close();
  // The organiser's first tab was open all along. It has to follow, or its next edit would wipe the reply out.
  await page.waitForFunction(() => document.getElementById("bid-1-1").value === "1500");
  expect((await text(page, "#notice")).includes("another tab"), await text(page, "#notice"));
  await page.fill("#bid-2-0", "900");
  await page.fill("#bid-2-1", "600");
  await page.reload();
  await page.waitForSelector("#bids .person");
  expect(await page.inputValue("#bid-1-1") === "1500", "the reply survived an edit in the first tab");
  expect(await page.inputValue("#bid-2-0") === "900", "and so did that edit");
});

await check("a reply for another sheet, and a damaged link, are refused in words", async () => {
  const stranger = await browser.newContext();
  const fresh = await open(stranger, replyAddress);
  expect((await text(fresh, "#notice")).includes("Open it in the browser where the rent sheet was started"), await text(fresh, "#notice"));
  await fresh.close();
  const broken = await open(stranger, `${url}#s=abc123`);
  expect((await text(broken, "#notice")).includes("could not be read"), await text(broken, "#notice"));
  expect(await broken.locator("#bids .person").count() === 3, "falls back to the example");
  await stranger.close();
});

await check("a link pasted into the page that is already open is taken in", async () => {
  const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem("no-envy.sheet.v1")));
  const reply = { v: 1, id: stored.id, person: 3, name: stored.p[3], amounts: [300, 300, 300, 2100], total: stored.t, rooms: stored.r };
  const pack = (data) => Buffer.from(JSON.stringify(data)).toString("base64url");
  await page.evaluate((hash) => { window.location.hash = hash; }, `#in=${pack(reply)}`);
  await page.waitForFunction(() => document.getElementById("bid-3-3").value === "2100");
  expect((await text(page, "#notice")).includes("Dev's amounts are in."), await text(page, "#notice"));
  expect(!(await page.evaluate(() => window.location.hash)), "address cleaned");
  // Amounts go to rooms by position: a reply written for another room order is refused, in words.
  await page.evaluate((hash) => { window.location.hash = hash; }, `#in=${pack({ ...reply, amounts: [2100, 300, 300, 300], rooms: [...stored.r].reverse() })}`);
  await page.waitForFunction(() => document.getElementById("notice-text").textContent.includes("rooms on this sheet have changed"));
  expect(await page.inputValue("#bid-3-3") === "2100", "the refused reply changed nothing");
});

await check("an older link to the same sheet does not silently replace newer numbers", async () => {
  await page.click("#share-sheet");
  await page.waitForFunction(() => document.getElementById("share-output").value.includes("#s="));
  const older = await page.inputValue("#share-output");
  await page.fill("#bid-3-3", "2000");
  await page.fill("#bid-3-0", "400");
  const again = await open(desktop, older);
  expect((await text(again, "#notice")).includes("The sheet you had before is kept."), await text(again, "#notice"));
  expect(await again.inputValue("#bid-3-3") === "2100", "the link's copy is shown");
  // The way back is still offered after a reload, as long as the newly opened sheet has not been changed.
  // (Let the assistant block finish loading first: a reload in the middle of it logs an aborted fetch.)
  await again.waitForLoadState("networkidle");
  await again.reload();
  await again.waitForSelector("#bids .person");
  expect((await text(again, "#notice")).includes("The sheet you had before is still kept."), await text(again, "#notice"));
  await again.click("#notice-action");
  expect(await again.inputValue("#bid-3-3") === "2000", "one press brings the newer numbers back");
  expect(again.problems.length === 0, again.problems.join(" | "));
  await again.close();
  await page.waitForFunction(() => document.getElementById("bid-3-3").value === "2000");
});

await check("a housemate's link opened where the whole sheet lives replaces nothing", async () => {
  const own = await open(desktop, benLink);
  expect((await text(own, "#notice")).includes("That is the link for Ben"), await text(own, "#notice"));
  expect(await own.inputValue("#bid-0-0") === "1500", "Ana's amounts are still here");
  expect(await own.locator("#me-banner").isHidden(), "the organiser is not treated as the housemate");
  await own.close();
});

await check("another tab that opens a different sheet does not strand this one", async () => {
  const other = { v: 1, id: "zzzz9999", c: "$", t: 900, p: ["Kim", "Lou", "Max"], r: ["North", "South", "Attic"], b: [[500, 300, 100], [300, 300, 300], [300, 300, 300]], d: [1, 0, 0], n: 0, e: 0 };
  const second = await open(desktop, `${url}#s=${Buffer.from(JSON.stringify(other)).toString("base64url")}`);
  expect(await second.inputValue("#people-name-0") === "Kim", "the other sheet is shown in the new tab");
  // The first tab was showing the organiser's sheet. It follows (one sheet per browser) and offers the way back.
  await page.waitForFunction(() => document.getElementById("people-name-0").value === "Kim");
  expect((await text(page, "#notice")).includes("opened a different rent sheet"), await text(page, "#notice"));
  await page.click("#notice-action");
  expect(await page.inputValue("#people-name-3") === "Dev", "the organiser's sheet is back");
  expect(await page.inputValue("#bid-1-1") === "1500", "with Ben's amounts");
  await second.close();
});

await check("changing the head count says what it reset and can be undone", async () => {
  await page.click("#count-plus");
  expect(await page.locator("#bids .person").count() === 5, "5 cards");
  expect((await text(page, "#notice")).includes("started everyone's amounts again"), await text(page, "#notice"));
  expect((await text(page, "#notice-action")) === "Undo that change", "undo offered");
  await page.click("#notice-action");
  expect(await page.locator("#bids .person").count() === 4, "back to 4 cards");
  expect(await page.inputValue("#bid-1-1") === "1500", "Ben's amounts are back");
  expect(await page.locator("#notice").isHidden(), "nothing further to undo");
});

await check("the example's made-up amounts never become a real housemate's", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const fresh = await open(context);
  expect(await fresh.getByRole("spinbutton", { name: "Total monthly rent", exact: true }).count() === 1, "the total rent box has no name for a screen reader");
  await fresh.fill("#currency", "€");
  await fresh.locator("#currency").blur();
  expect(await fresh.inputValue("#bid-0-0") === "1200", "a currency sign alone leaves the example alone");
  await fresh.fill("#people-name-0", "Dana");
  await fresh.locator("#people-name-0").blur();
  expect(await fresh.inputValue("#bid-0-0") === "800" && await fresh.inputValue("#bid-1-0") === "800", "amounts back to the even placeholder");
  expect((await text(fresh, "#notice")).includes("made-up amounts are gone"), await text(fresh, "#notice"));
  expect((await text(fresh, "#sum-1")).includes("Not entered yet"), "a placeholder row does not get a green tick");
  await fresh.click("#solve-button");
  await fresh.waitForSelector("#result .card");
  expect((await text(fresh, "#result .verdict")).startsWith("Provisional: nobody has entered amounts yet"), await text(fresh, "#result .verdict"));
  expect((await fresh.locator("#result .card .why").first().innerText()).startsWith("Has not entered amounts yet"), "a card must not say what somebody 'said'");
  expect((await text(fresh, "#result .note")).includes("Dana, Ben and Chloe have not entered amounts yet"), await text(fresh, "#result .note"));
  expect((await text(fresh, "#result .compare")).includes("the fair split is the even one"), await text(fresh, "#result .compare"));
  await fresh.screenshot({ path: join(shots, "d-05-unanswered.png"), fullPage: true });
  expect(fresh.problems.length === 0, fresh.problems.join(" | "));
  await context.close();
});

await check("names from a link are shown as text, never run", async () => {
  const hostile = { v: 1, id: "abcd1234", c: "$", t: 900, p: ["<img src=x onerror=a()>", "<b>Bo</b>", "C"], r: ["<script>x</script>", "R2", "R3"], b: [[300, 300, 300], [300, 300, 300], [300, 300, 300]], d: [1, 1, 1], n: 0, e: 0 };
  const payload = Buffer.from(JSON.stringify(hostile)).toString("base64url");
  const context = await browser.newContext();
  const victim = await open(context, `${url}#s=${payload}&me=0`);
  await victim.click("#solve-button");
  await victim.waitForSelector("#result .card");
  expect(await victim.locator("main img, main script, main b").count() === 0, "markup from a link became elements");
  expect((await text(victim, "#person-title-0")) === "<img src=x onerror=a()> (you)", "name shown literally");
  expect(victim.problems.length === 0, victim.problems.join(" | "));
  await context.close();
});

await check("blank sheet, then a negative rent with its explanation", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const blank = await open(context);
  await blank.click("#notice-action");
  expect(await blank.inputValue("#total") === "", "blank total");
  expect((await text(blank, "#result")).includes("Enter the total rent"), "says what is missing");
  expect((await text(blank, "#sum-0")).includes("Enter the total rent first"), "row status");
  await blank.fill("#total", "1000");
  await blank.locator("#total").blur();
  const rows = [[1000, 0, 0], [1000, 0, 0], [500, 500, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) await blank.fill(`#bid-${i}-${j}`, String(rows[i][j]));
  await blank.click("#solve-button");
  await blank.waitForSelector("#result .card");
  expect((await text(blank, "#result .note")).includes("has a rent below zero"), "negative rent note");
  expect((await text(blank, "#result")).includes("−$166"), "negative amount shown with a minus sign");
  const pays = await blank.locator("#result .card .pays").allInnerTexts();
  expect(pays.some((t) => t.includes("gets") && t.includes("$166")), `the card says who gets paid: ${pays.join(" | ")}`);
  await blank.screenshot({ path: join(shots, "d-04-negative.png"), fullPage: true });
  await blank.check("#non-negative");
  await blank.click("#solve-button");
  // Either the site says no such split exists, or every rent shown is zero or more.
  const error = await blank.locator("#solve-error").isHidden() ? "" : await text(blank, "#solve-error");
  const rents = await blank.locator("#result .card .pays").allInnerTexts();
  expect(error.includes("zero or more") || (rents.length === 3 && rents.every((r) => !r.includes("−"))), `strict option: ${error} / ${rents.join(" ")}`);
  expect(await blank.locator("#result .note").count() === 0, "no negative-rent note with the option on");
  expect(blank.problems.length === 0, blank.problems.join(" | "));
  await context.close();
});

await check("phone layout: nothing wider than the screen", async () => {
  const phone = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const small = await open(phone);
  await small.click("#solve-button");
  await small.waitForSelector("#result .card");
  const overflow = await small.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow <= 0, `page is ${overflow}px wider than the screen`);
  const smallTargets = await small.evaluate(() => Array.from(document.querySelectorAll("button, input[type=number], input[type=text]")).filter((n) => n.offsetParent && n.getBoundingClientRect().height < 36).map((n) => n.id || n.textContent));
  expect(smallTargets.length === 0, `small touch targets: ${smallTargets.join(", ")}`);
  await small.screenshot({ path: join(shots, "m-02-result.png"), fullPage: true });
  expect(small.problems.length === 0, small.problems.join(" | "));
  await phone.close();
});

await check("assistant: mounts without a key, and its actions drive the real page with an undo", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const tab = await open(context);
  await tab.waitForFunction(() => /needs your AI provider key/.test(document.querySelector("#assistant-status").textContent), null, { timeout: 20000 });
  expect(await tab.locator("#agent-app #ns-input").count() === 1, "no chat input");
  // Run the registered actions as the runtime would, with no model: a read, then a write.
  const outcome = await tab.evaluate(async () => {
    const { engine } = window.__nsweb;
    const scope = { base: engine.top.base, network: engine.top.network.name };
    const run = async (name, args) => {
      const entry = engine.actions.catalog(scope).find((e) => e.name === name);
      const plan = engine.actions.prepare({ kind: "action", action: entry.ref, arguments: args });
      return (await engine.actions.execute(plan, () => true, "e2e"))[0];
    };
    const names = engine.actions.catalog(scope).map((e) => `${e.name}:${e.effect}:${e.availability}`);
    const read = await run("get_rent_sheet", {});
    const wrote = await run("set_amounts", { person: 1, amounts: [1000, 900, 500] });
    const split = await run("find_split", {});
    return { names, read, wrote, split };
  });
  expect(outcome.names.length === 6 && outcome.names.every((n) => n.endsWith(":local-only")), `actions: ${outcome.names.join(", ")}`);
  expect(outcome.read.status === "succeeded" && outcome.read.result.people[0].name === "Ana", "read action");
  expect(outcome.wrote.result.ok === true, "write action");
  expect(await tab.inputValue("#bid-1-0") === "1000", "the page did not show the assistant's change");
  expect(outcome.split.result.ok === true && await tab.locator("#result .card").count() === 3, "split not shown");
  expect((await text(tab, "#notice")).includes("Undo that change"), "no undo offered");
  // The same offer is next to the chat and stays in view there: the top of the page is far away.
  await tab.locator("#ns-input").scrollIntoViewIfNeeded();
  await tab.waitForTimeout(200);
  const near = await tab.evaluate(() => {
    const box = document.getElementById("assistant-change");
    const at = box.getBoundingClientRect();
    const top = document.getElementById("notice").getBoundingClientRect();
    return { text: box.innerText, inView: at.height > 0 && at.top >= 0 && at.bottom <= window.innerHeight, topNoticeInView: top.bottom > 0 && top.top < window.innerHeight };
  });
  expect(near.text.includes("The assistant filled in one person's amounts.") && near.text.includes("Undo that change") && near.inView, `the offer next to the chat: ${JSON.stringify(near)}`);
  expect(near.topNoticeInView === false, "this check is only worth something while the top notice is out of sight");
  await tab.locator("#assistant").scrollIntoViewIfNeeded();
  await tab.screenshot({ path: join(shots, "d-06-assistant.png"), fullPage: true });
  await tab.click("#assistant-change-undo");
  expect((await text(tab, "#assistant-change")).includes("That is undone.") && await tab.locator("#assistant-change-undo").isHidden(), "the chat side says the undo worked");
  // It covers nothing: it sits under the chat, and the chat's input row is still fully on show.
  const places = await tab.evaluate(() => {
    const line = document.getElementById("assistant-change").getBoundingClientRect();
    const chat = document.querySelector('#agent-app [data-ns-slot="chat"]').getBoundingClientRect();
    return { under: line.top >= chat.bottom - 1, gap: Math.round(line.top - chat.bottom) };
  });
  expect(places.under && places.gap < 40, `the line is not directly under the chat: ${JSON.stringify(places)}`);
  // With the input row at the very bottom of the screen the line would be just out of sight: a new change
  // by the assistant brings it in.
  await tab.evaluate(() => {
    const chat = document.querySelector('#agent-app [data-ns-slot="chat"]').getBoundingClientRect();
    window.scrollTo(0, window.scrollY + chat.bottom - window.innerHeight + 2);
  });
  await tab.evaluate(async () => {
    const { engine } = window.__nsweb;
    const scope = { base: engine.top.base, network: engine.top.network.name };
    const entry = engine.actions.catalog(scope).find((e) => e.name === "set_amounts");
    await engine.actions.execute(engine.actions.prepare({ kind: "action", action: entry.ref, arguments: { person: 1, amounts: [1000, 900, 500] } }), () => true, "e2e");
  });
  await tab.waitForTimeout(900);
  const shown = await tab.evaluate(() => { const at = document.getElementById("assistant-change").getBoundingClientRect(); return { top: Math.round(at.top), bottom: Math.round(at.bottom), screen: window.innerHeight }; });
  expect(shown.top >= 0 && shown.bottom <= shown.screen, `a new change did not bring the line into view: ${JSON.stringify(shown)}`);
  await tab.click("#assistant-change-undo");
  const back = await tab.evaluate(() => JSON.stringify({ n: document.querySelector("#notice").innerText, v: document.querySelector("#bid-1-0").value }));
  expect(await tab.inputValue("#bid-1-0") === "950", `undo did not restore: ${back}`);
  const harmless = (m) => /Password field is not contained in a form/.test(m);
  const real = tab.problems.filter((m) => !harmless(m));
  expect(real.length === 0, real.join(" | "));
  await context.close();
});

await check("partner: the card for Plainly shows before any contact, and declining contacts nothing", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Nothing in this test may reach the partner's real site: count and block every request to it.
  const reached = [];
  await context.route(/sainath998\.github\.io/, (route) => { reached.push(route.request().url()); return route.abort(); });
  const tab = await open(context);
  await tab.waitForFunction(() => /needs your AI provider key/.test(document.querySelector("#assistant-status").textContent), null, { timeout: 20000 });
  expect(await tab.getAttribute("#partner-plainly", "href") === "https://sainath998.github.io/plainly-agent/", "the page's link to Plainly");
  // The front agent's partner tool, as the runtime builds it from the published network file.
  const tool = await tab.evaluate(async () => {
    const { engine } = window.__nsweb;
    const spec = engine.top.network.getAgentSpec(engine.top.network.findFrontMan());
    return { tools: spec.tools.filter((t) => String(t).startsWith("http")), label: engine.top.network.linkLabels, peers: engine.top.manifest?.allowed_peers };
  });
  expect(tool.tools.length === 1 && tool.tools[0] === "https://sainath998.github.io/plainly-agent/plainly_document_helper", `partner tools: ${JSON.stringify(tool)}`);
  expect(tool.label && tool.label[tool.tools[0]] === "Plainly", `label: ${JSON.stringify(tool.label)}`);
  // Ask for consent the way a partner call does (runtime/runner.js), with no model and no key.
  await tab.evaluate(() => {
    const { engine } = window.__nsweb;
    window.__consentAnswer = null;
    engine.requestConsent({
      kind: "network", peerLabel: "Plainly", peerOrigin: "sainath998.github.io",
      requestText: "What does 'jointly and severally liable' mean in a rental agreement?",
      est: { totalTokens: 180, costText: null },
    }).then((answer) => { window.__consentAnswer = answer; });
  });
  const card = tab.locator("#ns-msgs .ns-consent").last();
  await card.waitFor({ timeout: 5000 });
  const shown = await card.innerText();
  expect(/Contact Plainly on your behalf\?/.test(shown), `card title: ${shown}`);
  expect(shown.includes("sainath998.github.io") && shown.includes("jointly and severally liable"), `card body: ${shown}`);
  expect(await tab.evaluate(() => window.__consentAnswer) === null, "answered before the visitor chose");
  await card.scrollIntoViewIfNeeded();
  await tab.screenshot({ path: join(shots, "d-07-consent-card.png"), fullPage: false });
  const buttons = await card.locator("button").allInnerTexts();
  expect(buttons.length >= 2, `card buttons: ${buttons.join(" | ")}`);
  await card.locator("button", { hasText: /decline|no|deny/i }).first().click();
  await tab.waitForFunction(() => window.__consentAnswer !== null, null, { timeout: 5000 });
  expect(await tab.evaluate(() => window.__consentAnswer) === "decline", "declining did not decline");
  expect(reached.length === 0, `the partner's site was requested: ${reached.join(", ")}`);
  await context.close();
});

await check("another site can use the split through the bridge: one shared read, real cross-origin call", async () => {
  // The caller is a page on a second local server; another port is another origin, so
  // this is the path a partner site takes: hidden frame on No Envy's origin, postMessage
  // handshake, catalog, then execute. The caller loads the runtime as a partner's own
  // copy would be loaded (here from No Envy's files, which are the same code).
  const partner = url.replace(/\/$/, "");
  const otherRoot = join(lab, "work", "tmp", "e2e-other-site");
  await mkdir(otherRoot, { recursive: true });
  await writeFile(join(otherRoot, "index.html"), "<!doctype html><meta charset=utf-8><title>Another agent site</title><body><p>caller page</p></body>");
  const other = await startServer(otherRoot);
  const caller = other.url.replace(/\/$/, "");
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const tab = await context.newPage();
  const problems = [];
  tab.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
  tab.on("pageerror", (e) => problems.push(String(e)));
  await tab.goto(`${caller}/`);
  expect(await tab.evaluate(() => location.origin) === caller && caller !== partner, "caller origin");
  const outcome = await tab.evaluate(async ({ caller, partner }) => {
    const { ActionRegistry } = await import(`${partner}/runtime/actions.js`);
    const { registerRemoteActions } = await import(`${partner}/runtime/action-transport.js`);
    const manifest = await (await fetch(`${partner}/agent-manifest.json`)).json();
    const registry = new ActionRegistry();
    const scope = { base: partner, network: "no_envy" };
    await registerRemoteActions(registry, scope, manifest);
    const catalog = registry.catalog(scope);
    const run = async (args) => {
      const entry = catalog.find((e) => e.name === "try_split");
      try {
        const plan = registry.prepare({ kind: "action", action: entry.ref, arguments: args });
        return (await registry.execute(plan, () => true, "e2e-bridge"))[0];
      } catch (error) {
        return { threw: String(error.message || error) };
      }
    };
    const good = await run({ total: 2400, people: ["Ana", "Ben", "Chi"], rooms: ["Big", "Middle", "Small"], bids: [[1100, 800, 500], [900, 900, 600], [1000, 700, 700]] });
    const off = await run({ total: 2400, bids: [[1100, 800, 400], [900, 900, 600], [1000, 700, 700]] });
    const frames = document.querySelectorAll("iframe").length;
    return { names: catalog.map((e) => `${e.name}:${e.effect}:${e.availability}`), good, off, frames, issues: registry.discoveryIssues };
  }, { caller, partner });
  expect(outcome.names.join() === "try_split:read:bridge", `shared actions: ${outcome.names.join(", ")} ${JSON.stringify(outcome.issues)}`);
  expect(outcome.good.status === "succeeded" && outcome.good.result.ok === true, `good call: ${JSON.stringify(outcome.good).slice(0, 300)}`);
  const result = outcome.good.result;
  expect(result.rents.reduce((sum, r) => sum + r.rent, 0) === 2400, "rents do not add up to the total");
  expect(result.check.maxEnvy === 0, "someone would rather swap");
  expect(result.assignments.map((a) => a.personName).join() === "Ana,Ben,Chi", "names were not kept");
  expect(outcome.off.status === "succeeded" && outcome.off.result.ok === false && typeof outcome.off.result.reason === "string", `refusal: ${JSON.stringify(outcome.off).slice(0, 300)}`);
  expect(outcome.frames === 0, `the hidden bridge frames were not removed (${outcome.frames})`);
  expect(problems.length === 0, problems.join(" | "));
  await context.close();
  other.server.close();
});

await check("what the comparison line says about the split matches the split's own verdict", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const tab = await open(context);
  // Put a whole sheet on the page through the page's own functions, then press the real button.
  const show = async (total, names, bids) => {
    const refused = await tab.evaluate(async ({ total, names, bids }) => {
      const { App } = await import("./js/app.js");
      const rooms = names.map((_, j) => `Room ${j + 1}`);
      const set = App.page.setSetup({ total, people: names, rooms });
      if (!set.ok) return set.reason;
      for (const [i, row] of bids.entries()) {
        const put = App.page.setBids(i, row);
        if (!put.ok) return put.reason;
      }
      return "";
    }, { total, names, bids });
    expect(refused === "", `the sheet was refused: ${refused}`);
    await tab.click("#solve-button");
    await tab.waitForSelector("#result .compare");
    return { verdict: await text(tab, "#result .verdict"), compare: await text(tab, "#result .compare") };
  };
  // Whole-number rents leave one person a dollar short here (found by a survey of random sheets).
  const near = await show(1000, ["A", "B", "C", "D", "E", "F", "G"], [
    [155, 133, 148, 150, 144, 129, 141], [147, 149, 135, 147, 139, 144, 139], [144, 152, 132, 150, 148, 138, 136], [146, 145, 148, 145, 136, 139, 141],
    [137, 134, 149, 149, 153, 131, 147], [148, 142, 151, 129, 146, 140, 144], [150, 141, 151, 133, 148, 145, 132],
  ]);
  expect(near.verdict.includes("Within $1 of a perfect match"), `verdict: ${near.verdict}`);
  expect(!near.compare.includes("leaves nobody wanting to swap"), `says nobody wants to swap right under "within $1": ${near.compare}`);
  expect(near.compare.includes("nobody would gain more than $1 by swapping"), `compare: ${near.compare}`);
  // Each likes a different room best: the even split is the fair one, and the reason given is a true one.
  const even = await show(2400, ["Ana", "Ben", "Chloe"], [[1000, 700, 700], [700, 1000, 700], [700, 700, 1000]]);
  expect(even.verdict.includes("Nobody would rather swap"), `verdict: ${even.verdict}`);
  expect(even.compare === "With these numbers the fair split is the even one, $800 each: it already leaves nobody wanting to swap.", `compare: ${even.compare}`);
  // The ordinary case still says both halves.
  const usual = await show(2400, ["Ana", "Ben", "Chloe"], [[1200, 750, 450], [950, 850, 600], [900, 800, 700]]);
  expect(usual.compare.startsWith("Compare an even split of $800 each:") && usual.compare.endsWith("The split above leaves nobody wanting to swap."), `compare: ${usual.compare}`);
  expect(tab.problems.length === 0, tab.problems.join(" | "));
  await context.close();
});

await check("no errors in the console on the main page", async () => {
  expect(page.problems.length === 0, page.problems.join(" | "));
});

await browser.close();
server.close();
console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join("; ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
