import { useMemo, useState } from "react";
import Modal from "../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../components/DataGrid/DataGrid";
import StatTile from "../../../components/StatTile";
import { ErrorMessage } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import { moneyExact, count } from "@bmp/shared/format";
import { addDays, nextApril, onDate, plural } from "../taxChanges";
import "../styles/tax-changes.css";

// The yearly GST change, entered ahead: pick the items (by their GST rate,
// category, HSN / SAC code or a search), the rate they move to and the day,
// see what each one's price and GST will be, and schedule it all as one change
// with its reason. Nothing is saved until the preview has been seen; changing
// anything asks for a new preview.
//
// api: shopChanges(id) or menuChanges(); words: WORDS.shop or WORDS.menu;
// rates: [{ id, name, rate }] the business's active rates; categories:
// [{ id, name }]; pricesInclude: true, false, or "mixed" (a restaurant's dishes
// each have their own); today: the business's own date.
export default function TaxChangeTool({ api, words, rates, categories, pricesInclude, today, currency = "₹", onClose, onScheduled }) {
  const [filters, setFilters] = useState({ taxRateId: "", categoryId: "", hsn: "", q: "", inactive: false });
  const [target, setTarget] = useState("");
  const [startsOn, setStartsOn] = useState(() => nextApril(today));
  const [keepNet, setKeepNet] = useState(false);
  const [preview, setPreview] = useState(null);
  const [chosen, setChosen] = useState(() => new Set());
  const [reason, setReason] = useState("");
  const [requestKey, setRequestKey] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Any change to what is asked throws the preview away: what is scheduled is what was last shown.
  const edit = (apply) => (event) => {
    apply(event.target.type === "checkbox" ? event.target.checked : event.target.value);
    setPreview(null);
    setError("");
  };
  const setFilter = (name) => edit((value) => setFilters((f) => ({ ...f, [name]: value })));
  const movable = (item) => !item.problem && !item.same;

  const runPreview = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api.preview({
        taxRateId: target, startsOn, keeps: keepNet ? "net" : "total",
        filters: { taxRateId: filters.taxRateId || null, categoryId: filters.categoryId || null, hsn: filters.hsn.trim() || null, q: filters.q.trim() || null, inactive: filters.inactive },
      });
      setPreview(result);
      setChosen(new Set(result.items.filter(movable).map((item) => item.id)));
      setRequestKey(crypto.randomUUID());
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const schedule = async () => {
    setBusy(true);
    setError("");
    try {
      const change = await api.schedule({ requestKey, taxRateId: target, startsOn, keeps: keepNet ? "net" : "total", reason: reason.trim(), items: [...chosen] });
      onScheduled(change);
    } catch (err) {
      setError(getErrorMessage(err));
      setBusy(false);
    }
  };

  const toggle = (id) => setChosen((now) => {
    const next = new Set(now);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const items = preview?.items || [];
  const blocked = items.filter((item) => item.problem).length;
  const already = items.filter((item) => !item.problem && item.same).length;
  const targetRate = rates.find((r) => String(r.id) === String(target));
  const ready = preview && !preview.dateProblem && chosen.size > 0 && reason.trim() && !busy;

  const columns = useMemo(() => [
    { key: "move", header: "Move", label: `Move this ${words.item}`, sortable: false, hideable: false, width: 70, value: (i) => (chosen.has(i.id) ? 1 : 0),
      render: (i) => (
        <input type="checkbox" aria-label={`Move ${i.label}`} checked={chosen.has(i.id)} disabled={!movable(i)} onChange={() => toggle(i.id)} />
      ) },
    { key: "item", header: words.Item, value: (i) => i.label, mobile: "title", pin: true,
      render: (i) => <span className="txc-two-line"><strong>{i.label}</strong>{i.code && <small className="muted mono">{i.code}{i.active ? "" : " · switched off"}</small>}</span> },
    { key: "category", header: "Category", value: (i) => i.category || "", mobile: "subtitle" },
    { key: "hsn", header: "HSN / SAC", value: (i) => i.hsn || "", className: "mono", defaultHidden: true },
    { key: "now", header: "Now", value: (i) => `${i.from.name}`, render: (i) => <span className="txc-two-line"><span>{i.from.name}</span><small className="muted">{moneyExact(i.price.before, currency)} · GST {moneyExact(i.gst.before, currency)}</small></span> },
    { key: "then", header: `From ${onDate(startsOn)}`, value: (i) => i.to.name, mobile: "show",
      render: (i) => (i.same ? <span className="muted">No change</span> : (
        <span className="txc-two-line"><strong>{i.to.name}</strong><small className="muted">{moneyExact(i.price.after, currency)} · GST {moneyExact(i.gst.after, currency)}</small></span>
      )) },
    { key: "total", header: "Customer pays", type: "money", exact: true, value: (i) => Number(i.total.after), mobile: "show",
      render: (i) => (i.total.before === i.total.after ? moneyExact(i.total.after, currency)
        : <span className="nowrap">{moneyExact(i.total.before, currency)} → <strong>{moneyExact(i.total.after, currency)}</strong></span>) },
    { key: "note", header: "Note", value: (i) => i.problem || (i.same ? "already" : ""),
      render: (i) => (i.problem ? <span className="text-danger">{i.problem}</span> : i.same ? <span className="muted">At {i.to.name} already then</span> : "") },
  ], [chosen, currency, startsOn, words]);

  return (
    <Modal title="New GST rate change" icon="percent" width={1080} onClose={busy ? () => {} : onClose} dismissible={!busy}
      description={`Move ${words.items} to another ${words.rate} from a day you choose. Bills before that day keep their rates.`}
      footer={<>
        <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="button" onClick={schedule} disabled={!ready}>
          {busy && preview ? "Scheduling…" : `Schedule for ${plural(chosen.size, words.item, words.items)}`}
        </button>
      </>}>
      <div className="stack txc-tool">
        <ErrorMessage message={error} />
        <div className="txc-grid">
          <fieldset className="field txc-panel">
            <legend>1 · Which {words.items}</legend>
            <label className="field">
              <span>Now at</span>
              <select value={filters.taxRateId} onChange={setFilter("taxRateId")}>
                <option value="">Any {words.rate}</option>
                {rates.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Category</span>
              <select value={filters.categoryId} onChange={setFilter("categoryId")}>
                <option value="">Any category</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="field">
              <span>HSN / SAC code begins</span>
              <input inputMode="numeric" maxLength={8} value={filters.hsn} onChange={setFilter("hsn")} placeholder="e.g. 1905" className="mono" />
            </label>
            <label className="field">
              <span>Name or code</span>
              <input maxLength={100} value={filters.q} onChange={setFilter("q")} placeholder={`Search ${words.items}`} />
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={filters.inactive} onChange={setFilter("inactive")} />
              <span>Switched-off {words.items} too</span>
            </label>
          </fieldset>

          <fieldset className="field txc-panel">
            <legend>2 · The change</legend>
            <label className="field">
              <span>Moves to</span>
              <select required value={target} onChange={edit(setTarget)}>
                <option value="">Choose the new {words.rate}</option>
                {rates.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
            <label className="field">
              <span>From</span>
              <input type="date" required min={addDays(today, 1)} value={startsOn} onChange={edit(setStartsOn)} />
              <small className="muted">The first day of the new rate, on your own date. GST rates change on 1 April each year.</small>
            </label>
            {pricesInclude === false ? (
              <p className="muted small txc-note">Your prices are before GST: they stay as they are, and the GST added on them changes.</p>
            ) : (
              <label className="checkbox">
                <input type="checkbox" checked={keepNet} onChange={edit(setKeepNet)} />
                <span>
                  Keep the price before GST instead
                  <small className="muted txc-block">
                    {keepNet
                      ? `Each price that includes GST changes with the rate, so its part before GST stays the same${pricesInclude === "mixed" ? " (a price before GST stays as it is)" : ""}.`
                      : `A price that includes GST keeps its total; the GST inside it is worked out again${pricesInclude === "mixed" ? " (a price before GST stays, and its GST changes)" : ""}.`}
                  </small>
                </span>
              </label>
            )}
            <div className="txc-go">
              <button type="button" className="button button-secondary" onClick={runPreview} disabled={!target || !startsOn || busy}>
                <Icon name="eye" size={16} /> {busy && !preview ? "Working…" : preview ? "Preview again" : "Preview"}
              </button>
            </div>
          </fieldset>
        </div>

        {preview && (
          <>
            {preview.dateProblem && <div className="alert">{preview.dateProblem}</div>}
            <div className="stat-grid txc-stats">
              <StatTile size="sm" icon="check" tone="primary" label={`${words.Items} to move`} value={count(chosen.size)} />
              <StatTile size="sm" icon="info" tone="neutral" label={`At ${targetRate?.name || "it"} already`} value={count(already)} />
              <StatTile size="sm" icon="alert" tone={blocked ? "danger" : "neutral"} label="Cannot move" value={count(blocked)} />
            </div>
            {preview.more && <p className="muted small">Only the first {count(items.length)} {words.items} are shown: narrow the search to see the rest.</p>}
            <div className="txc-pick">
              <button type="button" className="chip-button" onClick={() => setChosen(new Set(items.filter(movable).map((i) => i.id)))}>All that can move</button>
              <button type="button" className="chip-button" onClick={() => setChosen(new Set())}>None</button>
            </div>
            <DataGrid id="tax-change-preview" variant="compact" caption={`What each ${words.item} becomes`} rows={items} rowKey={(i) => i.id}
              rowNoun={[words.item, words.items]} currency={currency} columns={columns}
              rowClassName={(i) => (i.problem ? "dg-tone-danger" : i.same ? "dg-tone-muted" : "")}
              empty={`No ${words.items} match`} emptyIcon="search" />
            <label className="field field-wide">
              <span>Reason</span>
              <input required maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. GST Council notification of 15 March 2027" />
              <small className="muted">Kept with the change for good, with your name.</small>
            </label>
          </>
        )}
      </div>
    </Modal>
  );
}
