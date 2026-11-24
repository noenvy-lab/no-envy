import test from "node:test";
import assert from "node:assert/strict";
import { solve, verify, validate, bestAssignment, simplex } from "../site/js/solver.js";

// Deterministic random numbers, so a failure can be reproduced.
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

// n rows of non-negative integers, each adding up to total.
function randomBids(rand, n, total) {
  const bids = [];
  for (let i = 0; i < n; i++) {
    const cuts = [];
    for (let j = 0; j < n - 1; j++) cuts.push(Math.floor(rand() * (total + 1)));
    cuts.sort((a, b) => a - b);
    const row = [];
    let previous = 0;
    for (const cut of cuts) { row.push(cut - previous); previous = cut; }
    row.push(total - previous);
    bids.push(row);
  }
  return bids;
}

function permutations(n) {
  const out = [];
  const walk = (prefix, left) => {
    if (left.length === 0) { out.push(prefix); return; }
    left.forEach((v, k) => walk([...prefix, v], [...left.slice(0, k), ...left.slice(k + 1)]));
  };
  walk([], [...Array(n).keys()]);
  return out;
}

test("simplex solves a textbook problem", () => {
  // max 3x + 5y, x <= 4, 2y <= 12, 3x + 2y <= 18  ->  x=2, y=6, value 36
  const r = simplex([3, 5], [[1, 0], [0, 2], [3, 2]], [4, 12, 18]);
  assert.equal(r.status, "optimal");
  assert.ok(Math.abs(r.value - 36) < 1e-9);
  assert.ok(Math.abs(r.x[0] - 2) < 1e-9 && Math.abs(r.x[1] - 6) < 1e-9);
});

test("simplex handles equalities, negative right-hand sides, infeasible and unbounded", () => {
  // max x  s.t. x + y = 10, -y <= -3 (y >= 3)  ->  x = 7
  const a = simplex([1, 0], [[0, -1]], [-3], [[1, 1]], [10]);
  assert.equal(a.status, "optimal");
  assert.ok(Math.abs(a.x[0] - 7) < 1e-9);
  // x <= 1 and x >= 2
  assert.equal(simplex([1], [[1], [-1]], [1, -2]).status, "infeasible");
  // max x with only x >= 2
  assert.equal(simplex([1], [[-1]], [-2]).status, "unbounded");
});

test("validate refuses bad input with a reason and a field", () => {
  const good = { total: 1000, bids: [[600, 400], [500, 500]] };
  assert.deepEqual(validate(good), { ok: true });
  assert.equal(validate({ total: 0, bids: good.bids }).field, "total");
  assert.equal(validate({ total: 1000, bids: [[1000]] }).field, "bids");
  assert.equal(validate({ total: 1000, bids: [[600, 400], [500, 499]] }).field, "bids.1");
  assert.equal(validate({ total: 1000, bids: [[600, 400], [500.5, 499.5]] }).field, "bids.1.0");
  assert.equal(validate({ total: 1000, bids: [[1100, -100], [500, 500]] }).field, "bids.0.1");
  assert.equal(validate({ total: 1000, unit: 300, bids: good.bids }).field, "unit");
  assert.equal(validate({ total: 900, bids: Array.from({ length: 9 }, () => Array(9).fill(100)) }).field, "bids");
  assert.equal(solve({ total: 1000, bids: [[600, 400], [500, 499]] }).ok, false);
});

test("two people: worked out by hand", () => {
  // Rent 1000. A values the rooms 600/400, B values them 500/500.
  // Best assignment: A gets room 1 (600 + 500 = 1100, against 400 + 500 = 900).
  // The surplus of 100 is shared equally: each gains 50.
  // A pays 600 - 50 = 550, B pays 500 - 50 = 450.
  const r = solve({ total: 1000, bids: [[600, 400], [500, 500]] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.roomOf, [0, 1]);
  assert.deepEqual(r.prices, [550, 450]);
  assert.deepEqual(r.pays, [550, 450]);
  assert.deepEqual(r.check.gains, [50, 50]);
  assert.equal(r.check.maxEnvy, 0);
  assert.equal(r.check.sumMatchesTotal, true);
});

test("identical opinions: everyone pays exactly what they think their room is worth", () => {
  const row = [500, 300, 200];
  const r = solve({ total: 1000, bids: [row, row, row] });
  assert.deepEqual(r.prices, [500, 300, 200]);
  assert.deepEqual(r.check.gains, [0, 0, 0]);
  assert.equal(r.check.maxEnvy, 0);
});

test("three people: worked out by hand", () => {
  // Rent 3000. Each person values "their" room at 1500 and the others at 750.
  // By symmetry everyone gets their favourite and pays 1000, gaining 500.
  const r = solve({ total: 3000, bids: [[1500, 750, 750], [750, 1500, 750], [750, 750, 1500]] });
  assert.deepEqual(r.roomOf, [0, 1, 2]);
  assert.deepEqual(r.prices, [1000, 1000, 1000]);
  assert.deepEqual(r.check.gains, [500, 500, 500]);
});

test("the order in which people or rooms are listed does not change who pays what", () => {
  const bids = [[700, 200, 100], [400, 400, 200], [300, 300, 400]];
  const a = solve({ total: 1000, bids });
  // List the people in reverse.
  const b = solve({ total: 1000, bids: [...bids].reverse() });
  // List the rooms in reverse.
  const c = solve({ total: 1000, bids: bids.map((row) => [...row].reverse()) });
  assert.deepEqual(c.roomOf, a.roomOf.map((room) => 2 - room));
  // Before rounding the answer is identical. A cent cannot be split, so after
  // rounding, who carries the odd cent may depend on the order: at most 1 apart.
  const exactPays = (r) => r.roomOf.map((room) => r.exactPrices[room]);
  exactPays(a).forEach((v, i) => {
    assert.ok(Math.abs(exactPays(b)[2 - i] - v) < 1e-6);
    assert.ok(Math.abs(exactPays(c)[i] - v) < 1e-6);
    assert.ok(Math.abs(b.pays[2 - i] - a.pays[i]) <= 1);
    assert.ok(Math.abs(c.pays[i] - a.pays[i]) <= 1);
  });
  for (const r of [a, b, c]) assert.equal(r.check.maxEnvy, 0);
});

test("a room nobody wants can get a negative rent, and the option refuses it honestly", () => {
  // Everyone thinks room 3 is worth nothing; two people love room 1.
  const bids = [[1000, 0, 0], [1000, 0, 0], [500, 500, 0]];
  const free = solve({ total: 1000, bids });
  assert.equal(free.ok, true);
  assert.equal(free.check.maxEnvy, 0);
  assert.equal(free.check.sumMatchesTotal, true);
  assert.ok(free.check.lowestPrice < 0, `expected a negative rent, got ${free.prices}`);
  const strict = solve({ total: 1000, bids, nonNegativePrices: true });
  if (strict.ok) {
    assert.ok(strict.check.lowestPrice >= 0);
    assert.equal(strict.check.maxEnvy, 0);
  } else {
    assert.match(strict.reason, /negative/);
  }
});

test("non-negative option keeps prices at zero or more whenever it answers", () => {
  const rand = rng(77);
  let answered = 0;
  for (let round = 0; round < 150; round++) {
    const n = 2 + Math.floor(rand() * 4);
    const r = solve({ total: 100000, bids: randomBids(rand, n, 100000), nonNegativePrices: true });
    if (!r.ok) continue;
    answered++;
    assert.ok(r.check.lowestPrice >= 0);
    assert.ok(r.check.maxEnvy <= 2);
  }
  assert.ok(answered > 50);
});

test("random cases: assignment is the best one, prices add up, nobody envies", () => {
  const rand = rng(20261123);
  for (let round = 0; round < 400; round++) {
    const n = 2 + Math.floor(rand() * 7); // 2..8
    const total = 240000;
    const bids = randomBids(rand, n, total);
    const r = solve({ total, bids });
    assert.equal(r.ok, true, `round ${round}`);
    assert.equal(r.check.sumMatchesTotal, true);
    assert.equal(r.check.everyRoomTaken, true);
    // Exact prices: no envy at all. Rounded to cents: at most 2 cents.
    const exact = verifyFloat(bids, r.roomOf, r.exactPrices);
    assert.ok(exact < 1e-4, `round ${round}: exact envy ${exact}`);
    assert.ok(r.check.maxEnvy <= 2, `round ${round}: rounded envy ${r.check.maxEnvy}`);
    assert.ok(Math.min(...r.check.gains) >= -1, `round ${round}: someone loses`);
    if (n <= 6) {
      const value = (roomOf) => roomOf.reduce((a, room, i) => a + bids[i][room], 0);
      const top = Math.max(...permutations(n).map(value));
      assert.equal(value(r.roomOf), top, `round ${round}: assignment is not the best`);
    }
  }
});

function verifyFloat(bids, roomOf, prices) {
  let worst = 0;
  bids.forEach((row, i) => {
    const mine = row[roomOf[i]] - prices[roomOf[i]];
    row.forEach((v, j) => { worst = Math.max(worst, v - prices[j] - mine); });
  });
  return worst;
}

test("rounding to whole currency units keeps the total exact", () => {
  const rand = rng(5);
  for (let round = 0; round < 100; round++) {
    const n = 2 + Math.floor(rand() * 5);
    const total = 185000;
    const r = solve({ total, bids: randomBids(rand, n, total), unit: 100 });
    assert.equal(r.ok, true);
    assert.equal(r.check.sumMatchesTotal, true);
    for (const p of r.prices) assert.equal(Math.abs(p % 100), 0);
    assert.ok(r.check.maxEnvy <= 200);
  }
});

test("against brute force (3 people): no envy-free split has a better worst-off person", () => {
  const rand = rng(31337);
  const total = 60;
  for (let round = 0; round < 40; round++) {
    const bids = randomBids(rand, 3, total);
    const r = solve({ total, bids });
    assert.equal(r.ok, true);
    // Every assignment, every whole-number price vector in a generous range.
    let bestSorted = null;
    for (const roomOf of permutations(3)) {
      for (let p0 = -60; p0 <= 120; p0++) {
        for (let p1 = -60; p1 <= 120; p1++) {
          const prices = [p0, p1, total - p0 - p1];
          let envyFree = true;
          const gains = [];
          for (let i = 0; i < 3 && envyFree; i++) {
            const mine = bids[i][roomOf[i]] - prices[roomOf[i]];
            for (let j = 0; j < 3; j++) if (bids[i][j] - prices[j] > mine) { envyFree = false; break; }
            gains.push(mine);
          }
          if (!envyFree) continue;
          const sorted = gains.sort((a, b) => a - b);
          if (!bestSorted || lexGreater(sorted, bestSorted)) bestSorted = sorted;
        }
      }
    }
    assert.ok(bestSorted, "brute force found no envy-free split");
    const mine = r.roomOf.map((room, i) => bids[i][room] - r.exactPrices[room]).sort((a, b) => a - b);
    // The exact optimum may fall between whole numbers, so it can beat the grid by under 1.
    assert.ok(mine[0] >= bestSorted[0] - 1e-6, `round ${round}: worst-off ${mine[0]} < grid ${bestSorted[0]}`);
    assert.ok(mine[0] < bestSorted[0] + 1, `round ${round}: worst-off ${mine[0]} is impossibly above grid ${bestSorted[0]}`);
  }
});

function lexGreater(a, b) {
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] > b[k];
  return false;
}

test("verify reports envy that is really there", () => {
  // A badly priced split: person 1 pays 900 for a room they value at 600.
  const check = verify({ total: 1000, bids: [[600, 400], [500, 500]] }, [0, 1], [900, 100]);
  assert.equal(check.sumMatchesTotal, true);
  assert.deepEqual(check.table, [[-300, 300], [-400, 400]]);
  assert.deepEqual(check.envy, [600, 0]);
  assert.deepEqual(check.wouldSwapTo, [1, null]);
  assert.equal(check.maxEnvy, 600);
  assert.equal(verify({ total: 1000, bids: [[600, 400], [500, 500]] }, [0, 1], [500, 400]).sumMatchesTotal, false);
  assert.equal(verify({ total: 1000, bids: [[600, 400], [500, 500]] }, [0, 0], [500, 500]).everyRoomTaken, false);
});

test("same input, same output", () => {
  const bids = [[250, 250, 250, 250], [250, 250, 250, 250], [400, 200, 200, 200], [100, 300, 300, 300]];
  const a = solve({ total: 1000, bids });
  const b = solve({ total: 1000, bids: bids.map((row) => [...row]) });
  assert.deepEqual(a, b);
  assert.equal(a.check.maxEnvy, 0);
});

// ---------------------------------------------------------------------------------------------------
// Totals near the largest allowed (ten million), where one unit is a ten-millionth of the total: nearly
// equal amounts must still get a split.

// Exact, whole numbers only, no code shared with the solver: is there an envy-free list of rents with
// no rent below zero? x[room] is a room's rent minus the lowest rent; the conditions "nobody envies"
// have one smallest solution with every x >= 0, and such rents exist exactly when it adds up to no more
// than the total. (The same function is in tools/fuzz-large.mjs.)
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
  return false;
}

test("nearly equal amounts on a ten-million total are solved, not refused", () => {
  const sheets = [
    [[2500002, 2500000, 2499999, 2499999], [2500002, 2499999, 2500000, 2499999], [2500001, 2499999, 2499999, 2500001], [2500001, 2499999, 2499999, 2500001]],
    [[2500000, 2500001, 2500001, 2499998], [2500002, 2499999, 2499999, 2500000], [2500000, 2499999, 2500001, 2500000], [2500001, 2500000, 2500000, 2499999]],
    [[2000000, 1999999, 2000000, 2000000, 2000001], [2000003, 1999999, 2000000, 1999999, 1999999], [2000002, 2000000, 1999999, 1999999, 2000000], [2000000, 2000001, 1999999, 2000000, 2000000], [2000001, 1999999, 2000000, 2000000, 2000000]],
  ];
  for (const bids of sheets) {
    const r = solve({ total: 10000000, bids });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.check.sumMatchesTotal, true);
    assert.ok(r.check.maxEnvy <= 1, `envy ${r.check.maxEnvy}`);
  }
});

test("large totals: always an answer, and the no-rent-below-zero rule is right both ways", () => {
  const rand = rng(20261124);
  const totals = [10000000, 9999999, 9999991, 7654321];
  // Three shapes of row: spread out, nearly equal (many ties), one room worth almost everything.
  const row = (n, total, shape) => {
    let weights;
    if (shape === 0) weights = Array.from({ length: n }, () => rand() + 0.05);
    else if (shape === 1) weights = Array.from({ length: n }, () => 1 + (rand() < 0.5 ? 0 : rand() * 1e-6));
    else weights = Array.from({ length: n }, (_, j) => (j === Math.floor(rand() * n) ? 50 : rand() * 0.01));
    const sum = weights.reduce((a, v) => a + v, 0);
    const out = weights.map((w) => Math.floor((w / sum) * total));
    out[0] += total - out.reduce((a, v) => a + v, 0);
    return out;
  };
  let refused = 0;
  for (let n = 3; n <= 8; n++) {
    for (let k = 0; k < (n === 8 ? 24 : 60); k++) {
      const total = totals[k % totals.length];
      const bids = Array.from({ length: n }, () => row(n, total, k % 3));
      const open = solve({ total, bids });
      assert.equal(open.ok, true, `refused without the rule: n=${n} total=${total} ${JSON.stringify(bids)}`);
      assert.equal(open.check.sumMatchesTotal, true);
      assert.ok(open.check.maxEnvy <= 1, `envy ${open.check.maxEnvy}`);
      const strict = solve({ total, bids, nonNegativePrices: true });
      assert.equal(strict.ok, nonNegativeSplitExists(bids, bestAssignment(bids), total), `no-rent-below-zero: n=${n} total=${total} ${JSON.stringify(bids)}`);
      if (strict.ok) {
        assert.ok(strict.check.lowestPrice >= 0);
        assert.ok(strict.check.maxEnvy <= 1, `envy ${strict.check.maxEnvy}`);
      } else {
        refused++;
      }
    }
  }
  assert.ok(refused > 5, "the refusal path was exercised");
});

test("small totals: the no-rent-below-zero rule agrees with the exact whole-number answer", () => {
  const rand = rng(4242);
  let refused = 0;
  for (let round = 0; round < 400; round++) {
    const n = 2 + Math.floor(rand() * 5);
    const total = [7, 30, 100, 2400][round % 4];
    const bids = randomBids(rand, n, total);
    const strict = solve({ total, bids, nonNegativePrices: true });
    assert.equal(strict.ok, nonNegativeSplitExists(bids, bestAssignment(bids), total), `n=${n} total=${total} ${JSON.stringify(bids)}`);
    if (!strict.ok) refused++;
  }
  assert.ok(refused >= 5, `the refusal path was exercised only ${refused} times`);
});
