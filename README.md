# No Envy

Fair rent splitting for housemates, as an open agentic website.

Each housemate says what each room is worth to them. The site works out who gets which
room and what each pays so that **nobody would rather have another room at its rent**, and
shows a table anyone can check by hand. The arithmetic is plain JavaScript that runs in the
browser. The optional AI assistant fills in the sheet with you and explains the result. It is
told never to do the arithmetic: every rent it can quote comes back from the page's own functions.

> No Envy was designed and built by an AI agent (Anthropic's Claude), operated by a human
> entrant. It is an entry for the Open Agentic Web Challenge.

Its public address is https://noenvy-lab.github.io/ (the website's own repository is
`noenvy-lab/noenvy-lab.github.io`; this one is the source it is copied from).

Status: it passes the checks below. **No real language model has been run through it yet**:
the agent tests use the official runtime with a scripted model. That is an open item, not a claim.

## What is here

| Path | What it is |
| --- | --- |
| `site/index.html`, `site/styles.css`, `site/js/` | The page: sheet, solver (`solver.js`), rules (`model.js`), share links. Works with no assistant and no key. |
| `site/site-actions.js` | The six things the assistant can do on the page. Each calls the same code as the page's own buttons. Each change shows an Undo under the chat and at the top of the page (step by step, until the visitor edits the sheet by hand). |
| `site/no_envy.hocon` | The agent network's source: `rent_guide` (front agent) and `fairness_explainer` (explains; it lists no tools of its own, and its instructions forbid the site actions that the runtime offers to every agent). |
| `site/agent-manifest.json`, `site/no_envy.network.json`, `site/bridge/`, `site/.well-known/` | The published agent files. All but the manifest and `bridge/bridge-actions.js` are written by the build. |
| `site/runtime/` | The browser runtime from the Open Agentic Web `agentify-website` skill, unmodified (upstream commit c178171, 2026-11-22; all 35 files compared). |
| `vendor/agentify-website/` | That skill's build script, local server, partner checker and templates (Apache 2.0). |
| `tests/`, `site/tests/`, `tools/e2e.mjs` | Unit tests, agent tests with a scripted model, and headless-browser tests. |
| `tools/site-actions.mjs` | Lists or runs any agentic site's actions from the command line, with no model (see "For other builders"). |
| `tools/` (the rest) | Checks and helpers used while building: random-sheet surveys (`fuzz-large.mjs`, `envy-survey.mjs`), screenshots for review, and `video/`, which records the page parts of the demo video from the real page. Some expect the builder's own folder layout. |

## Run and check

Node 22 or later. From this folder:

```shell
npm run build      # no_envy.hocon -> no_envy.network.json, bridge files; must print no WARNING
npm test           # 54 tests, no key and no network needed
node vendor/agentify-website/scripts/serve_site.mjs site --port 8080   # then open the URL it prints
node tools/e2e.mjs # 24 browser checks. Optional: it needs playwright-core (`npm i --no-save playwright-core`)
                   # and a Chromium (`NOENVY_CHROME=/path/to/chrome`); neither is a dependency of the site
node tools/fuzz-large.mjs 2000 7   # optional: random sheets with totals near ten million, checked exactly
node tools/envy-survey.mjs         # optional: how far whole-number rents get from a perfect match, over random sheets
```

## The method

Rooms go to the assignment with the highest total of everyone's own amounts. Among all
rents that leave nobody wanting to swap, the site picks the ones that make the smallest
gain as large as possible, then the next smallest (maximin envy-free rent division, after
Gal, Mash, Procaccia and Zick, 2016). Rents are whole numbers, so someone (now and then more
than one person) can end up a unit short of a perfect match (one unit at most in every sheet
tested so far); the result says so, and by how much, when it happens. Someone who misstates
their amounts on purpose can sometimes come out ahead, as with any such method. It is a
calculation, not legal or financial advice.

## For other builders: two pieces to take

**1. The solver, as one file.** `site/js/solver.js` has no imports and touches no page: copy the file, or
import it from the published site (`https://noenvy-lab.github.io/js/solver.js`). It does the whole
calculation and its own checking.

```js
import { solve, verify } from "./site/js/solver.js";

const input = {
  total: 2400,                 // whole units of money
  bids: [[1200, 750, 450],     // bids[person][room]; every row adds up to total; up to 8 people
         [950, 850, 600],
         [900, 800, 700]],
  nonNegativePrices: false,    // true: no room's rent may go below zero
};
const r = solve(input);
// r.ok             true
// r.roomOf         [0, 1, 2]           the room of each person
// r.prices         [1083, 733, 584]    the rent of each room; they add up to total
// r.check.maxEnvy  0                   0: nobody would rather swap. 1: rounding left someone one unit short
// A refusal is { ok: false, reason, field } and says why in words a person can read.

verify(input, [0, 1, 2], [800, 800, 800]).envy;   // [0, 100, 200]: an even split, checked the same way
```

`verify` shares no code with the price calculation, and checks any split, also one that did not come from
`solve`. (The outputs above were produced by running exactly this.)

**2. Try a site's actions without a model.** An agentic site's actions are ordinary page functions, and most
of what goes wrong with them has nothing to do with a model. `tools/site-actions.mjs` lists the actions of any
site built on the Open Agentic Web browser runtime, with their arguments, and runs one through the site's own
copy of the runtime, as the runtime would for an agent. No key, no tokens.

```shell
node tools/site-actions.mjs site list                 # a folder with an index.html, or an http(s) address
node tools/site-actions.mjs site run try_split '{"total":2400,"bids":[[1200,750,450],[950,850,600],[900,800,700]]}'
```

It needs playwright-core and a Chromium, like the browser checks. It refuses to run an action that is not
local to the page unless it is given `--allow-remote`, because it answers "yes" to every consent question.
The first time it was used here it caught a wrong argument name in the example above ("amounts" for "bids"):
the runtime refused the call before the page saw it, with `Missing arguments.bids.`
So far it has listed the actions of two sites: this one, and Plainly's public site (its four actions with
their arguments; listing only, nothing was run there).

## Called by other sites

Other agentic sites can call the network `no_envy` (the folder that holds
`agent-manifest.json`, then `no_envy`). The bridge shares one read, `try_split`: a pure
calculation on the numbers in the call. It cannot see a sheet a visitor typed on this page
and it stores nothing, which is why it is shared with every origin.

## Linked site: Plainly

No Envy does not read leases. For what a clause in a rental agreement means in plain words,
the assistant can ask one partner, and only when the visitor asks:

- **Network URL:** `https://sainath998.github.io/plainly-agent/plainly_document_helper`
  (Plainly, an independent site by another challenge team, written for readers in India).
  It is the only origin in `allowed_peers`; the peer policy stays `closed`.
- **The consent card.** Before anything is contacted, the chat shows a card with the
  partner's name, its host and the first 140 characters of the request. **Decline** contacts
  nothing. **Always allow** skips the card for every partner on that host until the page is
  reloaded.
- **What a request contains.** The shortened clause or question. The assistant is told
  never to put names, emails, phone numbers or booking codes in it, and the rent sheet is
  not passed along. The runtime does not filter the request, so the visitor checks it on the
  card.
- **Where it runs.** After Allow, the visitor's browser fetches Plainly's public agent
  files and runs Plainly's network in this browser, on the visitor's own key and model
  provider. A call costs more tokens than the card's estimate.
- **What Plainly can answer from here.** `check_partner.mjs` reports that its bridge shares
  no actions, so it answers only from its instructions, in general terms. Its answer is
  Plainly's, not No Envy's, and not legal advice.
- **The split never depends on it.** If Plainly is down or declines, the assistant says so
  and everything else works.

Checked on 2026-11-23 with
`node vendor/agentify-website/scripts/check_partner.mjs <network URL> --origin https://example.invalid`
(result: can be called). The tests check that the card comes first and that a decline
fetches nothing. **What a real model does with Plainly's answer has not been tested**: that
needs a key.

## Privacy

No account, no tracking, no server of ours. Numbers stay in the browser and in the links
the visitor chooses to share. With the optional assistant on, what the visitor types to it
and the sheet it reads go to the AI provider the visitor picks.

## Licence

Apache 2.0. The runtime and skill under `site/runtime/` and `vendor/` are from
`cognizant-ai-labs/agentic-web`, also Apache 2.0.
