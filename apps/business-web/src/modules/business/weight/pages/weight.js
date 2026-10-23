// Small helpers shared by the weight-shop screens.
import "../../../../styles/business-salon-weight.css";

export const REASONS = [
  { value: "trimming", label: "Trimming" }, { value: "spoiled", label: "Spoiled" }, { value: "unsold", label: "Unsold / past its best" },
  { value: "drip_loss", label: "Drip / moisture loss" }, { value: "damaged", label: "Damaged" }, { value: "other", label: "Other" },
];
export const reasonWord = (reason) => REASONS.find((r) => r.value === reason)?.label || reason;

// "2.350 kg", "750 g": three decimals where they matter, no trailing noise.
export const kg = (value) => `${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 3 })} kg`;
export const weightOf = (value, unit) => `${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })} ${unit}`;
export const percentText = (value) => (value === null || value === undefined ? "—" : `${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`);
// Yield against what the template expects: a point or more under is shown in red.
export const yieldTone = (actual, expected) => {
  if (actual === null || actual === undefined || expected === null || expected === undefined) return "";
  return Number(actual) + 1 < Number(expected) ? "sw-yield-low" : "sw-yield-good";
};

// A meat or fish shop cuts and cleans; a dry-fruit or other
// weight shop sorts and repacks. The same screens, in each trade's words.
export function processWords(type) {
  if (type === "weight_retail") {
    return { title: "Sorting & repacking", action: "Sort / repack", batch: "Sorting batch", batches: "Sorting batches", outputs: "Outputs weighed", output: "output",
      from: "Sorted from", input: "What is being sorted", loss: "dust, broken pieces, moisture", template: "Saved repacking setup", outputsLabel: "Outputs" };
  }
  return { title: "Cutting & processing", action: "Cut / clean", batch: "Cutting batch", batches: "Cutting batches", outputs: "Cuts weighed", output: "cut",
    from: "Cut from", input: "What is being cut", loss: "bones, skin, scales, moisture", template: "Saved cutting setup", outputsLabel: "Cuts" };
}
