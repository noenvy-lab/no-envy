import test from "node:test";
import assert from "node:assert/strict";
import { Sheet, evenSplit, scaleRow, money, LIMITS } from "../site/js/model.js";
import { encode, decode, parseFragment, sheetLink, replyLink } from "../site/js/share.js";

const snapshot = (sheet) => JSON.stringify(sheet.toJSON()) + sheet.version;

test("evenSplit and scaleRow always add up", () => {
  assert.deepEqual(evenSplit(100, 3), [34, 33, 33]);
  assert.deepEqual(evenSplit(0, 2), [0, 0]);
  assert.deepEqual(scaleRow([1, 1, 1], 100), [34, 33, 33]);
  assert.deepEqual(scaleRow([0, 0], 101), [51, 50]);
  assert.deepEqual(scaleRow([300, 100], 1000), [750, 250]);
  for (const total of [1, 7, 999, 2400]) {
    assert.equal(scaleRow([5, 0, 13, 2], total).reduce((a, v) => a + v, 0), total);
  }
});

test("money", () => {
  assert.equal(money(1234567, "$"), "$1,234,567");
  assert.equal(money(-50, "NT$"), "−NT$50");
  assert.equal(money(0, ""), "0");
});

test("the example solves, and the amounts are right by hand", () => {
  // Rent 2400. Ana 1200/750/450, Ben 950/850/600, Chloe 900/800/700.
  // Best total value: Ana big (1200) + Ben middle (850) + Chloe small (700) = 2750.
  // Surplus 2750 - 2400 = 350.
  const sheet = Sheet.example();
  const state = sheet.solve();
  assert.equal(state.ok, true);
  const r = state.result;
  assert.deepEqual(r.assignments.map((a) => a.roomName), ["Big room with balcony", "Middle room", "Small room by the door"]);
  assert.equal(r.assignments.reduce((a, x) => a + x.pays, 0), 2400);
  assert.equal(r.assignments.reduce((a, x) => a + x.gain, 0), 350);
  assert.equal(r.check.maxEnvy, 0);
  assert.equal(r.check.rentsAddUpToTotal, true);
  // Nobody prefers another room: in each row of the table, their own room is the best.
  r.check.table.forEach((row, person) => {
    assert.equal(Math.max(...row), row[r.assignments[person].room]);
  });
  // Each gain is what the person said minus what they pay.
  for (const a of r.assignments) assert.equal(a.gain, a.valuesRoomAt - a.pays);
  // An even split of 800 each would leave someone wanting to swap.
  assert.deepEqual(r.evenSplit.rentEach, [800, 800, 800]);
  assert.ok(r.evenSplit.envy.length > 0);
  assert.deepEqual(r.notes, []);
});

test("setSetup refuses bad input and changes nothing", () => {
  const sheet = Sheet.example();
  const before = snapshot(sheet);
  const cases = [
    [{ total: 0 }, "total"],
    [{ total: 12.5 }, "total"],
    [{ total: LIMITS.maxTotal + 1 }, "total"],
    [{ currency: "DOLLARS" }, "currency"],
    [{ people: ["Ana"] }, "people"],
    [{ people: ["Ana", "ana ", "Ben"] }, "people.1"],
    [{ people: ["Ana", " ", "Ben"] }, "people.1"],
    [{ people: ["Ana", "B".repeat(25), "Ben"] }, "people.1"],
    [{ people: ["Ana", "Ben"] }, "rooms"],
    [{ rooms: ["A", "B", "C", "D"] }, "rooms"],
    [{ people: ["Ana", 5, "Ben"] }, "people.1"],
    [null, "setup"],
  ];
  for (const [change, field] of cases) {
    const result = sheet.setSetup(change);
    assert.equal(result.ok, false, JSON.stringify(change));
    assert.equal(result.field, field, JSON.stringify(change));
    assert.ok(result.reason.length > 10);
    assert.equal(snapshot(sheet), before);
  }
});

test("setSetup: a new total rescales, a new size starts from an even split, names are trimmed", () => {
  const sheet = Sheet.example();
  // A row somebody entered keeps its proportions under a new total; the example's made-up rows do not stay.
  assert.equal(sheet.setBids(0, [1200, 750, 450]).ok, true);
  assert.equal(sheet.getState().isExample, false);
  let state = sheet.setSetup({ total: 1200 });
  assert.equal(state.ok, true);
  assert.deepEqual(state.people[0].amounts, [600, 375, 225]);
  assert.deepEqual(state.people[1].amounts, [400, 400, 400]);
  assert.deepEqual(state.unanswered, ["Ben", "Chloe"]);
  assert.ok(state.people.every((p) => p.addsUp));
  assert.equal(state.isExample, false);
  state = sheet.setSetup({ people: ["  Ana  ", "Ben", "Chloe", "Dev"], rooms: ["A", "B", "C", "D"] });
  assert.equal(state.ok, true);
  assert.equal(state.people[0].name, "Ana");
  assert.deepEqual(state.people[3].amounts, [300, 300, 300, 300]);
  assert.ok(state.people.every((p) => !p.hasEnteredAmounts));
  state = sheet.setSetup({ currency: " NT$ ", rooms: ["A", "B", "C", "Loft"] });
  assert.equal(state.currency, "NT$");
  assert.equal(state.rooms[3].name, "Loft");
  assert.deepEqual(state.people[3].amounts, [300, 300, 300, 300]);
});

test("setBids refuses anything that does not add up, with the gap in words", () => {
  const sheet = Sheet.example();
  sheet.solve();
  const before = snapshot(sheet);
  const under = sheet.setBids(1, [900, 800, 600]);
  assert.equal(under.ok, false);
  assert.match(under.reason, /Ben's amounts add up to \$2,300, which is \$100 under the total rent of \$2,400/);
  const over = sheet.setBids(1, [1000, 900, 600]);
  assert.match(over.reason, /\$100 over/);
  assert.equal(sheet.setBids(3, [800, 800, 800]).field, "person");
  assert.equal(sheet.setBids(0, [1200, 1200]).field, "amounts");
  assert.equal(sheet.setBids(0, [2400.5, 0, -0.5]).field, "amounts.0");
  assert.equal(sheet.setBids(0, [2500, -100, 0]).field, "amounts.1");
  assert.equal(snapshot(sheet), before);
  assert.ok(sheet.getState().result, "a refused change keeps the shown result");
  const good = sheet.setBids(1, [800, 1000, 600]);
  assert.equal(good.ok, true);
  assert.equal(good.result, null, "a change clears the result");
  assert.deepEqual(good.people[1].amounts, [800, 1000, 600]);
});

test("typing one box at a time: solve refuses until the row adds up, balance fixes it", () => {
  const sheet = Sheet.example();
  assert.equal(sheet.setAmount(2, 0, 1000).ok, true);
  let state = sheet.getState();
  assert.equal(state.people[2].stillToAssign, -100);
  assert.equal(state.readyToSplit, false);
  const refused = sheet.solve();
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /Chloe's amounts are \$100 over the total rent/);
  assert.equal(refused.field, "bids.2");
  assert.equal(sheet.setAmount(2, 5, 10).ok, false);
  assert.equal(sheet.setAmount(2, 0, -1).ok, false);
  state = sheet.balance(2);
  assert.equal(state.people[2].addsUp, true);
  assert.equal(sheet.solve().ok, true);
});

test("a blank sheet says what is missing", () => {
  const sheet = new Sheet();
  const state = sheet.getState();
  assert.equal(state.readyToSplit, false);
  assert.deepEqual(state.problems, ["Enter the total rent."]);
  assert.equal(sheet.solve().ok, false);
  assert.equal(sheet.setBids(0, [0, 0, 0]).field, "total");
});

test("negative rent is explained, and the option avoids it or says it cannot", () => {
  const sheet = new Sheet();
  sheet.setSetup({ total: 1000, people: ["A", "B", "C"], rooms: ["Suite", "Den", "Closet"] });
  sheet.setBids(0, [1000, 0, 0]);
  sheet.setBids(1, [1000, 0, 0]);
  sheet.setBids(2, [500, 500, 0]);
  const state = sheet.solve();
  assert.equal(state.ok, true);
  assert.ok(state.result.rents.some((r) => r.rent < 0));
  assert.equal(state.result.notes.length, 1);
  assert.match(state.result.notes[0], /Closet has a rent below zero/);
  assert.equal(sheet.setOption({ nonNegativePrices: "yes" }).ok, false);
  sheet.setOption({ nonNegativePrices: true });
  const strict = sheet.solve();
  if (strict.ok) {
    assert.ok(strict.result.rents.every((r) => r.rent >= 0));
  } else {
    assert.match(strict.reason, /zero or more/);
    assert.equal(sheet.getState().result, null);
  }
});

test("preview changes nothing and matches solve", () => {
  const sheet = Sheet.example();
  const viaSheet = sheet.solve().result;
  const viaPreview = Sheet.preview({ total: 2400, bids: sheet.bids, people: sheet.people, rooms: sheet.rooms, currency: "$" });
  assert.equal(viaPreview.ok, true);
  assert.deepEqual(viaPreview.assignments, viaSheet.assignments);
  assert.deepEqual(viaPreview.check, viaSheet.check);
  const unnamed = Sheet.preview({ total: 1000, bids: [[600, 400], [500, 500]] });
  assert.deepEqual(unnamed.assignments.map((a) => [a.personName, a.roomName, a.pays]), [["Person 1", "Room 1", 550], ["Person 2", "Room 2", 450]]);
  assert.equal(Sheet.preview({ total: 1000, bids: [[600, 400], [500, 400]] }).ok, false);
  assert.equal(Sheet.preview({ total: 1000, bids: [[600, 400], [500, 500]], people: ["Only one"] }).ok, false);
});

test("links: a sheet survives the round trip, including non-Latin names", () => {
  const sheet = Sheet.example();
  sheet.setSetup({ people: ["小芳", "Zoë", "Ben"], currency: "NT$" });
  const link = sheetLink("https://example.org/", sheet.toJSON(), 1);
  const parsed = parseFragment(new URL(link).hash);
  assert.equal(parsed.me, 1);
  const copy = Sheet.fromJSON(parsed.sheet);
  assert.deepEqual(copy.toJSON(), sheet.toJSON());
  assert.equal(copy.solve().ok, true);
});

test("links: damaged or hostile data is refused", () => {
  assert.equal(decode("not base64 !!"), null);
  assert.equal(decode(""), null);
  assert.equal(decode(encode({ a: 1 }).slice(0, 5)), null);
  assert.equal(decode("A".repeat(20001)), null);
  assert.deepEqual(parseFragment("#s=%%%&me=9"), { sheet: null, me: null, reply: null });
  const good = Sheet.example().toJSON();
  const bad = [
    null,
    { ...good, v: 2 },
    { ...good, p: ["A", "B"] },
    { ...good, t: -5 },
    { ...good, b: [[1, 2, 3], [1, 2, 3]] },
    { ...good, b: good.b.map((row) => row.map(() => "<img>")) },
    { ...good, p: ["<script>".repeat(5), "B", "C"] },
    { ...good, c: "DOLLARS" },
  ];
  for (const data of bad) assert.equal(Sheet.fromJSON(data), null, JSON.stringify(data));
  assert.notEqual(Sheet.fromJSON({ ...good, id: "../../etc" }).id, "../../etc");
});

test("a housemate's reply is taken in only on the same sheet, for the same person", () => {
  const organiser = Sheet.example();
  const theirs = Sheet.fromJSON(parseFragment(new URL(sheetLink("https://example.org/", organiser.toJSON(), 1)).hash).sheet);
  assert.equal(theirs.id, organiser.id);
  theirs.setBids(1, [700, 1000, 700]);
  const reply = parseFragment(new URL(replyLink("https://example.org/", theirs.replyFor(1))).hash).reply;
  const taken = organiser.acceptReply(reply);
  assert.equal(taken.ok, true);
  assert.deepEqual(taken.people[1].amounts, [700, 1000, 700]);
  assert.deepEqual(taken.people[0].amounts, [1200, 750, 450]);

  const other = Sheet.example();
  assert.match(other.acceptReply(reply).reason, /different rent sheet/);
  organiser.setSetup({ people: ["Ana", "Bob", "Chloe"] });
  assert.match(organiser.acceptReply(reply).reason, /entered for "Ben"/);
  assert.equal(organiser.acceptReply({ ...reply, name: "Bob", amounts: [1, 2, 3] }).ok, false);
  assert.equal(organiser.acceptReply({ v: 1 }).ok, false);
  assert.equal(organiser.acceptReply(null).ok, false);
});

// ---------------------------------------------------------------------------------------------------
// Findings of the independent review (work/reviews/2026-11-24-agenticweb-review.md)

test("the example's made-up amounts do not survive setting up a real place", () => {
  // The assistant's sample request: three housemates, 2400 a month. Same head count and total as the example.
  const sheet = Sheet.example();
  const state = sheet.setSetup({ total: 2400, people: ["Dana", "Eli", "Fay"], rooms: ["Front room", "Back room", "Box room"] });
  assert.equal(state.ok, true);
  assert.equal(state.isExample, false);
  for (const person of state.people) {
    assert.deepEqual(person.amounts, [800, 800, 800], `${person.name} starts from the even placeholder`);
    assert.equal(person.hasEnteredAmounts, false);
  }
  assert.deepEqual(state.unanswered, ["Dana", "Eli", "Fay"]);
  // Renaming one room of the example is enough to make it the visitor's own sheet.
  const renamed = Sheet.example();
  renamed.setSetup({ rooms: ["Big room with balcony", "Middle room", "Attic"] });
  assert.ok(renamed.getState().people.every((p) => !p.hasEnteredAmounts));
});

test("a split worked out from untouched rows says whose answers are missing", () => {
  const sheet = new Sheet();
  sheet.setSetup({ total: 2400 });
  let state = sheet.solve();
  assert.equal(state.ok, true);
  assert.deepEqual(state.result.unanswered, ["Housemate 1", "Housemate 2", "Housemate 3"]);
  assert.match(state.result.notes[0], /Housemate 1, Housemate 2 and Housemate 3 have not entered amounts yet/);
  sheet.setBids(0, [1200, 700, 500]);
  sheet.setBids(1, [900, 900, 600]);
  state = sheet.solve();
  assert.deepEqual(state.result.unanswered, ["Housemate 3"]);
  assert.match(state.result.notes[0], /^Housemate 3 has not entered amounts yet\. That row is still an even placeholder/);
  sheet.setBids(2, [800, 800, 800]);
  state = sheet.solve();
  assert.equal(state.result.unanswered, undefined, "an even row somebody chose is an answer");
  assert.deepEqual(state.unanswered, []);
});

test("a reply only fits the rooms and the total it was written against", () => {
  const sheet = Sheet.example();
  for (const [i, row] of [[1200, 750, 450], [950, 850, 600], [900, 800, 700]].entries()) sheet.setBids(i, row);
  const reply = sheet.replyFor(1);
  assert.deepEqual(reply.rooms, ["Big room with balcony", "Middle room", "Small room by the door"]);
  assert.equal(reply.total, 2400);
  assert.equal(sheet.acceptReply(reply).ok, true);
  // The organiser swaps two rooms afterwards: same count, same total, different meaning.
  sheet.setSetup({ rooms: ["Middle room", "Big room with balcony", "Small room by the door"] });
  const swapped = sheet.acceptReply(reply);
  assert.equal(swapped.ok, false);
  assert.match(swapped.reason, /rooms on this sheet have changed/);
  sheet.setSetup({ rooms: reply.rooms, total: 2500 });
  const repriced = sheet.acceptReply({ ...reply });
  assert.equal(repriced.ok, false);
  assert.match(repriced.reason, /total rent on this sheet has changed/);
  // A reply made before these fields existed is still taken on the old checks.
  sheet.setSetup({ total: 2400 });
  const { rooms, total, ...old } = reply;
  assert.equal(sheet.acceptReply(old).ok, true);
  assert.equal(sheet.acceptReply({ ...reply, rooms: "x" }).ok, false);
});

test("a housemate's own link leaves the others' amounts out", () => {
  const sheet = Sheet.example();
  sheet.setBids(0, [1300, 700, 400]);
  sheet.setBids(1, [950, 850, 600]);
  const forBen = sheet.toJSONFor(1);
  assert.deepEqual(forBen.b[1], [950, 850, 600], "their own row is theirs");
  assert.deepEqual(forBen.b[0], [800, 800, 800]);
  assert.deepEqual(forBen.b[2], [800, 800, 800]);
  assert.deepEqual(forBen.d, [0, 1, 0]);
  assert.equal(forBen.o, 1);
  assert.equal(sheet.toJSON().o, undefined, "the whole sheet is not marked as one housemate's copy");
  assert.deepEqual(sheet.toJSON().b[0], [1300, 700, 400], "the organiser's sheet is untouched");
  const opened = Sheet.fromJSON(forBen);
  assert.equal(opened.id, sheet.id, "so the reply still belongs to the same sheet");
  assert.equal(opened.getState().personalCopy, true);
  assert.equal(Sheet.fromJSON(opened.toJSON()).personal, true, "and stays marked after a reload");
  // A split tried on that copy says why it is not the real one.
  assert.match(opened.solve().result.notes[0], /does not carry the amounts of Ana and Chloe/);
  assert.equal(sheet.acceptReply(opened.replyFor(1)).ok, true);
});

test("the example's rows are marked one by one, and a new currency sign alone changes nothing", () => {
  const sheet = Sheet.example();
  let state = sheet.setSetup({ currency: "NT$" });
  assert.equal(state.isExample, true, "still the example");
  assert.deepEqual(state.people[0].amounts, [1200, 750, 450]);
  // The visitor tries another number for Ana, then makes the sheet their own: only Ana's row was entered.
  sheet.setAmount(0, 0, 1250);
  sheet.setAmount(0, 1, 700);
  assert.deepEqual(sheet.toJSON().d, [1, 2, 2]);
  const reloaded = Sheet.fromJSON(JSON.parse(JSON.stringify(sheet.toJSON())));
  state = reloaded.setSetup({ people: ["Dana", "Eli", "Fay"] });
  assert.deepEqual(state.people.map((p) => p.amounts), [[1250, 700, 450], [800, 800, 800], [800, 800, 800]]);
  assert.deepEqual(state.unanswered, ["Eli", "Fay"]);
  assert.deepEqual(reloaded.toJSON().d, [1, 0, 0]);
  // A sheet saved before rows were marked: an untouched example is all made up.
  const old = Sheet.fromJSON({ ...Sheet.example().toJSON(), d: [1, 1, 1] });
  assert.deepEqual(old.setSetup({ total: 3000 }).people[2].amounts, [1000, 1000, 1000]);
});
