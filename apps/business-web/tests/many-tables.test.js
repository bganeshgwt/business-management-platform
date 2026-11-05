import { test } from "node:test";
import assert from "node:assert/strict";
import { nextNumber, rowsOf, tablesOf } from "../src/modules/restaurant/tables/pages/manyTables.js";

// "Add many tables" (restaurant Tables): each row's numbers, every row's
// tables as sent, and where a new run starts after the numbers in use.

test("a row makes its prefix and numbers, as many as it says", () => {
  assert.deepEqual(rowsOf({ prefix: "T", from: "1", count: "3" }), ["T1", "T2", "T3"]);
  assert.deepEqual(rowsOf({ prefix: " R-", from: "101", count: "2" }), ["R-101", "R-102"]);
  assert.deepEqual(rowsOf({ prefix: "", from: "7", count: "2" }), ["7", "8"]);
  assert.deepEqual(rowsOf({ prefix: "T", from: "1", count: "" }), []);
  assert.deepEqual(rowsOf({ prefix: "T", from: "1", count: "-2" }), []);
  assert.equal(rowsOf({ prefix: "T", from: "1", count: "5000" }).length, 200);
});

test("two rows: different seats, floors and areas, each table carrying its own", () => {
  const tables = tablesOf([
    { prefix: "T", from: "1", count: "2", capacity: "4", floorId: "3", areaId: "" },
    { prefix: "T", from: "3", count: "1", capacity: "6", floorId: "3", areaId: "9" },
  ]);
  assert.deepEqual(tables, [
    { tableNo: "T1", capacity: 4, floorId: 3, areaId: null, status: "active" },
    { tableNo: "T2", capacity: 4, floorId: 3, areaId: null, status: "active" },
    { tableNo: "T3", capacity: 6, floorId: 3, areaId: 9, status: "active" },
  ]);
});

test("a new run starts after the highest number in use with that prefix", () => {
  const tables = [{ tableNo: "T1" }, { tableNo: "t8" }, { tableNo: "TA3" }, { tableNo: "T4B" }, { tableNo: "12" }];
  assert.equal(nextNumber(tables, "T"), 9);
  assert.equal(nextNumber(tables, "TA"), 4);
  assert.equal(nextNumber(tables, "R"), 1);
  assert.equal(nextNumber([], "T"), 1);
});
