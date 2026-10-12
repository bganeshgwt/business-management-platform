// Words and tones of the tasks screens.

export const TASK_STATUS = {
  todo: { label: "To do", tone: "neutral" },
  in_progress: { label: "In progress", tone: "info" },
  done: { label: "Done", tone: "success" },
  missed: { label: "Missed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "inactive" },
};
export const ISSUE_STATUS = {
  open: { label: "Open", tone: "warning" },
  in_progress: { label: "Being fixed", tone: "info" },
  resolved: { label: "Fixed", tone: "success" },
  closed: { label: "Closed", tone: "neutral" },
};
export const PROJECT_STATUS = {
  planning: { label: "Planning", tone: "neutral" },
  active: { label: "Active", tone: "info" },
  on_hold: { label: "On hold", tone: "warning" },
  completed: { label: "Completed", tone: "success" },
  cancelled: { label: "Cancelled", tone: "inactive" },
};
export const PRIORITY = {
  urgent: { label: "Urgent", tone: "danger" },
  high: { label: "High", tone: "warning" },
  normal: { label: "Normal", tone: "neutral" },
  low: { label: "Low", tone: "neutral" },
};
export const SEVERITY = {
  critical: { label: "Critical", tone: "danger" },
  high: { label: "High", tone: "warning" },
  medium: { label: "Medium", tone: "info" },
  low: { label: "Low", tone: "neutral" },
};
export const ITEM_KINDS = [
  ["checkbox", "Tick box"],
  ["yes_no", "Yes / No"],
  ["number", "Reading (number with a range)"],
  ["text", "Text"],
  ["photo", "Photo"],
  ["signature", "Signature"],
  ["choice", "Choice"],
  ["section", "Section heading"],
];
export const FREQUENCIES = [
  ["daily", "Every day"],
  ["weekdays", "Working days"],
  ["weekly", "Weekly, on chosen days"],
  ["monthly", "Monthly, on a date"],
  ["every_n_days", "Every few days"],
  ["per_shift", "Every shift"],
];
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const frequencyText = (s) => {
  const times = (s.dueTimes || []).join(", ");
  switch (s.frequency) {
    case "daily": return `Every day at ${times}`;
    case "weekdays": return `${(s.weekdays || []).length === 6 ? "Mon–Sat" : (s.weekdays || []).map((d) => WEEKDAYS[d]).join(", ")} at ${times}`;
    case "weekly": return `Every ${(s.weekdays || []).map((d) => WEEKDAYS[d]).join(", ")} at ${times}`;
    case "monthly": return `Monthly on day ${s.monthDay} at ${times}`;
    case "every_n_days": return `Every ${s.everyN} days at ${times}`;
    case "per_shift": return "Every shift, due at its end";
    default: return s.frequency;
  }
};

// Local "YYYY-MM-DDTHH:MM" for <input type="datetime-local"> and back.
export const toLocalInput = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fromLocalInput = (value) => (value ? new Date(value).toISOString() : null);
export const todayText = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// "Fridge 2: 9 °C (allowed 0 to 5)": a reading's allowed range in words.
export const rangeText = (item) => {
  const unit = item.unit ? ` ${item.unit}` : "";
  if (item.minValue !== null && item.maxValue !== null) return `${item.minValue} to ${item.maxValue}${unit}`;
  if (item.minValue !== null) return `${item.minValue}${unit} or more`;
  if (item.maxValue !== null) return `up to ${item.maxValue}${unit}`;
  return "";
};

// A new checklist item of a kind, for the builder.
export const blankItem = (kind = "checkbox") => ({ key: Math.random().toString(36).slice(2), kind, label: "", required: kind !== "section", unit: "", minValue: null, maxValue: null,
  options: kind === "choice" ? [{ label: "Good", fail: false }, { label: "Not good", fail: true }] : null, expected: kind === "yes_no" ? "yes" : null,
  photoRequired: false, critical: false, raiseIssue: true, failSeverity: "medium" });

// Items from the API (or the library) ready for the builder.
export const withKeys = (items) => (items || []).map((i) => ({
  ...blankItem(i.kind), kind: i.kind, label: i.label, help: i.help || null, required: i.required, unit: i.unit || "",
  minValue: i.minValue ?? i.min_value ?? null, maxValue: i.maxValue ?? i.max_value ?? null, options: i.options || null, expected: i.expected || null,
  photoRequired: Boolean(i.photoRequired ?? i.photo_required), critical: Boolean(i.critical), raiseIssue: i.raiseIssue ?? i.raise_issue ?? true,
  failSeverity: i.failSeverity || i.fail_severity || "medium",
}));

// What the API takes from the builder.
export const itemsForApi = (items) => items.map((i) => ({
  kind: i.kind, label: i.label, help: i.help || null, required: i.required, unit: i.unit || null, minValue: i.minValue, maxValue: i.maxValue,
  options: i.options, expected: i.expected, photoRequired: i.photoRequired, critical: i.critical, raiseIssue: i.raiseIssue, failSeverity: i.failSeverity,
}));
