import { useMemo } from "react";
import { dayTotals } from "./salesJournal";
import { dayFigures } from "./salesRules";

// The day's figures, from the phone's journal and the office's copy of the day.
export default function useFigures(sales) {
  return useMemo(() => {
    const totals = dayTotals(sales.entries, sales.day, sales.today, sales.status);
    const plannedRefs = sales.planned;
    const visitedPlanned = plannedRefs.filter((shop) => sales.visits.some((v) => shop.refs.includes(v.shopRef))).length;
    const productive = sales.visits.filter((v) => v.orderKeys.length > 0).length;
    const lines = sales.entries.filter((e) => e.kind === "order" && e.date === sales.today && sales.visits.some((v) => v.key === e.visitKey)).reduce((sum, e) => sum + (e.data.lines?.length || 0), 0)
      + (sales.day?.orders || []).filter((o) => !sales.entries.some((e) => e.id === o.request_key) && sales.visits.some((v) => v.key === o.visit_key)).reduce((sum, o) => sum + Number(o.line_count || 0), 0);
    const figures = dayFigures({ planned: plannedRefs.length, visitedPlanned, calls: sales.visits.length, productive, lines });
    return { ...totals, planned: plannedRefs.length, visitedPlanned, calls: sales.visits.length, productive, lines, ...figures };
  }, [sales.entries, sales.day, sales.today, sales.status, sales.planned, sales.visits]);
}
