import StatusBadge from "../../../../components/StatusBadge";
import { Field } from "../../core/pages/ui";
import { FLAG_WORDS, LAB_STATES, isFlagged } from "./healthFormat";
import "../styles/health.css";

// Badges and fields the pharmacy, clinic and lab screens share (round 2,
// health module). Words and helpers: healthFormat.js.

const SCHEDULE_TONES = { H: "warning", H1: "danger", X: "danger", narcotic: "danger", G: "info", none: "neutral", unset: "neutral" };
export function ScheduleBadge({ schedule }) {
  if (!schedule || schedule === "none") return <span className="muted">OTC</span>;
  if (schedule === "unset") return <StatusBadge tone="neutral" label="No drug details" />;
  return <StatusBadge tone={SCHEDULE_TONES[schedule] || "neutral"} label={schedule === "narcotic" ? "Narcotic" : `Sch. ${schedule}`} />;
}

export function LabStatus({ status }) {
  const [tone, label] = LAB_STATES[status] || ["neutral", status];
  return <StatusBadge tone={tone} label={label} />;
}
export function ReportReady({ status }) {
  if (!status || status === "none") return <span className="muted">No tests</span>;
  return status === "ready" ? <StatusBadge tone="success" label="Report ready" /> : <StatusBadge tone="warning" label="Report pending" />;
}
export function FlagBadge({ flag }) {
  if (!isFlagged(flag)) return null;
  return <StatusBadge tone={flag.startsWith("critical") ? "danger" : "warning"} label={FLAG_WORDS[flag]} />;
}

// Who signs, and their own PIN (My profile › Personal PIN): Schedule X sales, lab reports.
export function SignOff({ kind, signatories, value, onChange, hint }) {
  const list = signatories || [];
  const word = kind === "pharmacist" ? "Registered pharmacist" : kind === "pathologist" ? "Pathologist" : "Doctor";
  if (signatories && !list.length) {
    return <p className="hl-note hl-note-warning field-wide">No {word.toLowerCase()} is set up yet. An owner adds one under Settings › {kind === "pharmacist" ? "Pharmacy" : "Clinic & lab"} settings.</p>;
  }
  return (
    <>
      <Field label={word}>
        <select required value={value.signatoryId || ""} onChange={(e) => onChange({ ...value, signatoryId: e.target.value })}>
          <option value="">Choose…</option>
          {list.map((s) => <option key={s.id} value={s.id} disabled={!s.has_pin}>{s.name} · Reg. {s.registration_no}{s.has_pin ? "" : " (no PIN set)"}</option>)}
        </select>
      </Field>
      <Field label={`${word}'s PIN`} hint={hint || "Their own PIN from My profile › Personal PIN. Checked on the server; never stored with the record."}>
        <input required type="password" inputMode="numeric" autoComplete="off" pattern="\d{4,8}" title="4 to 8 digits" maxLength={8}
          value={value.pin || ""} onChange={(e) => onChange({ ...value, pin: e.target.value.replace(/\D/g, "") })} />
      </Field>
    </>
  );
}
