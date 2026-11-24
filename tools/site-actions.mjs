// List an open agentic website's actions, or run one, from the command line: no language model, no key.
//
// Why: an agentic site's actions are ordinary page functions, and most of what can go wrong with them
// (a wrong argument name, a refusal that is not explained, an action that changes more than it says) has
// nothing to do with a model. This runs them through the site's own copy of the browser runtime, exactly as
// the runtime would for an agent, so they can be tried and tested without spending a token.
//
// Usage:
//   node tools/site-actions.mjs <site> list
//   node tools/site-actions.mjs <site> run <action> ['<json arguments>'] [--allow-remote]
// <site> is a folder with an index.html (served locally for the run) or an http(s) address.
// "run" refuses an action that is not local to the page unless --allow-remote is given: such an action can
// contact another site, and this tool answers "yes" to every consent question on your behalf.
//
// It works with sites built on the Open Agentic Web browser runtime, which leaves its engine at
// window.__nsweb. It needs playwright-core and a Chromium (set NOENVY_CHROME to its path, or let
// playwright find one). Written for No Envy; nothing in it is specific to No Envy. Apache 2.0.
import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./serve.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(2);
const allowRemote = args.includes("--allow-remote");
const [site, verb, action, json] = args.filter((a) => a !== "--allow-remote");
if (!site || !["list", "run"].includes(verb) || (verb === "run" && !action)) {
  console.error("usage: node tools/site-actions.mjs <folder or URL> list\n       node tools/site-actions.mjs <folder or URL> run <action> ['<json arguments>'] [--allow-remote]");
  process.exit(2);
}
let input = {};
if (json !== undefined) {
  try {
    input = JSON.parse(json);
  } catch (err) {
    console.error(`the arguments are not JSON: ${err.message}`);
    process.exit(2);
  }
}

// playwright-core: this project's own copy if it has one, else the lab's shared copy.
let chromium = null;
for (const base of [join(here, "..", "package.json"), join(here, "..", "..", "game", "package.json")]) {
  try {
    ({ chromium } = createRequire(base)("playwright-core"));
    break;
  } catch {
    // look in the next place
  }
}
if (!chromium) {
  console.error("playwright-core is not installed (npm i --no-save playwright-core)");
  process.exit(2);
}
const labChrome = join(here, "..", "..", "work", "chromium", "chrome-win", "headless_shell.exe");
const executablePath = process.env.NOENVY_CHROME ?? (existsSync(labChrome) ? labChrome : undefined);

let local = null;
let address = site;
if (!/^https?:\/\//i.test(site)) {
  const folder = resolve(site);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    console.error(`not a folder and not an address: ${site}`);
    process.exit(2);
  }
  local = await startServer(folder);
  address = local.url;
}

const browser = await chromium.launch(executablePath ? { executablePath } : {});
let code = 0;
try {
  const page = await browser.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  await page.goto(address);
  await page.waitForFunction(() => Boolean(window.__nsweb?.engine?.top?.network), null, { timeout: 30000 }).catch(() => {
    throw new Error("the page did not start an Open Agentic Web runtime within 30 seconds (no window.__nsweb engine)");
  });
  const catalog = await page.evaluate(() => {
    const { engine } = window.__nsweb;
    const scope = { base: engine.top.base, network: engine.top.network.name };
    return engine.actions.catalog(scope).map((e) => ({ name: e.name, effect: e.effect, availability: e.availability, description: e.description ?? "", inputSchema: e.inputSchema ?? null }));
  });
  if (verb === "list") {
    console.log(`${catalog.length} action${catalog.length === 1 ? "" : "s"} on ${address}`);
    for (const e of catalog) {
      console.log(`\n${e.name}   [${e.effect}, ${e.availability}]\n  ${String(e.description).replace(/\s+/g, " ").trim()}`);
      const properties = Object.entries(e.inputSchema?.properties ?? {});
      const required = new Set(e.inputSchema?.required ?? []);
      if (!properties.length) console.log("  arguments: none");
      for (const [name, spec] of properties) {
        const kind = spec.type === "array" ? `array of ${spec.items?.type ?? "values"}` : spec.type ?? "any";
        console.log(`  - ${name} (${kind}${required.has(name) ? ", required" : ""}): ${String(spec.description ?? "").replace(/\s+/g, " ").trim()}`);
      }
    }
  } else {
    const entry = catalog.find((e) => e.name === action);
    if (!entry) throw new Error(`no action "${action}" on this site; it has: ${catalog.map((e) => e.name).join(", ")}`);
    if (entry.availability !== "local-only" && !allowRemote) {
      throw new Error(`"${action}" is ${entry.availability}: it may contact another site. Add --allow-remote if that is what you want.`);
    }
    const outcome = await page.evaluate(async ({ name, input }) => {
      const { engine } = window.__nsweb;
      const scope = { base: engine.top.base, network: engine.top.network.name };
      const found = engine.actions.catalog(scope).find((e) => e.name === name);
      let plan;
      try {
        plan = engine.actions.prepare({ kind: "action", action: found.ref, arguments: input });
      } catch (err) {
        // The runtime checks the arguments against the action's schema before the page sees them.
        return { status: "refused by the runtime", reason: String(err?.message ?? err) };
      }
      const [first] = await engine.actions.execute(plan, () => true, "site-actions");
      return first;
    }, { name: action, input });
    console.log(JSON.stringify(outcome, null, 2));
    if (outcome?.status !== "succeeded") code = 1;
  }
  if (problems.length) console.error(`\npage errors:\n  ${problems.join("\n  ")}`);
} catch (err) {
  console.error(err.message);
  code = 1;
} finally {
  await browser.close();
  local?.server.close();
}
process.exit(code);
