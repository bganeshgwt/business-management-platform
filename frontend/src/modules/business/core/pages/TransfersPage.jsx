import { useEffect, useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import Modal from "../../../../components/Modal";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "./FormDialog";
import ReasonDialog from "./ReasonDialog";
import { Badge, BusinessHeader, Field, FormError, PeriodFilter } from "./ui";
import { dateTime, newKey, quantity, useOpenBusiness, useOptions, useServerList } from "./hooks";

// Moving stock between locations. Dispatch takes it off the sending shelf;
// the receiving location confirms arrival; until then it is in transit.
export default function TransfersPage() {
  const biz = useOpenBusiness();
  const [status, setStatus] = useState("");
  const list = useServerList("transfers", { gridId: "business-transfers", period: true, params: status ? { status } : {} });
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [notice, setNotice] = useState("");
  const enoughLocations = biz.allLocations.filter((l) => l.active).length > 1;

  const columns = useMemo(() => [
    { key: "transfer_no", header: "Transfer", value: (t) => t.transfer_no, mobile: "title", pin: true,
      render: (t) => <button type="button" className="link-button mono" onClick={() => setOpenId(t.id)}>{t.transfer_no}</button> },
    { key: "created_at", header: "Sent", type: "datetime", value: (t) => t.created_at },
    { key: "route", header: "From → to", value: (t) => `${t.from_location_name} → ${t.to_location_name}`, mobile: "subtitle" },
    { key: "lines", header: "Lines", type: "number", value: (t) => t.line_count },
    { key: "value", header: "Value at cost", type: "money", exact: true, value: (t) => Number(t.value), total: "sum", mobile: "show" },
    { key: "status", header: "Status", type: "status", value: (t) => t.status, render: (t) => <Badge status={t.status} />, mobile: "show" },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (t) => <button type="button" className="chip-button" onClick={() => setOpenId(t.id)}>{t.status === "in_transit" && biz.can("stock_transfers.approve") ? "Receive" : "Open"}</button> },
  ], [biz]);

  return (
    <div className="stack">
      <BusinessHeader icon="truck" title="Stock transfers"
        description="Send stock from one location to another. It leaves the sender when dispatched and is added at the other end when they confirm it arrived."
        actions={biz.can("stock_transfers.create") && (
          <button type="button" className="button" disabled={!enoughLocations} title={enoughLocations ? undefined : "Add a second location first"} onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} /> New transfer
          </button>
        )} />
      <SuccessMessage message={notice} />
      <ErrorMessage message={list.error} />
      {!enoughLocations && <p className="muted">Transfers need at least two locations. Add one under Settings › Locations.</p>}
      <SectionCard flush icon="list" title="Transfers in this period">
        <DataGrid {...list.gridProps} caption="Stock transfers" columns={columns} currency={biz.symbol} rowNoun={["transfer", "transfers"]}
          toolbar={(
            <>
              <PeriodFilter list={list} />
              <label className="field">
                <span>Status</span>
                <select value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="">All</option>
                  <option value="in_transit">In transit</option>
                  <option value="received">Received</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </label>
            </>
          )}
          rowClassName={(t) => (t.status === "in_transit" ? "dg-tone-warning" : t.status === "cancelled" ? "dg-tone-muted" : "")}
          empty="No transfers in these dates" emptyIcon="truck" />
      </SectionCard>
      {creating && <TransferDialog onClose={() => setCreating(false)} onSaved={(t) => { setCreating(false); setNotice(`${t.transfer_no} dispatched.`); list.reload(); }} />}
      {openId && <TransferDetail transferId={openId} onClose={() => setOpenId(null)} onChanged={(message) => { setNotice(message); list.reload(); }} />}
    </div>
  );
}

const emptyLine = () => ({ key: newKey(), lotId: "", quantity: "" });

function TransferDialog({ onClose, onSaved }) {
  const biz = useOpenBusiness();
  // Sent from the locations this person works with, to any other open one.
  const locations = biz.locations.filter((l) => l.active);
  const destinations = biz.allLocations.filter((l) => l.active);
  const { options, error } = useOptions(["stock"]);
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState(() => ({ fromLocationId: String(locations[0]?.id || ""),
    toLocationId: String(destinations.find((l) => String(l.id) !== String(locations[0]?.id))?.id || ""), notes: "" }));
  const [lines, setLines] = useState([emptyLine()]);
  const lots = (options?.stock || []).filter((l) => String(l.location_id) === form.fromLocationId && Number(l.quantity) > 0);
  const setLine = (key, name, value) => setLines((all) => all.map((l) => (l.key === key ? { ...l, [name]: value } : l)));
  const lotOf = (line) => lots.find((l) => String(l.id) === line.lotId);
  return (
    <FormDialog title="New stock transfer" icon="truck" width={880} submitLabel="Dispatch" onClose={onClose} onSaved={onSaved} disabled={!options}
      description="The stock leaves the sending location now and is added at the other end when they confirm it arrived."
      onSubmit={() => businessWrite(biz.id, "transfers", { ...form, notes: form.notes || undefined, requestKey, lines: lines.map(({ lotId, quantity: q }) => ({ lotId, quantity: q })) })}>
      <FormError message={error} />
      {!options && !error && <div className="field-wide"><Loading /></div>}
      <Field label="From">
        <select required value={form.fromLocationId} onChange={(e) => { setForm((f) => ({ ...f, fromLocationId: e.target.value })); setLines([emptyLine()]); }}>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </Field>
      <Field label="To">
        <select required value={form.toLocationId} onChange={(e) => setForm((f) => ({ ...f, toLocationId: e.target.value }))}>
          {destinations.filter((l) => String(l.id) !== form.fromLocationId).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </Field>
      <div className="field-wide bz-lines">
        <DataGrid variant="editor" caption="Lines" rows={lines} rowKey={(l) => l.key} columns={[
          { key: "lot", header: "Item and batch", render: (l, ctx) => (
            <select aria-label={ctx.label} required value={l.lotId} onChange={(e) => setLine(l.key, "lotId", e.target.value)}>
              <option value="">Choose…</option>
              {lots.filter((lot) => lot.id === Number(l.lotId) || !lines.some((x) => x.lotId === String(lot.id))).map((lot) => (
                <option key={lot.id} value={lot.id}>{lot.label}{lot.lot_code ? ` · ${lot.lot_code}` : ""} · {quantity(lot.quantity, lot.unit)} here</option>
              ))}
            </select>
          ) },
          { key: "quantity", header: "Quantity", type: "number", value: (l) => Number(l.quantity) || 0, render: (l, ctx) => (
            <input aria-label={ctx.label} required type="number" min="0.001" step="0.001" max={lotOf(l)?.quantity} value={l.quantity} onChange={(e) => setLine(l.key, "quantity", e.target.value)} />
          ) },
          { key: "unit", header: "Unit", value: (l) => lotOf(l)?.unit || "" },
          { key: "remove", header: "", label: "Remove", type: "actions", render: (l) => lines.length > 1 && <button type="button" className="link-button danger" onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}>Remove</button> },
        ]} />
        <div className="bz-lines-foot">
          <button type="button" className="button button-secondary" onClick={() => setLines((all) => [...all, emptyLine()])}><Icon name="plus" size={15} /> Add line</button>
        </div>
      </div>
      <Field label="Notes" wide><input maxLength={500} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="e.g. Sent with Raju, van MH12 AB 1234" /></Field>
    </FormDialog>
  );
}

function TransferDetail({ transferId, onClose, onChanged }) {
  const biz = useOpenBusiness();
  const [transfer, setTransfer] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `transfers/${transferId}`, undefined, controller.signal)
      .then((t) => { setTransfer(t); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, transferId, version]);
  // Staff tied to a location receive what was sent to it and cancel what it sent.
  const worksAt = (locationId) => !biz.member.location_id || String(biz.member.location_id) === String(locationId);
  const receive = async () => {
    setBusy(true);
    try {
      await businessWrite(biz.id, `transfers/${transferId}/receive`, {});
      onChanged(`${transfer.transfer_no} received at ${transfer.to_location_name}.`);
      setVersion((n) => n + 1);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Modal title={transfer ? `Transfer ${transfer.transfer_no}` : "Loading…"} icon="truck" width={820} onClose={() => { if (!cancelling) onClose(); }}
        description={transfer ? `${transfer.from_location_name} → ${transfer.to_location_name} · sent ${dateTime(transfer.created_at)} by ${transfer.created_by_name}` : undefined}>
        <ErrorMessage message={error} />
        {!transfer && !error && <Loading />}
        {transfer && (
          <div className="stack">
            <div className="bz-inline"><Badge status={transfer.status} />
              {transfer.closed_at && <span className="muted small">{transfer.status === "received" ? "Received" : "Cancelled"} {dateTime(transfer.closed_at)} by {transfer.closed_by_name}{transfer.close_reason ? ` — ${transfer.close_reason}` : ""}</span>}
            </div>
            <DataGrid variant="compact" id="business-transfer-lines" caption="Lines" rows={transfer.lines} currency={biz.symbol} columns={[
              { key: "label", header: "Item", mobile: "title" },
              { key: "lot", header: "Batch / serial", value: (l) => l.lot_code || "" },
              { key: "quantity", header: "Quantity", type: "number", value: (l) => Number(l.quantity), render: (l) => quantity(l.quantity, l.unit) },
              { key: "cost", header: "Cost", type: "money", exact: true, value: (l) => Number(l.quantity) * Number(l.unit_cost), total: "sum" },
            ]} />
            {transfer.notes && <p className="muted">{transfer.notes}</p>}
            {transfer.status === "in_transit" && (
              <div className="form-actions bz-start">
                {biz.can("stock_transfers.approve") && worksAt(transfer.to_location_id) && <button type="button" className="button" disabled={busy} onClick={receive}><Icon name="check" size={16} /> Confirm it arrived</button>}
                {biz.can("stock_transfers.cancel") && worksAt(transfer.from_location_id) && <button type="button" className="button button-secondary" disabled={busy} onClick={() => setCancelling(true)}>Cancel transfer</button>}
              </div>
            )}
          </div>
        )}
      </Modal>
      {cancelling && (
        <ReasonDialog title={`Cancel ${transfer.transfer_no}`} submitLabel="Cancel transfer" description="The goods go back into the sending location's stock."
          onClose={() => setCancelling(false)}
          onSubmit={(reason) => businessWrite(biz.id, `transfers/${transferId}/cancel`, { reason })}
          onSaved={() => { setCancelling(false); onChanged(`${transfer.transfer_no} cancelled.`); setVersion((n) => n + 1); }} />
      )}
    </>
  );
}
