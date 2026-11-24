// Checks on the site's own source text, for claims a browser run can only sample.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const site = join(dirname(fileURLToPath(import.meta.url)), "..", "site");

// Names, room names and the currency sign can arrive in a link that somebody else wrote. The page puts them on
// screen as text and never as markup. The browser check opens such a link in one state of the page; this one
// holds for every state, because it is about how the scripts are written. The official runtime in
// site/runtime/ is not ours and is not read here.
test("the site's own scripts never build markup or code from text", () => {
  const files = [
    ...readdirSync(join(site, "js")).filter((name) => name.endsWith(".js")).map((name) => join(site, "js", name)),
    join(site, "site.js"),
    join(site, "site-actions.js"),
  ];
  assert.ok(files.length >= 6, `expected the page's scripts, found ${files.length}`);
  const banned = ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "DOMParser", "createContextualFragment", "eval(", "new Function"];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const word of banned) assert.equal(source.includes(word), false, `${file} uses ${word}`);
  }
});
