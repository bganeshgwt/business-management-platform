// Which of an order's KOTs a print from the till puts on paper, and how the
// till then says so. Kept free of React so the rule can be tested on its own.
//
// A KOT on paper is an instruction to cook, so the till never prints one the
// kitchen has already been handed on paper: that is how a dish gets cooked
// twice. Only a ticket that still has food on it is printed.
//
//   before  the ids of the order's tickets just before a save: "Save & print
//           KOT" prints only the tickets that save cut (an earlier round may
//           be on the kitchen screen already, printed or not).
//   null    "Print new KOTs" on a running order with nothing to save: every
//           ticket nobody has printed yet (a captain's phone order, say, sent
//           without a printer to hand).
export const ticketsToPrint = (tickets, before) =>
  (tickets || []).filter(
    (ticket) =>
      ticket.status !== "cancelled" &&
      (ticket.items || []).some((item) => Number(item.liveQuantity) > 0) &&
      (before ? !before.has(ticket.id) : !(Number(ticket.printCount) > 0))
  );

// "ORD-0012 saved · 2 KOTs printed", or the note alone (capitalised) when
// nothing was said before it.
export const withNote = (shown, note) => {
  if (!note) {
    return shown || "";
  }

  return shown ? `${shown} · ${note}` : `${note.charAt(0).toUpperCase()}${note.slice(1)}`;
};
