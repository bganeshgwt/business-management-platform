import { useState } from "react";
import { Link } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import SidePanel from "../../../components/SidePanel";
import StatusBadge from "../../../components/StatusBadge";
import { ErrorMessage } from "../../../components/Feedback";
import { Field } from "../core/pages/ui";
import { businessPath } from "../../../services/businessNav";
import { outbox } from "../../../services/offline/outboxStore";
import { snapshotAge } from "../../../services/offline/snapshots";
import { getErrorMessage } from "../../../services/api";
import { printReceipt } from "../retail/pages/retail";
import { OFFLINE_TILL } from "../../../services/businessTypes";
import { voidable } from "./tillQueue.js";
import { VoidDialog } from "./TillCounter";
import "./till.css";

// The till panel, from Quick bill's header: this computer as an offline till.
// Set up here by a manager (its name and code, for this counter's location);
// then its state (online, or offline since when, and the limits), the
// snapshot it bills from and its age, its bills waiting to send (each to see,
// reprint or void), Send now, the last time it reached the server, a copy of
// the waiting bills to keep on the computer, and installing the counter as an
// app. A till retired from Settings › Tills says so here and bills online only.
// A shop that can have the Offline till but has not switched it on finds the
// button where it would be, and the panel says how to switch it on.
const timeOf = (at) => (at ? new Date(at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "never");

export function TillButton({ biz, till, onOpen }) {
  const on = biz.has("offline_till");
  if (till.loading || (!on && !OFFLINE_TILL.includes(biz.type))) return null;
  const count = till.waiting + till.attention;
  const record = on ? till.till : null;
  const label = !record ? "Offline billing" : till.online ? `Till ${record.code}` : `Offline · ${record.code}`;
  return (
    <button type="button" className={`button button-secondary till-button ${record && !till.online ? "is-offline" : ""}`} onClick={onOpen}
      title={record ? `${record.name}: ${count ? `${count} ${count === 1 ? "bill" : "bills"} waiting to send` : "nothing waiting"}` : "Bill when the internet drops"}>
      <span className={`till-dot ${record ? (till.online ? "is-on" : "is-off") : ""}`} aria-hidden="true" />
      {label}{count > 0 && <span className="till-count">{count}</span>}
    </button>
  );
}

export default function TillPanel({ biz, till, open, onClose, locationId, install }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [voiding, setVoiding] = useState(null);
  const [name, setName] = useState("");
  const location = biz.locations.find((l) => String(l.id) === String(locationId));
  const canManage = biz.can("offline_till.manage");
  const on = biz.has("offline_till");
  const record = till.till;

  async function register(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await till.register({ name: name.trim(), locationId });
      await till.refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function act(work) {
    setBusy(true);
    setError("");
    try { await work(); } catch (err) { setError(err.message || getErrorMessage(err)); } finally { setBusy(false); }
  }

  const footer = record && (
    <span className="till-panel-actions">
      <button type="button" className="button" disabled={!till.online || busy || !till.items.length} onClick={() => act(() => till.sendNow())}><Icon name="refresh" size={15} /> Send now</button>
      <button type="button" className="button button-secondary" disabled={!till.items.length} onClick={till.download}><Icon name="download" size={15} /> Download a copy of the waiting bills</button>
    </span>
  );

  return (
    <SidePanel open={open} onClose={onClose} icon="pos" title={record ? `Till ${record.code} · ${record.name}` : "Offline billing on this computer"}
      count={record ? till.items.length || undefined : undefined}
      rule={record ? `Bills here when the internet drops, numbered ${record.code}/…; they go to the server by themselves when it is back.` : "Quick bill keeps billing when the internet drops."}
      footer={footer}>
      <div className="stack till-panel">
        <ErrorMessage message={error} />
        {(!record || !on) && <Setup biz={biz} canManage={canManage} location={location} name={name} setName={setName} busy={busy} onSubmit={register} />}
        {record && till.problem?.reason === "till_retired" && (
          <div className="alert alert-notice" role="status">
            <strong>This till was retired.</strong> {till.problem.message} Quick bill works online here as usual.
            {!till.items.length && <div className="form-actions bz-start"><button type="button" className="button button-secondary button-sm" onClick={() => act(till.forget)}>Forget this till on this computer</button></div>}
          </div>
        )}
        {record && till.problem?.reason === "plan_ended" && (
          <div className="alert alert-notice" role="status"><strong>The business's plan has ended.</strong> Bills made here wait on this computer, kept safe, and go as soon as the owner renews it in Your plan.</div>
        )}
        {record && (
          <>
            <dl className="till-facts">
              <div><dt>Now</dt><dd><StatusBadge tone={till.online ? "success" : "warning"} label={till.online ? "Online" : `Offline since ${timeOf(record.lastContactAt)}`} /></dd></div>
              <div><dt>Counter</dt><dd>{record.locationName || location?.name || "—"}</dd></div>
              <div><dt>Items and prices</dt><dd>{till.snapshot ? `As of ${timeOf(till.snapshot.savedAt)} (${snapshotAge(till.snapshot.savedAt)})` : "Not read yet"}
                {till.online && <button type="button" className="link-button" disabled={till.syncing} onClick={() => act(till.refresh)}>{till.syncing ? "Reading…" : "Read again"}</button>}</dd></div>
              <div><dt>Last reached the server</dt><dd>{timeOf(record.lastContactAt)}</dd></div>
              <div><dt>Limits</dt><dd>Warns after {till.settings.warnHours ?? 12} hours offline, stops after {till.settings.stopHours ?? 72}; at most {(till.settings.waitingCap ?? 2000).toLocaleString("en-IN")} bills waiting.</dd></div>
            </dl>
            {till.limit.state !== "ok" && <p className={`till-limit is-${till.limit.state}`} role="status"><Icon name="alert" size={15} /> {till.limit.words}</p>}
            <section className="stack" aria-label="Bills waiting to send">
              <h3 className="till-panel-heading">Waiting to send</h3>
              {till.items.length === 0 ? <p className="outbox-empty">Nothing waits on this till.</p> : (
                <ul className="outbox-list">
                  {till.items.map((item) => {
                    const canVoid = voidable(item).ok;
                    return (
                      <li key={item.id} className="outbox-item" data-state={item.state}>
                        <div className="outbox-item-head">
                          <span className="outbox-item-label">{item.label}</span>
                          <StatusBadge tone={item.state === "attention" ? "danger" : item.state === "sending" ? "info" : "warning"}
                            label={item.kind === "till_void" ? "Void to send" : item.state === "attention" ? "Needs attention" : item.state === "sending" ? "Sending" : "Waiting"} />
                        </div>
                        <span className="outbox-item-meta">Made {timeOf(item.meta?.madeAt)}{item.meta?.madeByName ? ` by ${item.meta.madeByName}` : ""}{item.meta?.customer ? ` · ${item.meta.customer.name}` : ""}{item.meta?.voided ? ` · voided: ${item.meta.voided}` : ""}</span>
                        {item.lastError && <span className="outbox-item-why">{item.lastError}</span>}
                        <span className="outbox-item-actions">
                          {item.meta?.receipt && item.kind === "till_bill" && biz.can("sales.print") && <button type="button" className="chip-button" onClick={() => printReceipt(item.meta.receipt, biz)}><Icon name="print" size={13} /> Reprint</button>}
                          {item.state === "attention" && <button type="button" className="chip-button" disabled={!till.online} onClick={() => outbox.retry(item.id)}>Send again</button>}
                          {canVoid && <button type="button" className="chip-button" onClick={() => setVoiding(item)}>Void…</button>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
            <p className="small muted">Keep this computer on this browser: clearing its data loses what waits. The browser is asked to keep it; download a copy now and then while offline for a long time.</p>
            {biz.can("offline_till.view") && <Link className="link-button" to={businessPath(biz.id, "tills")}>All tills of this business <Icon name="arrow-right" size={13} /></Link>}
          </>
        )}
        {on && install?.item && (
          <div className="till-install">
            <button type="button" className="button button-secondary" onClick={install.item.onClick}><Icon name="download" size={15} /> {install.item.label}</button>
            <small className="muted">The counter as an app of its own on this computer: it opens straight to Quick bill, even with no internet.</small>
          </div>
        )}
      </div>
      {voiding && <VoidDialog till={till} bill={voiding} onClose={() => setVoiding(null)} onVoided={() => setVoiding(null)} />}
    </SidePanel>
  );
}

function Setup({ biz, canManage, location, name, setName, busy, onSubmit }) {
  if (!biz.has("offline_till")) {
    const owner = Boolean(biz.context?.role?.full_access);
    return (
      <div className="till-setup">
        <Icon name="lock" size={22} />
        <div><strong>Offline till is not switched on for this business</strong>
          <p className="small muted">With it, Quick bill keeps billing when the internet drops, and sends the bills when it is back. {owner ? "Switch it on in Settings › Business tools; where the plan does not have it, add it in Your plan first." : "Ask the owner to switch it on."}</p>
          {owner && (
            <span className="till-setup-links">
              <Link className="button button-secondary button-sm" to={businessPath(biz.id, "settings")}>Business tools</Link>
              <Link className="button button-secondary button-sm" to={businessPath(biz.id, "plan")}>Your plan</Link>
            </span>
          )}</div>
      </div>
    );
  }
  if (!canManage) {
    return (
      <div className="till-setup">
        <Icon name="info" size={22} />
        <div><strong>This computer does not bill offline yet</strong><p className="small muted">A manager sets it up here, on this computer, while it is online.</p></div>
      </div>
    );
  }
  return (
    <form className="stack till-setup-form" onSubmit={onSubmit}>
      <p>Set up this computer as an offline till of <strong>{location?.name || "this counter"}</strong>. It gets a code of its own (T1, T2 …): the bills it makes offline are numbered in its own series, like <span className="mono">T1/2627/00001</span>, as GST rules allow.</p>
      <Field label="Name of this till" hint="What the staff call it: Counter 1, Billing desk…"><input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Counter 1" /></Field>
      <ul className="till-setup-points small">
        <li>It keeps the items, prices and customers it needs, and reads them again every few minutes.</li>
        <li>Offline it takes cash, UPI, card, split and udhaar within each customer's limit; offers, returns and new customers wait for the network.</li>
        <li>Its secret stays on this computer only. Retire it from Settings › Tills if the computer is replaced or lost.</li>
      </ul>
      <div className="form-actions bz-start"><button type="submit" className="button" disabled={busy || !name.trim()}><Icon name="check" size={15} /> Set up offline billing on this computer</button></div>
    </form>
  );
}
