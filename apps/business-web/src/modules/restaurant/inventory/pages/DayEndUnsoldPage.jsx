import { useEffect, useState } from "react";
import PageHeader from "../../../../components/PageHeader";
import { EmptyState, ErrorMessage, Loading } from "../../../../components/Feedback";
import { getErrorMessage } from "../../../../services/api";
import { withApproval } from "../../../../services/approval";
import { moneyExact } from "@bmp/shared/format";
import { toast } from "../../../../services/toast";
import useAuth from "../../../../hooks/useAuth";
import { getSettings } from "../../setup/services/restaurant.service";
import { listInventoryItems, stockOut } from "../services/inventory.service";
import "../styles/day-end.css";

// Day-end unsold (a bakery, a café's counter): what was baked and is left at
// closing. Each item says how much is still on the shelf; what will not be
// sold tomorrow (cream cakes, sandwiches) is written off as "Unsold at day
// end" in one go, at cost, so the day's food cost is true. What keeps
// (cookies, rusks) is simply left in stock.
export default function DayEndUnsoldPage() {
  const { hasPermission } = useAuth();
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [left, setLeft] = useState({});
  const [busy, setBusy] = useState(false);
  const [currency, setCurrency] = useState("₹");
  const [version, setVersion] = useState(0);
  useEffect(() => { getSettings().then((s) => setCurrency(s.currencySymbol || "₹")).catch(() => undefined); }, []);
  useEffect(() => {
    let live = true;
    listInventoryItems({ status: "active" })
      .then((rows) => { if (live) { setItems(rows.filter((row) => row.itemType === "prepared")); setError(""); } })
      .catch((err) => { if (live) setError(getErrorMessage(err)); });
    return () => { live = false; };
  }, [version]);
  const canWrite = hasPermission("inventory.manage");
  const chosen = (items || []).filter((item) => Number(left[item.id]) > 0);
  const value = chosen.reduce((sum, item) => sum + Number(left[item.id]) * Number(item.averageCost || 0), 0);

  async function writeOff() {
    setBusy(true); setError("");
    let done = 0;
    try {
      for (const item of chosen) {
        const quantity = Number(left[item.id]);
        await withApproval((headers) => stockOut({ inventoryItemId: item.id, quantity, transactionType: "wastage", wasteReason: "unsold",
          notes: "Day-end unsold count" }, headers), `Write off ${quantity} ${item.unitShortName || ""} ${item.name} (unsold)`);
        done += 1;
      }
      toast.success(`${done} item${done === 1 ? "" : "s"} written off as unsold`);
      setLeft({});
      setVersion((n) => n + 1);
    } catch (err) {
      setError(`${done ? `${done} written off; ` : ""}${getErrorMessage(err)}`);
      setVersion((n) => n + 1);
    } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <PageHeader icon="box" title="Day-end unsold" description="At closing: what is left of today's bakes. Write off what will not sell tomorrow; what keeps stays in stock." />
      <ErrorMessage message={error} />
      {!items && !error ? <Loading /> : items?.length === 0 ? (
        <EmptyState icon="box" title="No baked items yet" description="Bakes are prepared stock items made from a recipe (Stock › Items › Production). They show here with what is left." />
      ) : items && (
        <div className="de-card">
          <table className="de-table">
            <thead><tr><th>Item</th><th className="r">In stock now</th><th className="r">Cost</th><th className="r">Write off (unsold)</th></tr></thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className={Number(left[item.id]) > 0 ? "is-on" : ""}>
                  <td><strong>{item.name}</strong></td>
                  <td className="r">{item.stockHidden ? "—" : `${Number(item.currentStock).toLocaleString("en-IN", { maximumFractionDigits: 3 })} ${item.unitShortName || ""}`}</td>
                  <td className="r">{item.averageCost ? `${moneyExact(item.averageCost, currency)}/${item.unitShortName || "unit"}` : "—"}</td>
                  <td className="r">
                    <span className="de-input">
                      <input type="number" min="0" step="any" max={item.currentStock > 0 ? item.currentStock : undefined} disabled={!canWrite || busy || !(Number(item.currentStock) > 0)}
                        aria-label={`Unsold ${item.name}`} value={left[item.id] ?? ""} onChange={(e) => setLeft((l) => ({ ...l, [item.id]: e.target.value }))} placeholder="0" />
                      {Number(item.currentStock) > 0 && canWrite && <button type="button" className="link-button" onClick={() => setLeft((l) => ({ ...l, [item.id]: String(item.currentStock) }))}>All</button>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {canWrite && (
            <div className="de-foot">
              <span>{chosen.length ? <>Writing off {chosen.length} item{chosen.length === 1 ? "" : "s"} · <strong>{moneyExact(value, currency)}</strong> at cost</> : <span className="muted">Type what is left and will not sell tomorrow.</span>}</span>
              <button type="button" className="button" disabled={!chosen.length || busy} onClick={writeOff}>{busy ? "Writing off…" : "Write off as unsold"}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
