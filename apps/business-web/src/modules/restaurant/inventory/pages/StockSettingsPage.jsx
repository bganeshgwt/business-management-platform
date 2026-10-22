import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import SectionCard from "../../../../components/SectionCard";
import Icon from "@bmp/ui/Icon";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import useAuth from "../../../../hooks/useAuth";
import useShake from "../../../../hooks/useShake";
import { getStockSettings, saveStockSettings } from "../services/inventory.service";
import { getSettings } from "../../setup/services/restaurant.service";
import { getErrorMessage } from "../../../../services/api";
import { money } from "@bmp/shared/format";
import { dayMonth } from "@bmp/shared/dates";
import "../../../../styles/stock.css";
import "../../../../styles/backoffice-sweep.css";

// Settings → Stock & purchasing (sweeps SW-B-10 and SW-B-11).
//
// Two limits that make sure the person who spends is not the only one who
// says yes to a large amount, and how stock sent between stores lands. A
// blank limit means no limit, which is how every restaurant starts: an
// approval step nobody asked for would stop the morning's buying.

const asText = (value) => (value === null || value === undefined ? "" : String(value));

export default function StockSettingsPage() {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("restaurant.settings.manage");
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(null);
  const [currency, setCurrency] = useState("₹");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [formRef, shake] = useShake();

  useEffect(() => {
    getStockSettings()
      .then((data) => {
        setSaved(data);
        setForm({
          poApprovalLimit: asText(data.poApprovalLimit),
          writeoffApprovalLimit: asText(data.writeoffApprovalLimit),
          transferReceiptRequired: data.transferReceiptRequired,
        });
      })
      .catch((err) => setError(getErrorMessage(err)));
    getSettings()
      .then((data) => setCurrency(data.currencySymbol || "₹"))
      .catch(() => undefined);
  }, []);

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSuccess("");

    try {
      const result = await saveStockSettings({
        poApprovalLimit: form.poApprovalLimit === "" ? null : Number(form.poApprovalLimit),
        writeoffApprovalLimit: form.writeoffApprovalLimit === "" ? null : Number(form.writeoffApprovalLimit),
        transferReceiptRequired: form.transferReceiptRequired,
      });
      setSaved(result.data);
      setSuccess(result.message);
    } catch (err) {
      setError(getErrorMessage(err));
      shake();
    } finally {
      setBusy(false);
    }
  };

  const limitWords = (value, what) =>
    value === "" || value === null
      ? `No limit: every ${what} goes straight through.`
      : `Over ${money(Number(value), currency)}, a ${what} needs a second person.`;

  return (
    <div className="stack bo-page">
      <PageHeader
        icon="sliders"
        title="Stock & purchasing"
        description="Approval limits for large purchase orders and write-offs, and how stock sent between your stores is received."
      />

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      {!form ? (
        <Loading />
      ) : (
        <form className="stack" onSubmit={save} ref={formRef}>
          <SectionCard
            icon="shield"
            tone="warning"
            title="Approval limits"
            description="Leave a box blank for no limit. The people who can approve are set under Roles."
          >
            <div className="bo-settings-grid">
              <label className="field">
                <span>Purchase orders over (before GST)</span>
                <span className="input-with-prefix">
                  <span aria-hidden="true">{currency}</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    inputMode="numeric"
                    value={form.poApprovalLimit}
                    onChange={(event) => setForm({ ...form, poApprovalLimit: event.target.value })}
                    placeholder="No limit"
                    disabled={!canEdit}
                  />
                </span>
                <small className="muted">
                  {limitWords(form.poApprovalLimit, "purchase order")} It waits as "Waiting for approval" until someone with
                  "Approve purchase orders" (owners, by default) or a manager's PIN approves it or sends it back with a note.
                </small>
              </label>
              <label className="field">
                <span>Wastage or stock out over (at cost)</span>
                <span className="input-with-prefix">
                  <span aria-hidden="true">{currency}</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    inputMode="numeric"
                    value={form.writeoffApprovalLimit}
                    onChange={(event) => setForm({ ...form, writeoffApprovalLimit: event.target.value })}
                    placeholder="No limit"
                    disabled={!canEdit}
                  />
                </span>
                <small className="muted">
                  {limitWords(form.writeoffApprovalLimit, "write-off")} The kitchen's everyday waste goes straight in; a larger one
                  asks for a manager's PIN, tied to that item, quantity and value. Dishes written off follow the same limit.
                </small>
              </label>
            </div>
          </SectionCard>

          <SectionCard
            icon="truck"
            title="Transfers between stores"
            description="How stock sent on a transfer note lands at the other store."
          >
            <label className="bo-switch">
              <input
                type="checkbox"
                checked={form.transferReceiptRequired}
                onChange={(event) => setForm({ ...form, transferReceiptRequired: event.target.checked })}
                disabled={!canEdit}
              />
              <span>
                <strong>The receiving store confirms what arrived</strong>
                <span className="muted small">
                  {form.transferReceiptRequired
                    ? "Stock leaves the sender at dispatch and shows as in transit. Only what the receiving store confirms lands on its shelf; anything short or damaged is written off there with a reason."
                    : "Off: stock leaves one store and lands at the other the moment a note is sent. Turn this on when a driver carries the goods and someone should count them at the other end."}
                </span>
              </span>
            </label>
            <p className="muted small">
              Notes and indents are on <Link to="/inventory/transfers">Transfers &amp; indents</Link>.
            </p>
          </SectionCard>

          {saved && saved.updatedAt && (
            <p className="muted small">
              Last changed {dayMonth(saved.updatedAt, { year: true, time: true })}
              {saved.updatedByName ? ` by ${saved.updatedByName}` : ""}.
            </p>
          )}

          {canEdit ? (
            <div className="form-actions">
              <button type="submit" className="button" disabled={busy}>
                <Icon name="check" size={16} /> {busy ? "Saving…" : "Save"}
              </button>
            </div>
          ) : (
            <p className="muted small">Only the owner (restaurant settings) can change these.</p>
          )}
        </form>
      )}
    </div>
  );
}
