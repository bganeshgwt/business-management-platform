import { useEffect, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field, PeriodFilter } from "../../core/pages/ui";
import { newKey, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import "../styles/business-retail.css";

// Loyalty points: customers earn whole points on each bill and spend them
// at the counter. Points earned on a bill shrink if goods from it come back.
// Corrections need a reason and can never take a customer below zero. A
// return takes back the points its bill earned; points already spent are
// kept back (at their value) from the refund instead.

const KIND = { earn: ["active", "Earned"], redeem: ["warning", "Redeemed"], adjust: ["info", "Correction"], reverse: ["inactive", "Taken back (return)"] };

export default function LoyaltyPage() {
  const biz = useOpenBusiness();
  const [rules, setRules] = useState(null);
  const [rulesError, setRulesError] = useState("");
  const [editingRules, setEditingRules] = useState(false);
  const [adjusting, setAdjusting] = useState(null);
  const [notice, setNotice] = useState("");
  const [version, setVersion] = useState(0);
  const members = useServerList("loyalty/members", { gridId: "retail-loyalty-members" });
  const entries = useServerList("loyalty/entries", { gridId: "retail-loyalty-entries", period: true });

  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "loyalty/rules", undefined, controller.signal)
      .then((r) => { setRules(r); setRulesError(""); })
      .catch((err) => { if (!controller.signal.aborted) setRulesError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);

  const refresh = (message) => { setNotice(message); members.reload(); entries.reload(); setVersion((n) => n + 1); };
  const outstanding = (members.data?.items || []).reduce((s, m) => s + Number(m.balance), 0);

  return (
    <div className="stack">
      <BusinessHeader icon="star" title="Loyalty points"
        description="Customers earn points on every bill and redeem them at the counter. The rules below decide how many, and how much a point is worth." />
      <SuccessMessage message={notice} />
      <ErrorMessage message={rulesError} />
      <SectionCard icon="sliders" title="Rules" tone={rules?.active ? "success" : "warning"}
        actions={biz.can("loyalty.edit") && rules && <button type="button" className="button button-secondary button-sm" onClick={() => setEditingRules(true)}><Icon name="edit" size={14} /> Change rules</button>}>
        {!rules && !rulesError && <Loading />}
        {rules && (
          <div className="rt-rules">
            <p className="rt-rule-line"><strong>{rules.active ? "Points are on" : "Points are off"}</strong><span className="rt-sub">{rules.active ? "Bills with a customer earn points" : rules.saved ? "No points are earned or redeemed" : "Set the rules to start"}</span></p>
            <p className="rt-rule-line"><strong>{rules.earn_points} {Number(rules.earn_points) === 1 ? "point" : "points"} per {biz.amount(rules.earn_per_amount)}</strong><span className="rt-sub">earned on the bill total</span></p>
            <p className="rt-rule-line"><strong>1 point = {biz.exact(rules.point_value)}</strong><span className="rt-sub">off the bill when redeemed</span></p>
            <p className="rt-rule-line"><strong>From {rules.min_redeem_points} points</strong><span className="rt-sub">up to {Number(rules.max_redeem_percent)}% of a bill</span></p>
            <p className="rt-rule-line"><strong>{rules.return_spent_points === false ? "Spent points stay spent" : "Spent points come back"}</strong><span className="rt-sub">{rules.return_spent_points === false ? "when goods on a bill are returned" : "in proportion, when goods on a bill are returned"}</span></p>
          </div>
        )}
      </SectionCard>
      <div className="stat-grid">
        <StatTile icon="users" tone="primary" label="Customers with points" value={members.data ? String(members.data.total) : "—"} />
        <StatTile icon="star" tone="warning" label="Points held" value={members.data ? outstanding.toLocaleString("en-IN") : "—"}
          note={rules && members.data ? `worth ${biz.amount(outstanding * Number(rules.point_value))}${members.data.total > members.data.items.length ? " (this page)" : ""}` : ""} />
      </div>
      <SectionCard flush icon="users" title="Customers and their points">
        <DataGrid {...members.gridProps} caption="Customers and their points" currency={biz.symbol} rowNoun={["customer", "customers"]}
          exportName={biz.can("loyalty.export") ? `${biz.business.code}-loyalty` : undefined}
          columns={[
            { key: "name", header: "Customer", value: (m) => m.name, mobile: "title", pin: true, render: (m) => <span className="bz-two-line"><strong>{m.name}</strong><small className="muted">{m.phone || "No phone"}</small></span> },
            { key: "balance", header: "Points now", type: "number", value: (m) => Number(m.balance), total: "sum", mobile: "show" },
            { key: "value", header: "Worth", type: "money", value: (m) => Number(m.balance) * Number(rules?.point_value || 0), total: "sum" },
            { key: "earned", header: "Earned", type: "number", value: (m) => Number(m.earned) },
            { key: "redeemed", header: "Redeemed", type: "number", value: (m) => Number(m.redeemed) },
            { key: "adjusted", header: "Corrections & returns", type: "number", value: (m) => Number(m.adjusted), defaultHidden: true },
            { key: "bills", header: "Bills", type: "number", value: (m) => m.bills },
            { key: "last_at", header: "Last activity", type: "date", value: (m) => m.last_at, mobile: "subtitle" },
            biz.can("loyalty.edit") && { key: "actions", header: "", label: "Actions", type: "actions", render: (m) => <button type="button" className="chip-button" onClick={() => setAdjusting(m)}>Correct</button> },
          ].filter(Boolean)}
          empty="No customer has points yet" emptyHint="Bills with a customer chosen earn points once the rules are on." emptyIcon="star" />
      </SectionCard>
      <SectionCard flush icon="history" title="Points history">
        <DataGrid {...entries.gridProps} caption="Points history" currency={biz.symbol} rowNoun={["entry", "entries"]} toolbar={<PeriodFilter list={entries} />}
          exportName={biz.can("loyalty.export") ? `${biz.business.code}-loyalty-history` : undefined}
          columns={[
            { key: "created_at", header: "When", type: "datetime", value: (e) => e.created_at, mobile: "subtitle" },
            { key: "contact_name", header: "Customer", value: (e) => e.contact_name, mobile: "title", pin: true },
            { key: "kind", header: "What", type: "status", value: (e) => e.kind, render: (e) => <Badge tone={KIND[e.kind]?.[0]} label={KIND[e.kind]?.[1]} />, mobile: "show" },
            { key: "points", header: "Points", type: "number", value: (e) => e.points, mobile: "show" },
            { key: "value", header: "Taken off the bill", type: "money", exact: true, value: (e) => (e.value === null ? null : Number(e.value)) },
            { key: "document_no", header: "Bill", value: (e) => e.document_no || "", className: "mono" },
            { key: "reason", header: "Reason", value: (e) => e.reason || "",
              render: (e) => (Number(e.shortfall_value) > 0 ? `${e.reason} · ${biz.exact(e.shortfall_value)} kept from the refund` : e.reason || "—") },
            { key: "created_by_name", header: "By", value: (e) => e.created_by_name, defaultHidden: true },
          ]}
          empty="No points earned or spent in these dates" emptyIcon="star" />
      </SectionCard>
      {editingRules && rules && <RulesDialog rules={rules} onClose={() => setEditingRules(false)} onSaved={() => { setEditingRules(false); refresh("Loyalty rules saved."); }} />}
      {adjusting && <AdjustDialog member={adjusting} onClose={() => setAdjusting(null)} onSaved={(e) => { setAdjusting(null); refresh(`${adjusting.name} now has ${e.balance} points.`); }} />}
    </div>
  );
}

function RulesDialog({ rules, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState({
    earnPerAmount: String(Number(rules.earn_per_amount)), earnPoints: String(rules.earn_points), pointValue: String(Number(rules.point_value)),
    minRedeemPoints: String(rules.min_redeem_points), maxRedeemPercent: String(Number(rules.max_redeem_percent)), active: rules.saved ? rules.active : true,
    returnSpentPoints: rules.return_spent_points !== false,
  });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const example = Math.floor(1000 / Number(form.earnPerAmount || 1)) * Number(form.earnPoints || 0);
  return (
    <FormDialog title="Loyalty rules" icon="star" width={640} onClose={onClose} onSaved={onSaved}
      onSubmit={() => businessWrite(biz.id, "loyalty/rules", form, "put")}
      description="New rules apply to bills from now on. Points already earned keep their number; their value follows the new rate.">
      <Field label="For every (₹ spent)"><input required type="number" min="1" step="0.01" value={form.earnPerAmount} onChange={set("earnPerAmount")} /></Field>
      <Field label="Customer earns (points)"><input required type="number" min="1" step="1" value={form.earnPoints} onChange={set("earnPoints")} /></Field>
      <Field label="One point is worth (₹)"><input required type="number" min="0.01" step="0.01" value={form.pointValue} onChange={set("pointValue")} /></Field>
      <Field label="Redeem from (points)"><input required type="number" min="1" step="1" value={form.minRedeemPoints} onChange={set("minRedeemPoints")} /></Field>
      <Field label="Points can pay at most (% of a bill)"><input required type="number" min="1" max="100" step="0.01" value={form.maxRedeemPercent} onChange={set("maxRedeemPercent")} /></Field>
      <label className="checkbox bz-check"><input type="checkbox" checked={form.active} onChange={set("active")} /> Points are on</label>
      <label className="checkbox bz-check field-wide"><input type="checkbox" checked={form.returnSpentPoints} onChange={set("returnSpentPoints")} /> Give back spent points on returns <small className="muted">(points used on a bill come back in proportion to the goods returned; points it earned are taken back)</small></label>
      <p className="field-wide muted small">Example: a {biz.exact(1000)} bill earns {example} points, worth {biz.exact(example * Number(form.pointValue || 0))} on a later bill.</p>
    </FormDialog>
  );
}

function AdjustDialog({ member, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const [form, setForm] = useState({ points: "", reason: "" });
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  return (
    <FormDialog title={`Correct points · ${member.name}`} icon="star" width={520} onClose={onClose} onSaved={onSaved}
      onSubmit={() => businessWrite(biz.id, `loyalty/${member.id}/adjustments`, { ...form, requestKey })}
      description={`${member.name} has ${member.balance} points. Use a minus sign to take points away.`}>
      <Field label="Points (+ to add, − to take away)"><input required type="number" step="1" value={form.points} onChange={set("points")} /></Field>
      <Field label="Reason" wide><input required maxLength={300} value={form.reason} placeholder="e.g. Diwali bonus promised in store" onChange={set("reason")} /></Field>
    </FormDialog>
  );
}
