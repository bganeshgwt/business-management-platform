import { useEffect, useState } from "react";
import Icon from "@bmp/ui/Icon";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "../../core/pages/FormDialog";
import FitterField from "./FitterField";
import { tradeWord, usesFitters } from "./hardware";
import { ESTIMATE_NOTE, workingLine } from "./workings";

// What a hardware shop's bill, quotation or sales order shows beside its
// lines: the shade each tinted line is tinted to, the calculators' workings
// it was made with, and its fitter (named afterwards on a bill until the
// commission on it is paid; named on a sales order for its invoices).

const STATUS_WORDS = { queued: "waiting to be tinted", tinted: "tinted", handed_over: "handed over", taken_back: "taken back" };

// tints: [{ line_id, maker, code, name, base, status? }]; lines: the bill's or quotation's lines (id, label).
export function TintedLines({ tints, lines }) {
  if (!tints?.length) return null;
  return (
    <ul className="bz-history hw-tints" aria-label="Tinted lines">
      {tints.map((t) => {
        const line = lines?.find((l) => String(l.id) === String(t.line_id));
        return (
          <li key={t.line_id}>
            <Icon name="sparkles" size={13} /> {line ? <strong>{line.label}</strong> : "A line"} tinted to {t.maker} {t.code} {t.name} ({t.base} base)
            {t.status ? ` · ${STATUS_WORDS[t.status] || t.status}` : ""}
          </li>
        );
      })}
    </ul>
  );
}

// workings: [{ id, kind, revision?, working: { inputs, assumptions, result } }].
export function Workings({ workings, title = "How the quantities were worked out" }) {
  if (!workings?.length) return null;
  return (
    <div className="hw-workings">
      <p className="small"><strong>{title}</strong> <span className="muted">{ESTIMATE_NOTE}</span></p>
      <ul className="bz-history">
        {workings.map((w) => <li key={w.id}>{workingLine(w.kind, w.working)}{w.revision ? <span className="muted"> · revision {w.revision}</span> : null}</li>)}
      </ul>
    </div>
  );
}

// "Name the fitter" (or "Change the fitter") on a posted sale, for someone
// who may name a fitter afterwards: someone who manages the commission.
export function FitterButton({ biz, doc, onClick }) {
  if (doc.kind !== "sale" || biz.type !== "hardware" || !biz.has("fitter_commission") || !biz.can("fitter_commission.edit")) return null;
  return <button type="button" className="button button-secondary" onClick={onClick}><Icon name="users" size={15} /> {doc.hardware?.fitter ? "Change the fitter" : "Name the fitter"}</button>;
}

// Naming (or changing) the fitter of a posted bill.
export function FitterDialog({ biz, doc, onClose, onSaved }) {
  const current = doc.hardware?.fitter;
  const [fitterId, setFitterId] = useState(current?.id ? String(current.id) : "");
  return (
    <FormDialog title={`Fitter of ${doc.document_no}`} icon="users" width={520} submitLabel="Save" onClose={onClose} onSaved={onSaved}
      description={current ? `Fitted by ${current.name} (${tradeWord(current.trade).toLowerCase()}). The fitter changes until the commission on this bill is paid; payouts settle a fitter's oldest commission first.`
        : "The bill's lines earn the commission by the rules in force now; goods already returned take back their share."}
      onSubmit={async () => {
        if (!fitterId) throw new Error("Choose the fitter");
        try {
          return await businessWrite(biz.id, `hardware/bills/${doc.id}/fitter`, { fitterId }, "put");
        } catch (err) {
          throw new Error(getErrorMessage(err));
        }
      }}>
      <FitterField biz={biz} value={fitterId} onChange={setFitterId} label="Fitted by" wide />
    </FormDialog>
  );
}

// A sales order's fitter, on the order: shown, and named or changed while it
// is still to send. Every invoice its dispatches raise earns them their commission.
export function OrderFitter({ biz, order, onChanged }) {
  const on = biz.type === "hardware" && biz.has("fitter_commission") && biz.can("fitter_commission.view");
  const [fitter, setFitter] = useState(undefined);
  const [editing, setEditing] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!on) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, `hardware/orders/${order.id}/fitter`, undefined, controller.signal)
      .then((r) => setFitter(r.fitter))
      .catch(() => { if (!controller.signal.aborted) setFitter(null); });
    return () => controller.abort();
  }, [biz.id, order.id, version, on]);
  if (!on || fitter === undefined) return null;
  const live = ["open", "part_dispatched"].includes(order.status);
  return (
    <>
      {fitter && <span className="bz-chip"><Icon name="users" size={13} /> Fitter {fitter.name}</span>}
      {live && usesFitters(biz) && <button type="button" className="chip-button" onClick={() => setEditing(true)}>{fitter ? "Change the fitter" : "Name the fitter"}</button>}
      {editing && <OrderFitterDialog biz={biz} order={order} current={fitter} onClose={() => setEditing(false)}
        onSaved={() => { setEditing(false); setVersion((v) => v + 1); onChanged?.(); }} />}
    </>
  );
}

function OrderFitterDialog({ biz, order, current, onClose, onSaved }) {
  const [fitterId, setFitterId] = useState(current?.id ? String(current.id) : "");
  return (
    <FormDialog title={`Fitter of ${order.order_no}`} icon="users" width={520} submitLabel="Save" onClose={onClose} onSaved={onSaved}
      description="Each invoice this order's dispatches raise earns the fitter their commission. Choosing no fitter takes them off the invoices still to come."
      onSubmit={async () => {
        try {
          return await businessWrite(biz.id, `hardware/orders/${order.id}/fitter`, { fitterId: fitterId || null }, "put");
        } catch (err) {
          throw new Error(getErrorMessage(err));
        }
      }}>
      <FitterField biz={biz} value={fitterId} onChange={setFitterId} label="Fitted by" wide />
    </FormDialog>
  );
}
