// Printing a bill, the only way the screens do it: the print is counted on the
// server first, and what comes back — with its print count, and "duplicate"
// on every copy after the first — is what goes to the printer.
//
// A reprint needs the reprint permission (a cashier has it) or a manager's
// PIN; the prompt opens by itself. The first print needs neither: a captain
// printing the bill at the table is normal.
import { registerPrint } from "../../billing/services/bill.service";
import { printBill } from "./receipt";
import { withApproval } from "../../../../services/approval";

export const printCountedBill = async (bill, options = {}) => {
  const reprint = Number(bill.printCount || 0) > 0;

  const counted = await withApproval(
    (headers) => registerPrint(bill.id, headers),
    reprint ? `Reprint bill ${bill.billNumber}` : `Print bill ${bill.billNumber}`,
    reprint ? { permission: "bills.reprint", scope: { billId: bill.id } } : {}
  );

  printBill(counted, options);

  return counted;
};
