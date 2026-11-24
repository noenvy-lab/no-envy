// How far from a perfect match do whole-number rents get? Counts check.maxEnvy and the lowest gain over
// many random sheets, to see whether the page's "a unit short" and "give or take 1" hold.
// Usage: node tools/envy-survey.mjs [seed] [sheets]. On 2026-11-24, seed 4242 and 12000 sheets (each solved
// with and without "no rent below zero"): 23808 perfect, 18 one unit short, none further; no gain below zero.
import { solve } from "../site/js/solver.js";

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(Number(process.argv[2] ?? 4242));
function row(n, total, shape) {
  let weights;
  if (shape === 0) weights = Array.from({ length: n }, () => rand());
  else if (shape === 1) weights = Array.from({ length: n }, () => 1 + rand() * 0.2);
  else if (shape === 2) weights = Array.from({ length: n }, (_, j) => (j === Math.floor(rand() * n) ? 5 : rand()));
  else weights = Array.from({ length: n }, () => Math.round(rand() * 6)).map((w) => w + 0.001);
  const sum = weights.reduce((a, v) => a + v, 0);
  const out = weights.map((w) => Math.floor((w / sum) * total));
  out[0] += total - out.reduce((a, v) => a + v, 0);
  return out;
}
const totals = [900, 1000, 2400, 2401, 3333, 17500, 100000, 240000];
const envy = new Map();
const lowGain = new Map();
let cases = 0, refused = 0, worst = null;
const rounds = Number(process.argv[3] ?? 20000);
for (let k = 0; k < rounds; k++) {
  const n = 2 + Math.floor(rand() * 7);
  const total = totals[k % totals.length];
  const bids = Array.from({ length: n }, () => row(n, total, k % 4));
  for (const nonNegativePrices of [false, true]) {
    const r = solve({ total, bids, nonNegativePrices });
    if (!r.ok) { refused++; continue; }
    cases++;
    envy.set(r.check.maxEnvy, (envy.get(r.check.maxEnvy) ?? 0) + 1);
    const low = Math.min(...r.check.gains);
    const bucket = low >= 0 ? ">=0" : String(low);
    lowGain.set(bucket, (lowGain.get(bucket) ?? 0) + 1);
    if (!worst || r.check.maxEnvy > worst.envy) worst = { envy: r.check.maxEnvy, total, bids, nonNegativePrices, prices: r.prices, roomOf: r.roomOf };
  }
}
console.log(`solved ${cases}, refused ${refused}`);
console.log("maxEnvy:", JSON.stringify([...envy].sort((a, b) => a[0] - b[0])));
console.log("lowest gain:", JSON.stringify([...lowGain]));
console.log("worst:", JSON.stringify(worst));
