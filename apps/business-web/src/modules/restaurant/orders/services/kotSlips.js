// After a till changes an order (a dish taken off, the order cancelled, the
// party moved), the kitchen may be cooking from a paper KOT that is now
// wrong. This prints the change slips the API wrote for that change, at once,
// on the till's printer, the way new KOTs print after a save. Kept free of
// React so every screen that changes orders uses the same rule.
import { claimChangeSlips } from "../../kitchen/services/kitchen.service.js";
import { printSlip } from "../../../../services/kot.js";

// "1 cancel slip printed for the kitchen (Tandoor)", or "" when nothing
// needed printing.
const slipNote = (slips) => {
  if (!slips || slips.length === 0) {
    return "";
  }

  const kinds = [...new Set(slips.map((slip) => (slip.kind === "table_changed" ? "table-change" : "cancel")))];
  const word = kinds.length === 1 ? `${kinds[0]} slip` : "kitchen slip";
  const stations = [...new Set(slips.map((slip) => slip.stationName))].join(", ");

  return `${slips.length} ${word}${slips.length === 1 ? "" : "s"} printed for the kitchen (${stations})`;
};

// Claims and prints every unprinted slip of these orders. Never throws: the
// change is already saved, and a slip that could not be printed here stays
// on the kitchen screen's Change slips list, to print from there.
export const printChangeSlips = async (orderIds, { restaurantName = "", paperWidth = "80mm" } = {}) => {
  const ids = [...new Set((orderIds || []).filter(Boolean).map(Number))];

  if (ids.length === 0) {
    return { slips: [], note: "", problem: "" };
  }

  try {
    const slips = await claimChangeSlips(ids);

    for (const slip of slips) {
      printSlip(slip, { restaurantName, paperWidth });
    }

    return { slips, note: slipNote(slips), problem: "" };
  } catch {
    return {
      slips: [],
      note: "",
      problem: "The kitchen change slip could not be printed here. Print it from the kitchen screen's Change slips.",
    };
  }
};
