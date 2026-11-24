// What No Envy shares with other agent sites (bridge/bridge-actions.js).
// This file sets up no document, window or storage on purpose: the bridge frame has no
// page, so the shared action must run without one. node --test runs each file in its own
// process, so nothing from agentified.test.mjs leaks in here.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Sheet } from "../js/model.js";

const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

async function shared() {
  const bridge = await read("../bridge/agent-manifest.json");
  assert.equal(bridge.actions.module, "./bridge-actions.js", "The build must name bridge-actions.js in the bridge's manifest.");
  const loaded = await import(new URL(`../bridge/${bridge.actions.module}`, import.meta.url).href);
  const definitions = [];
  await loaded.registerActions({ register: (d) => definitions.push(d) });
  return definitions;
}

const THREE = {
  total: 2400,
  people: ["Ana", "Ben", "Chi"],
  rooms: ["Big", "Middle", "Small"],
  bids: [
    [1100, 800, 500],
    [900, 900, 600],
    [1000, 700, 700],
  ],
};

test("the bridge loads with no page and shares exactly one read: try_split", async () => {
  assert.equal(typeof globalThis.document, "undefined");
  assert.equal(typeof globalThis.window, "undefined");
  const definitions = await shared();
  assert.deepEqual(definitions.map((d) => d.name), ["try_split"]);
  const [action] = definitions;
  assert.equal(action.effect, "read");
  assert.equal(action.availability, "bridge");
  assert.deepEqual(action.callerOrigins, ["*"]);
  assert.ok(!JSON.stringify([action.description, action.inputSchema]).includes("TODO"));
  // A partner's agents get only names listed in the site's own manifest.
  const manifest = await read("../agent-manifest.json");
  assert.ok(manifest.actions.agentTools.includes("try_split"));
  assert.equal(manifest.actions.bridge, "./bridge/action-bridge.html");
});

test("the shared try_split takes the same input as the page's own action", async () => {
  // site-actions.js imports the page script, which needs a DOM, so compare the schema text instead.
  const source = await readFile(new URL("../site-actions.js", import.meta.url), "utf8");
  const [action] = await shared();
  for (const field of Object.keys(action.inputSchema.properties)) {
    assert.ok(source.includes(`${field}:`), `The page's try_split has no ${field} input.`);
  }
  assert.deepEqual(action.inputSchema.required, ["total", "bids"]);
  assert.equal(action.inputSchema.additionalProperties, false);
});

test("a caller gets the site's own arithmetic: nobody would rather swap, rents add up", async () => {
  const [action] = await shared();
  const out = await action.execute(structuredClone(THREE));
  assert.equal(out.ok, true);
  assert.deepEqual(out, Sheet.preview(structuredClone(THREE)));
  assert.equal(out.rents.reduce((sum, r) => sum + r.rent, 0), THREE.total);
  assert.equal(out.check.maxEnvy, 0);
  // Each person's own room is the best entry in their row of the check table.
  for (const a of out.assignments) {
    const row = out.check.table[a.person];
    assert.equal(Math.max(...row), row[a.room]);
    assert.equal(a.gain, THREE.bids[a.person][a.room] - a.pays);
  }
  assert.deepEqual(out.assignments.map((a) => a.personName), THREE.people);
});

test("names are optional; bad input is refused with a reason and nothing is thrown", async () => {
  const [action] = await shared();
  const bare = await action.execute({ total: 100, bids: [[60, 40], [50, 50]] });
  assert.equal(bare.ok, true);
  assert.deepEqual(bare.assignments.map((a) => a.personName), ["Person 1", "Person 2"]);

  const off = await action.execute({ total: 100, bids: [[60, 30], [50, 50]] });
  assert.equal(off.ok, false);
  assert.equal(typeof off.reason, "string");
  assert.ok(off.reason.length > 10);

  for (const bad of [undefined, {}, { total: 100 }, { total: 100, bids: "x" }, { total: 100, bids: [[100]] }, { total: 100, bids: [[60, 40], [50, 50]], people: ["Only one"] }]) {
    const out = await action.execute(bad);
    assert.equal(out.ok, false, JSON.stringify(bad));
    assert.equal(typeof out.reason, "string");
  }
});

test("the front agent is told how to answer another site's assistant", async () => {
  const network = await read("../no_envy.network.json");
  const front = network.tools.find((t) => t.name === "rent_guide");
  assert.ok(front.instructions.includes("Called by another site's assistant"));
  assert.ok(front.instructions.includes("website_try_split"));
  assert.ok(front.instructions.includes("do not fill it in"));
});
