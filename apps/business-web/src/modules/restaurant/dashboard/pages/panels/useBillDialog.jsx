import { useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { createBill, getBill } from "../../../billing/services/bill.service";
import { settingsQuery } from "../../../setup/services/restaurant.service";
import { getErrorMessage } from "../../../../../services/api";
import BillModal from "../../../orders/pages/BillModal";
import { refreshDashboard } from "./panelData";

// One bill opened from a panel, in the same bill dialog the Bills screen
// uses: payment, the manager PIN for anything that needs one, printing.
//
// billOrder: a running table's "Bill", made where it is clicked. Like the
// POS's Bill, it bills every dish still unbilled on the order (POST /bills
// with the order alone) and opens the new bill as the POS shows it: the
// discount, service charge, print and payment, without leaving the
// dashboard. Splitting the bill by dishes stays on the POS (Open order).
export function useBillDialog(onChanged) {
  const settings = useQuery(settingsQuery());
  const [viewing, setViewing] = useState(null);
  const [error, setError] = useState("");

  const open = (id) => {
    setError("");
    getBill(id)
      .then((bill) => setViewing({ bill, mode: "bills" }))
      .catch((err) => setError(getErrorMessage(err)));
  };

  const billOrder = async (orderId) => {
    setError("");
    const bill = await createBill({ orderId });

    setViewing({ bill, mode: "pos" });
    refreshDashboard();
    onChanged?.(bill);
    return bill;
  };

  const changed = (updated) => {
    setViewing((current) => ({ bill: updated, mode: current ? current.mode : "bills" }));
    refreshDashboard();
    onChanged?.(updated);
  };

  const dialog =
    viewing && settings.data
      ? createPortal(
          <BillModal
            key={viewing.bill.id}
            bill={viewing.bill}
            onBill={changed}
            onPaid={() => refreshDashboard()}
            onClose={() => setViewing(null)}
            settings={settings.data}
            currency={settings.data.currencySymbol || "₹"}
            mode={viewing.mode}
          />,
          document.body
        )
      : null;

  return { open, billOrder, dialog, error, clearError: () => setError("") };
}
