// "Add many tables": the table numbers each row makes, and where a new run
// of numbers starts.

const whole = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
};

// One row's table numbers: its prefix and its first number on, as many as it
// says ("T", 1, 3 → T1, T2, T3). A row with no count makes none.
export function rowsOf(group) {
  const from = whole(group.from, 1);
  const count = Math.min(whole(group.count), 200);
  const prefix = String(group.prefix || "").trim();

  return Array.from({ length: count }, (_, index) => `${prefix}${from + index}`);
}

// Every row's tables, ready to send: number, seats, floor and area.
export function tablesOf(groups) {
  return groups.flatMap((group) =>
    rowsOf(group).map((tableNo) => ({
      tableNo,
      capacity: whole(group.capacity, 1) || 1,
      floorId: Number(group.floorId),
      areaId: group.areaId ? Number(group.areaId) : null,
      status: "active",
    }))
  );
}

// The number after the highest in use with this prefix (T1 to T8 in use →
// 9; none → 1). "T" does not count "TA1"; the case does not matter.
export function nextNumber(tables, prefix) {
  const start = String(prefix || "").trim().toLowerCase();
  let highest = 0;

  for (const table of tables) {
    const number = String(table.tableNo || "").toLowerCase();

    if (number.startsWith(start)) {
      const rest = number.slice(start.length);

      if (/^\d+$/.test(rest)) highest = Math.max(highest, Number(rest));
    }
  }

  return highest + 1;
}
