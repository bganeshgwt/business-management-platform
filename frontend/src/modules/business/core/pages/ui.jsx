import { cloneElement, isValidElement, useId } from "react";
import PageHeader from "../../../../components/PageHeader";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import { ErrorMessage } from "../../../../components/Feedback";
import "../styles/business-admin.css";
import StatusBadge from "../../../../components/StatusBadge";
import { statusTone } from "../../../../services/status";

// Small display pieces shared by the Business Admin screens.

// No eyebrow with the business name: the switcher in the header already
// names it (it was printed three times above the fold). `primary`,
// `secondary` and `more` pass through to PageHeader.
export function BusinessHeader({ title, description, icon, actions, primary, secondary, more }) {
  return <PageHeader title={title} description={description} icon={icon} actions={actions} primary={primary} secondary={secondary} more={more} />;
}

// The period a growing list shows; it opens on the current month.
export function PeriodFilter({ list }) {
  if (!list.range) return null;
  return <DateRangeFilter from={list.range.from} to={list.range.to} anchor={list.anchor} label="dates" onChange={list.setRange} />;
}

// A labelled form control in the app's own .field style. The control is
// named by the label text alone (aria-labelledby), so a select is not
// announced with its chosen option glued to its name.
export function Field({ label, hint, wide, children }) {
  const id = useId();
  const control = isValidElement(children) ? cloneElement(children, { "aria-labelledby": `${id}-label` }) : children;
  return (
    <label className={`field ${wide ? "field-wide" : ""}`}>
      <span id={`${id}-label`}>{label}</span>
      {control}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

// A status as colour, dot and word: the app's one StatusBadge and its one
// status map (components/StatusBadge.jsx). A code the map does not know is
// drawn grey.
export function Badge({ status, label, tone }) {
  return <StatusBadge status={status} label={label} tone={tone || statusTone(status) || "neutral"} />;
}

export function ActiveBadge({ active }) {
  return <Badge status={active ? "active" : "inactive"} label={active ? "Active" : "Switched off"} />;
}

// Shown when a form cannot load what it needs.
export function FormError({ message }) {
  if (!message) return null;
  return <div className="field-wide"><ErrorMessage message={message} /></div>;
}
