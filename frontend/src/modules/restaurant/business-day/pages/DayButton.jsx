import { useState } from "react";
import { useNavigate } from "react-router-dom";
import Icon from "../../../../components/Icon";
import { getBusinessDay } from "../services/businessDay.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import CloseDayDialog from "./CloseDayDialog";
import OpenDayDialog from "./OpenDayDialog";
import { dateText } from "./moneyText";
// The day dialogs' own styles, wherever they open (the dashboard too).
import "../../../../styles/billing.css";
import "../../../../styles/cash.css";
import { forgetBusinessDay } from "./staleDayStatus";

// Open day / Close day where the person is (the dashboard), in the same
// dialogs as the Business day page. The day's status is read fresh on the
// click, so the dialog matches the server even if the screen was a little old.
export default function DayButton({ dayOpen, currency, onChanged }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      const fresh = await getBusinessDay();
      setStatus(fresh);
      setDialog(fresh.current ? "close" : "open");
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const done = (message) => {
    setDialog(null);
    forgetBusinessDay();
    toast.success(message);
    onChanged?.();
  };

  return (
    <>
      <button type="button" className={`button ${dayOpen ? "button-secondary" : ""}`} onClick={start} disabled={busy}>
        <Icon name={dayOpen ? "lock" : "unlock"} size={16} />
        {busy ? "Checking…" : dayOpen ? "Close day" : "Open day"}
      </button>
      {dialog === "open" && status && (
        <OpenDayDialog opening={status.opening} currency={currency} onClose={() => setDialog(null)}
          onOpened={(day, { reopened }) => done(`Business day ${dateText(day.businessDate, { weekday: true })} ${reopened ? "is open again" : "opened"}`)} />
      )}
      {dialog === "close" && status?.current && (
        <CloseDayDialog day={status.current} currency={currency}
          onClose={() => setDialog(null)}
          onClosed={(day) => done(`Business day ${dateText((day || status.current).businessDate, { weekday: true })} closed`)}
          onShowDrawers={() => { setDialog(null); navigate("/business-day?tab=drawers"); }} />
      )}
    </>
  );
}
