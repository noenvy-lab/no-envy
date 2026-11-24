// Large-total fuzz: does the split still pass its own check when one unit is a
// ten-millionth of the total? Asked by the independent review of 2026-11-24.
// Usage: node tools/fuzz-large.mjs [cases per size, default 60] [seed, default 1]
// Prints a table and exits with 1 if any case threw, failed the check, or was refused (or answered)
// under "no rent below zero" against the exact whole-number answer below.
import { solve, bestAssignment } from "../site/js/solver.js";

// An exact answer, in whole numbers only, to: is there any envy-free list of rents with no rent below
// zero? It shares no code with the solver. Write x[room] for a room's rent minus the lowest rent. Nobody
// envies when x[a] - x[b] <= (what a's occupant says a is worth) - (what they say b is worth) for every
// pair of rooms. Those conditions have one smallest solution with every x >= 0, found by repeating
// "raise x[b] as far as some condition demands". Rents with no rent below zero exist exactly when that
// smallest solution adds up to no more than the total.
function nonNegativeSplitExists(bids, roomOf, total) {
  const n = bids.length;
  const x = new Array(n).fill(0);
  for (let round = 0; round <= n; round++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const a = roomOf[i];
      for (let b = 0; b < n; b++) {
        if (b === a) continue;
        const needed = x[a] - (bids[i][a] - bids[i][b]);
        if (needed > x[b]) { x[b] = needed; moved = true; }
      }
    }
    if (!moved) return x.reduce((sum, v) => sum + v, 0) <= total;
  }
  return false; // the conditions contradict each other: no envy-free rents at all for this assignment
}

const perSize = Number(process.argv[2] ?? 60);
let seed = Number(process.argv[3] ?? 1) >>> 0;
function random() {
  // mulberry32: the same seed gives the same cases on every machine.
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// A row of n whole numbers that add up to total. Three shapes: spread out,
// nearly equal (many ties), and one room worth almost everything.
function row(n, total, shape) {
  let weights;
  if (shape === 0) weights = Array.from({ length: n }, () => random() + 0.05);
  else if (shape === 1) weights = Array.from({ length: n }, () => 1 + (random() < 0.5 ? 0 : random() * 1e-6));
  else weights = Array.from({ length: n }, (_, j) => (j === Math.floor(random() * n) ? 50 : random() * 0.01));
  const sum = weights.reduce((a, v) => a + v, 0);
  const out = weights.map((w) => Math.floor((w / sum) * total));
  out[0] += total - out.reduce((a, v) => a + v, 0);
  return out;
}

const totals = [10000000, 9999999, 9999991, 7654321];
let bad = 0;
console.log("people option cases solved refused threw worstEnvy slowest(ms)");
for (let n = 4; n <= 8; n++) {
  for (const nonNegativePrices of [false, true]) {
    const tally = { solved: 0, refused: 0, threw: 0, worst: 0, slowest: 0 };
    for (let k = 0; k < perSize; k++) {
      const total = totals[k % totals.length];
      const bids = Array.from({ length: n }, () => row(n, total, k % 3));
      const started = Date.now();
      try {
        const out = solve({ total, bids, nonNegativePrices });
        if (nonNegativePrices && out.ok !== nonNegativeSplitExists(bids, bestAssignment(bids), total)) {
          bad++;
          console.log(`  wrong about the no-rent-below-zero rule: n=${n} total=${total} solver says ${out.ok ? "a split exists" : "none exists"}`);
        }
        if (!out.ok) {
          // Only "no split under the no-rent-below-zero rule" is an honest refusal.
          if (nonNegativePrices) tally.refused++;
          else { tally.threw++; bad++; console.log(`  refused without the option: ${out.reason}`); }
        } else {
          tally.solved++;
          const c = out.check;
          if (c.maxEnvy > tally.worst) tally.worst = c.maxEnvy;
          const sound = c.sumMatchesTotal && c.everyRoomTaken && c.maxEnvy <= n && !(nonNegativePrices && c.lowestPrice < 0);
          if (!sound) { bad++; console.log(`  failed its check: n=${n} total=${total} envy=${c.maxEnvy} sum=${c.sumMatchesTotal} low=${c.lowestPrice}`); }
        }
      } catch (error) {
        tally.threw++;
        bad++;
        console.log(`  threw: n=${n} total=${total} ${String(error.message).slice(0, 100)}`);
      }
      tally.slowest = Math.max(tally.slowest, Date.now() - started);
    }
    console.log(`${n}      ${nonNegativePrices ? "no<0 " : "any  "} ${perSize}    ${tally.solved}     ${tally.refused}      ${tally.threw}    ${tally.worst}        ${tally.slowest}`);
  }
}
console.log(bad === 0 ? "all cases passed the check" : `${bad} case(s) threw or failed the check`);
process.exit(bad === 0 ? 0 : 1);
