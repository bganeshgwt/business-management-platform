// Why a dish the kitchen already has is being taken off. A fixed list, so the
// owner's report can add them up; "Other" must say what. Shared by the order
// service (which asks for one) and the kitchen change slips (which print it).
const CANCEL_REASONS = [
  { code: "guest_changed_mind", label: "Guest changed their mind" },
  { code: "wrong_order", label: "Wrong dish punched" },
  { code: "delay", label: "Took too long" },
  { code: "quality", label: "Quality complaint" },
  { code: "other", label: "Other" },
];

const reasonLabel = (code) => (CANCEL_REASONS.find((reason) => reason.code === code) || {}).label || null;

module.exports = { CANCEL_REASONS, reasonLabel };
