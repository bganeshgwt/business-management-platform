import { useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { getBill } from "../../../billing/services/bill.service";
import { settingsQuery } from "../../../setup/services/restaurant.service";
import { getErrorMessage } from "../../../../../services/api";
import BillModal from "../../../orders/pages/BillModal";
import { refreshDashboard } from "./panelData";

// One bill opened from a panel, in the same bill dialog the Bills screen
// uses: payment, the manager PIN for anything that needs one, printing.
export function useBillDialog(onChanged) {
  const settings = useQuery(settingsQuery());
  const [viewing, setViewing] = useState(null);
  const [error, setError] = useState("");

  const open = (id) => {
    setError("");
    getBill(id)
      .then(setViewing)
      .catch((err) => setError(getErrorMessage(err)));
  };

  const changed = (updated) => {
    setViewing(updated);
    refreshDashboard();
    onChanged?.(updated);
  };

  const dialog =
    viewing && settings.data
      ? createPortal(
          <BillModal
            key={viewing.id}
            bill={viewing}
            onBill={changed}
            onPaid={() => refreshDashboard()}
            onClose={() => setViewing(null)}
            settings={settings.data}
            currency={settings.data.currencySymbol || "₹"}
            mode="bills"
          />,
          document.body
        )
      : null;

  return { open, dialog, error, clearError: () => setError("") };
}

