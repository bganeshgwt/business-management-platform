import { useMemo, useState } from "react";
import Icon from "@bmp/ui/Icon";
import { dateShort } from "@bmp/shared/format";
import Modal from "../../components/Modal";
import { ErrorMessage } from "../../components/Feedback";
import { toast } from "../../services/toast";
import { useSales } from "./salesContext";
import { cashCheck, chequeProblem, oldestFirst, utrProblem } from "./salesRules";
import { money } from "./salesFormat";

// Collecting at a shop: cash, UPI (with the 12-digit UTR from the payer's
// app) or a cheque (its number, date — post-dated allowed — and bank).
// Settled against the oldest bills first unless the salesperson chooses
// them; what is more than the bills stays as the shop's advance. Cash of
// ₹2,00,000 or more from one shop in a day is stopped here (the server and
// the database refuse it too).
const METHODS = [
  { value: "cash", label: "Cash", icon: "cash" },
  { value: "upi", label: "UPI", icon: "zap" },
  { value: "cheque", label: "Cheque", icon: "file" },
];
// The banks a cheque is most often drawn on, to pick from (any other may be typed).
const BANKS = ["State Bank of India", "HDFC Bank", "ICICI Bank", "Axis Bank", "Kotak Mahindra Bank", "Bank of Baroda", "Punjab National Bank", "Canara Bank",
  "Union Bank of India", "Bank of India", "Indian Bank", "Central Bank of India", "IDBI Bank", "IndusInd Bank", "Yes Bank", "Federal Bank", "IDFC First Bank"];
const paise = (value) => Math.round(Number(value || 0) * 100);

export default function CollectDialog({ shop, visit, depotId, onDone, onClose }) {
  const sales = useSales();
  const since = sales.sinceFor(shop);
  const owes = Math.max(0, paise(shop.balance) - since.collected);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [utr, setUtr] = useState("");
  const [cheque, setCheque] = useState({ number: "", date: sales.today, bank: "" });
  const [choosing, setChoosing] = useState(false);
  const [chosen, setChosen] = useState({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const amountPaise = paise(amount);
  const bills = useMemo(() => shop.open_bills || [], [shop.open_bills]);
  const plan = useMemo(() => oldestFirst(bills, amountPaise), [bills, amountPaise]);
  const chosenTotal = Object.values(chosen).reduce((s, v) => s + paise(v), 0);

  const issue = (() => {
    if (!(amountPaise > 0)) return "Enter the amount collected";
    if (method === "upi") return utrProblem(utr);
    if (method === "cheque") return chequeProblem(cheque, sales.today);
    if (method === "cash") {
      const check = cashCheck(shop, amountPaise, since, sales.packIsToday);
      if (!check.ok) return check.message;
    }
    if (choosing && chosenTotal > amountPaise) return "The bills chosen add up to more than the amount collected";
    return null;
  })();

  const save = async () => {
    setBusy(true);
    setProblem("");
    try {
      const allocations = choosing ? Object.entries(chosen).filter(([, v]) => paise(v) > 0).map(([documentId, v]) => ({ documentId: Number(documentId), amount: (paise(v) / 100).toFixed(2) })) : undefined;
      const entry = await sales.actions.collect(shop, visit, {
        amount: (amountPaise / 100).toFixed(2), method, depotId, allocations,
        reference: method === "upi" ? utr.replace(/\s/g, "") : method === "cheque" ? cheque.number.replace(/\s/g, "") : null,
        chequeDate: method === "cheque" ? cheque.date : undefined, bank: method === "cheque" ? cheque.bank.trim() : undefined,
      });
      toast.success(`${money(amountPaise / 100)} collected${sales.online ? "" : ": it goes to the office when the connection is back"}`);
      onDone({ key: entry.id, entry, at: entry.at });
    } catch (err) {
      setProblem(err?.message || "The collection could not be kept on this phone.");
      setBusy(false);
    }
  };

  return (
    <Modal title={`Collect from ${shop.name}`} icon="wallet" onClose={onClose} width={520} className="sl-sheet"
      footer={<button type="button" className="button sl-wide" onClick={save} disabled={busy || Boolean(issue)}><Icon name="check" size={16} /> {busy ? "Saving…" : amountPaise > 0 ? `Collect ${money(amountPaise / 100)}` : "Collect"}</button>}>
      <label className="field sl-amount">
        <span>Amount ₹</span>
        <input type="number" inputMode="decimal" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} autoComplete="off" />
      </label>
      {owes > 0 && (
        <div className="sl-quick">
          {Number(shop.overdue) > 0 && paise(shop.overdue) < owes && <button type="button" className="sl-reason" onClick={() => setAmount((paise(shop.overdue) / 100).toFixed(2))}>Overdue {money(shop.overdue)}</button>}
          <button type="button" className="sl-reason" onClick={() => setAmount((owes / 100).toFixed(2))}>All dues {money(owes / 100)}</button>
        </div>
      )}
      <div className="segmented sl-segmented" role="radiogroup" aria-label="Paid by">
        {METHODS.map((m) => (
          <button key={m.value} type="button" role="radio" aria-checked={method === m.value} className={`segment ${method === m.value ? "is-active" : ""}`} onClick={() => setMethod(m.value)}>
            <Icon name={m.icon} size={15} /> {m.label}
          </button>
        ))}
      </div>
      {method === "upi" && (
        <label className="field">
          <span>UPI reference (UTR), 12 digits</span>
          <input inputMode="numeric" maxLength={16} value={utr} onChange={(e) => setUtr(e.target.value)} placeholder="From the payer's UPI app" autoComplete="off" />
          <small className="muted">Check the money has arrived in the business&apos;s UPI before you leave.</small>
        </label>
      )}
      {method === "cheque" && (
        <div className="sl-two">
          <label className="field">
            <span>Cheque number</span>
            <input inputMode="numeric" maxLength={6} value={cheque.number} onChange={(e) => setCheque((c) => ({ ...c, number: e.target.value }))} autoComplete="off" />
          </label>
          <label className="field">
            <span>Date on the cheque</span>
            <input type="date" value={cheque.date} onChange={(e) => setCheque((c) => ({ ...c, date: e.target.value }))} />
          </label>
          <label className="field field-wide">
            <span>Bank</span>
            <input list="sl-banks" maxLength={100} value={cheque.bank} onChange={(e) => setCheque((c) => ({ ...c, bank: e.target.value }))} autoComplete="off" />
            <datalist id="sl-banks">{BANKS.map((b) => <option key={b} value={b} />)}</datalist>
            {cheque.date > sales.today && <small className="muted">Post-dated: it counts once it clears.</small>}
          </label>
        </div>
      )}
      {bills.length > 0 && amountPaise > 0 && (
        <div className="sl-settles">
          <div className="sl-settles-head">
            <strong>{choosing ? "Against the bills chosen" : "Settles the oldest bills first"}</strong>
            <button type="button" className="link-button" onClick={() => { setChoosing(!choosing); setChosen({}); }}>{choosing ? "Oldest first" : "Choose bills"}</button>
          </div>
          {choosing ? (
            <ul className="sl-bills">
              {bills.map((bill) => (
                <li key={bill.document_id}>
                  <label>
                    <span>{bill.document_no} · {dateShort(bill.bill_date)}<small className="muted"> due {money(bill.outstanding)}</small></span>
                    <input type="number" inputMode="decimal" min="0" step="0.01" max={bill.outstanding} value={chosen[bill.document_id] ?? ""} aria-label={`Amount for ${bill.document_no}`}
                      onChange={(e) => setChosen((c) => ({ ...c, [bill.document_id]: e.target.value }))} />
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="sl-bills">
              {plan.settles.map((bill) => <li key={bill.document_id}><span>{bill.document_no}{bill.clears ? " (cleared)" : ""}</span><span>{money(bill.amount / 100)}</span></li>)}
              {plan.advance > 0 && <li><span>Kept as an advance</span><span>{money(plan.advance / 100)}</span></li>}
            </ul>
          )}
        </div>
      )}
      {issue && amountPaise > 0 && <p className="sl-issue" role="status">{issue}</p>}
      <ErrorMessage message={problem} />
    </Modal>
  );
}
