import { useMemo } from "react";
import useBusiness from "../../../hooks/useBusiness";
import { makeTerms } from "../../../services/terms";
import useTasks from "./useTasks";

// The examples the task screens show in their fields: a business's own (its
// words, services/terms.js: a gym's "Gym floor" and "Treadmill belts wiped",
// a garage's "Hoist 2 leaking oil"), a kitchen's in a restaurant. An example
// a business has none of is empty, and the field shows none.
const KITCHEN = {
  checklistSection: "Kitchen",
  checklistItem: "Walk-in chiller temperature",
  templates: "opening checklist, temperature log, FSSAI",
  issue: "Walk-in freezer not cooling, scale showing wrong weight",
  asset: "Walk-in freezer, scale 2, van KA-01-AB-1234",
  project: "A new outlet, a festival sale, the annual stock audit",
  plans: "New outlet opening, Festival sale set-up, Annual stock audit",
};

export default function useTaskExamples() {
  const { world } = useTasks();
  const { context } = useBusiness();
  const terms = context?.terms;
  return useMemo(() => {
    if (world === "restaurant") return KITCHEN;
    const t = makeTerms(terms);
    return {
      checklistSection: t.ex("checklist_section"),
      checklistItem: t.ex("checklist_item"),
      templates: t.ex("templates"),
      issue: t.ex("issue"),
      asset: t.ex("asset"),
      project: t.ex("project"),
      plans: "",
    };
  }, [world, terms]);
}

// "Opening checklist, temperature log…": an example list as a field's placeholder.
export const listPlaceholder = (text, fallback = "") => (text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}…` : fallback);
