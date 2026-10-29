import { test } from "node:test";
import assert from "node:assert/strict";
import { durationText, hourRange, hoursText } from "../src/modules/restaurant/reports/pages/kitchenReportWords.js";
import { kitchenStationsCsv } from "../src/modules/restaurant/reports/pages/reportCsv.js";

// How the kitchen-station report says its times and hours, on screen and in
// its CSV (reports/pages/kitchenReportWords.js, reportCsv.js).

test("times as a kitchen reads them, and a dash when nothing was timed", () => {
  assert.equal(durationText(null), "—");
  assert.equal(durationText(undefined), "—");
  assert.equal(durationText(45), "45 s");
  assert.equal(durationText(59.6), "1 min");
  assert.equal(durationText(800), "13 min");
  assert.equal(durationText(3900), "1 h 05 min");
  assert.equal(durationText(-3), "0 s");
});

test("the hours tickets were sent in, busiest first", () => {
  assert.equal(hourRange(9), "09:00–10:00");
  assert.equal(hourRange(23), "23:00–00:00");
  assert.equal(hoursText([]), "—");
  assert.equal(hoursText([{ hour: 19, tickets: 2 }, { hour: 18, tickets: 1 }]), "19:00–20:00 (2), 18:00–19:00 (1)");
});

test("the CSV: the report's name and period, the late mark, a row a station and the whole kitchen", () => {
  const figures = (tickets, extra = {}) => ({
    tickets, dishes: tickets * 2, avgReadySeconds: 600, p90ReadySeconds: 900, avgServeSeconds: null, p90ServeSeconds: null,
    late: 1, cleared: 0, busiestHours: [{ hour: 19, tickets }], ...extra,
  });
  const rows = kitchenStationsCsv({
    from: "2026-10-28", to: "2026-10-28", outletName: null, lateMinutes: 20, cancelledLeftOut: 2,
    stations: [{ stationId: 1, stationName: "Main kitchen", ...figures(3) }],
    total: figures(3),
  });
  assert.deepEqual(rows[0], ["Kitchen stations"]);
  assert.match(rows[4][0], /not ready 20 minutes after it was sent\. Cancelled tickets left out: 2\./);
  assert.deepEqual(rows.at(-2), ["Main kitchen", 3, 6, 600, 900, "", "", 1, 0, "19:00–20:00 (3)"]);
  assert.equal(rows.at(-1)[0], "Whole kitchen");
  const empty = kitchenStationsCsv({ from: "2026-10-28", to: "2026-10-28", lateMinutes: 20, cancelledLeftOut: 0, stations: [], total: null });
  assert.equal(empty.at(-1)[0], "Station");
});
