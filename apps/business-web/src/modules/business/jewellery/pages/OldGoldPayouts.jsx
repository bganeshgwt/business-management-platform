import { useEffect, useMemo, useState } from "react";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "@bmp/shared/format";
import FormDialog from "../../core/pages/FormDialog";
import { Field } from "../../core/pages/ui";
import { newKey } from "../../core/pages/hooks";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import { grams, usesJewellery } from "./jewellery";
import "../styles/jewellery.css";

// Several of one seller's old gold vouchers paid out together, from the
// voucher, the customer's row in Customers, or the day's money: each its own
// payout and expense, each checked by the cash limits as it is paid (a seller
// does not receive ₹2,00,000 or more in cash for old gold in a day or for one
// voucher; the shop may set a lower limit). All or none: a voucher the cash
// limit refuses stops them all, and nothing is paid.

const PAYOUT_KINDS = ["upi", "bank", "cash"];

// seller: { id, name }
export function OldGoldPayoutsDialog({ biz, seller, onClose, onSaved }) {
  const methods = usePaymentMethods();
  const [requestKey] = useState(newKey);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [method, setMethod] = useState("upi");
  const [reference, setReference] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/old-gold", { state: "open", contact: seller.id, limit: 50 }, controller.signal)
      .then((page) => setRows(page.items.map((g) => ({ ...g, chosen: true, pay: Number(g.balance).toFixed(2) }))))
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, seller.id]);
  const chosen = useMemo(() => (rows || []).filter((g) => g.chosen && Number(g.pay) > 0), [rows]);
  const total = chosen.reduce((s, g) => s + Math.round(Number(g.pay) * 100), 0) / 100;
  const set = (id, change) => setRows((all) => all.map((g) => (g.id === id ? { ...g, ...change } : g)));
  return (
    <FormDialog title={`Pay out ${seller.name}'s old gold`} icon="wallet" width={760} onClose={onClose} onSaved={onSaved} submitLabel={chosen.length ? `Pay out ${biz.exact(total)}` : "Pay out"}
      disabled={!chosen.length} successMessage={(r) => `Paid ${biz.exact(r.paid)} to ${r.seller.name}.`}
      description="Each voucher is paid on its own and written in the expense book. In cash, each is checked against the limits as it is paid: if one would go past them, none is paid."
      onSubmit={() => businessWrite(biz.id, "jewellery/old-gold/payouts", { requestKey, contactId: seller.id, vouchers: chosen.map((g) => ({ id: g.id, amount: g.pay })),
        ...methods.body(method, PAYOUT_KINDS), reference: reference.trim() || undefined })}>
      <ErrorMessage message={error} />
      {!rows ? !error && <Loading /> : rows.length === 0 ? <p className="field-wide jw-note">{seller.name} has no old gold with value left.</p> : (
        <table className="field-wide jw-rates">
          <thead><tr><th scope="col">Pay</th><th scope="col">Voucher</th><th scope="col">Taken in</th><th scope="col">Net</th><th scope="col">Left</th><th scope="col">Paid now</th></tr></thead>
          <tbody>{rows.map((g) => (
            <tr key={g.id}>
              <td><input type="checkbox" aria-label={`Pay ${g.voucher_no}`} checked={g.chosen} onChange={(e) => set(g.id, { chosen: e.target.checked })} /></td>
              <th scope="row" className="mono">{g.voucher_no}</th>
              <td>{dateShort(g.created_at, { year: true })}</td>
              <td>{grams(g.net_weight)}</td>
              <td>{biz.exact(g.balance)}</td>
              <td><input type="number" min="0.01" max={g.balance} step="0.01" aria-label={`${g.voucher_no}: paid now`} disabled={!g.chosen} value={g.pay} onChange={(e) => set(g.id, { pay: e.target.value })} /></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <Field label="Paid by">
        <select value={methods.resolve(method, PAYOUT_KINDS)} onChange={(e) => setMethod(e.target.value)}>
          {methods.options(PAYOUT_KINDS).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
        </select>
      </Field>
      <Field label="Reference (optional)" hint="The UPI or bank transfer's reference."><input maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
    </FormDialog>
  );
}

// The day's money: old gold with value left to pay out, seller by seller.
export function OldGoldToPay({ biz, onPaid }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState("");
  const [paying, setPaying] = useState(null);
  const [version, setVersion] = useState(0);
  const shown = usesJewellery(biz) && biz.can("jewellery.approve") && biz.can("sales.view");
  useEffect(() => {
    if (!shown) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/old-gold", { state: "open", limit: 100 }, controller.signal).then((page) => { setList(page.items); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, shown, version]);
  const sellers = useMemo(() => {
    const map = new Map();
    for (const g of list || []) {
      const s = map.get(g.contact_id) || { id: g.contact_id, name: g.seller_name, phone: g.seller_phone, vouchers: 0, left: 0 };
      s.vouchers += 1;
      s.left += Number(g.balance);
      map.set(g.contact_id, s);
    }
    return [...map.values()];
  }, [list]);
  if (!shown || (list && !sellers.length)) return null;
  return (
    <SectionCard icon="scale" title="Old gold to pay out" description="Sellers with old gold value left: pay several of a seller's vouchers at once, each within the cash limits.">
      <ErrorMessage message={error} />
      {!list ? !error && <Loading /> : (
        <table className="jw-rates">
          <thead><tr><th scope="col">Seller</th><th scope="col">Vouchers</th><th scope="col">Left</th><th scope="col">Action</th></tr></thead>
          <tbody>{sellers.map((s) => (
            <tr key={s.id}>
              <th scope="row">{s.name}{s.phone && <small className="muted"> · {s.phone}</small>}</th>
              <td>{s.vouchers}</td>
              <td>{biz.exact(s.left)}</td>
              <td><button type="button" className="button button-secondary button-sm" onClick={() => setPaying(s)}><Icon name="wallet" size={14} /> Pay out</button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {paying && <OldGoldPayoutsDialog biz={biz} seller={paying} onClose={() => setPaying(null)} onSaved={() => { setPaying(null); setVersion((n) => n + 1); onPaid?.(); }} />}
    </SectionCard>
  );
}
