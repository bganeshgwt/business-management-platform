// The built-in template library is written as short lines, one per checklist
// item, so a template reads like the paper checklist it replaces:
//
//   "# Kitchen"                                   a section heading
//   "Hand-wash basin has soap and paper towels"   a tick box
//   "yn: Pest control done this month?"           yes / no (yes passes)
//   "yn-no: Any leakage from the gas line?"       yes / no (no passes)
//   "num: Chiller temperature | °C | 0 | 5"       a reading with the range that passes
//   "txt: Notes for the next shift"               free text
//   "photo: Photo of the display counter"         at least one photo
//   "sign: Signature of the person in charge"     a drawn signature
//   "choice: Floor | Clean, Needs mopping*, Dirty*"   a choice; * marks the answers that fail
//
// Trailing marks: " !" critical (a failure fails the whole checklist),
// " ?" optional, " +photo" a photo is needed whatever the answer,
// " ~high" / " ~critical" / " ~low" the severity of the issue a failure raises,
// " -issue" a failure raises no issue.

const KIND_PREFIX = {
  "yn:": ["yes_no", { expected: "yes" }],
  "yn-no:": ["yes_no", { expected: "no" }],
  "num:": ["number", {}],
  "txt:": ["text", {}],
  "photo:": ["photo", {}],
  "sign:": ["signature", {}],
  "choice:": ["choice", {}],
};

function parseItem(line, position) {
  let text = String(line).trim();
  const item = {
    position, kind: "checkbox", label: "", help: null, required: true, unit: null, min_value: null, max_value: null,
    options: null, expected: null, photo_required: false, critical: false, raise_issue: true, fail_severity: "medium",
  };
  if (text.startsWith("# ")) return { ...item, kind: "section", label: text.slice(2).trim(), required: false, raise_issue: false };
  // Trailing marks, in any order.
  for (;;) {
    const before = text;
    if (text.endsWith(" !")) { item.critical = true; item.fail_severity = item.fail_severity === "medium" ? "high" : item.fail_severity; text = text.slice(0, -2).trim(); }
    if (text.endsWith(" ?")) { item.required = false; text = text.slice(0, -2).trim(); }
    if (text.endsWith(" +photo")) { item.photo_required = true; text = text.slice(0, -7).trim(); }
    if (text.endsWith(" -issue")) { item.raise_issue = false; text = text.slice(0, -7).trim(); }
    const severity = text.match(/ ~(low|medium|high|critical)$/);
    if (severity) { item.fail_severity = severity[1]; text = text.slice(0, -severity[0].length).trim(); }
    if (text === before) break;
  }
  const prefix = Object.keys(KIND_PREFIX).find((key) => text.startsWith(key));
  if (prefix) {
    const [kind, extra] = KIND_PREFIX[prefix];
    Object.assign(item, { kind, ...extra });
    text = text.slice(prefix.length).trim();
  }
  const parts = text.split("|").map((part) => part.trim());
  item.label = parts[0];
  if (item.kind === "number") {
    item.unit = parts[1] || null;
    item.min_value = parts[2] !== undefined && parts[2] !== "" ? Number(parts[2]) : null;
    item.max_value = parts[3] !== undefined && parts[3] !== "" ? Number(parts[3]) : null;
  } else if (item.kind === "choice") {
    item.options = (parts[1] || "").split(",").map((o) => o.trim()).filter(Boolean)
      .map((o) => ({ label: o.replace(/\*$/, "").trim(), fail: o.endsWith("*") }));
  } else if (parts[1]) {
    item.help = parts[1];
  }
  // Text, photo and signature answers cannot fail; ticks fail only when left
  // unticked on a finished checklist, which "required" already refuses.
  if (["text", "photo", "signature", "checkbox"].includes(item.kind)) item.raise_issue = false;
  return item;
}

const parseItems = (lines) => lines.map((line, index) => parseItem(line, index));

module.exports = { parseItem, parseItems };
