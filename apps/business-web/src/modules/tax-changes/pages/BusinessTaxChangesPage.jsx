import { useMemo } from "react";
import { ErrorMessage } from "../../../components/Feedback";
import { businessToday, useOpenBusiness, useOptions, useServerList } from "../../business/core/pages/hooks";
import { shopChanges } from "../services/taxChanges.service";
import { WORDS } from "../taxChanges";
import TaxChangesView from "./TaxChangesView";

// A shop's GST rate changes (Products & services › GST rate changes): its
// catalogue items moved to another GST slab from a date entered ahead.
export default function BusinessTaxChangesPage() {
  const biz = useOpenBusiness();
  const list = useServerList("tax-changes", { gridId: "business-tax-changes" });
  const { options, error } = useOptions(["tax-rates?active=true", "categories?active=true"]);
  const api = useMemo(() => shopChanges(biz.id), [biz.id]);
  const rates = (options?.["tax-rates?active=true"] || []).map((r) => ({ id: r.id, name: r.name, rate: r.rate }));
  const categories = (options?.["categories?active=true"] || []).map((c) => ({ id: c.id, name: c.path || c.name }));
  const inclusive = biz.settings.tax_mode === "inclusive";
  return (
    <>
      <ErrorMessage message={error || list.error} />
      <TaxChangesView api={api} words={WORDS.shop} canEdit={biz.can("catalog.edit")} gridProps={list.gridProps} reload={list.reload}
        rates={rates} categories={categories} pricesInclude={inclusive} today={businessToday(biz.business.timezone)} currency={biz.symbol}
        description={`The yearly GST change, entered ahead of its date: from that day every sale, quotation and bill uses the new slab, and a bill made before keeps its rate. ${inclusive
          ? "Your prices include GST: they keep their total unless a change keeps the price before GST."
          : "Your prices are before GST: they stay, and the GST added on them follows the slab."}`} />
    </>
  );
}
