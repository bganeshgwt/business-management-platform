import { useMemo } from "react";
import { ErrorMessage } from "../../../components/Feedback";
import { businessToday, useOpenBusiness, useOptions, useServerList } from "../../business/core/pages/hooks";
import { shopChanges } from "../services/taxChanges.service";
import { shopWords } from "../taxChanges";
import TaxChangesView from "./TaxChangesView";

// A business's GST rate changes (Products & services › GST rate changes): its
// items moved to another GST slab from a date entered ahead, in its words.
export default function BusinessTaxChangesPage() {
  const biz = useOpenBusiness();
  const { t } = biz;
  const list = useServerList("tax-changes", { gridId: "business-tax-changes" });
  const { options, error } = useOptions(["tax-rates?active=true", "categories?active=true"]);
  const api = useMemo(() => shopChanges(biz.id), [biz.id]);
  const words = useMemo(() => shopWords(t), [t]);
  const rates = (options?.["tax-rates?active=true"] || []).map((r) => ({ id: r.id, name: r.name, rate: r.rate }));
  const categories = (options?.["categories?active=true"] || []).map((c) => ({ id: c.id, name: c.path || c.name }));
  const inclusive = biz.settings.tax_mode === "inclusive";
  // A rate GST law fixes, which the software keeps (not a setting), where the business has one.
  const lawRate = biz.has("jewellery") ? "A jewellery item's 3%" : biz.has("fuel") ? "A fuel's nil slab" : null;
  return (
    <>
      <ErrorMessage message={error || list.error} />
      <TaxChangesView api={api} words={words} canEdit={biz.can("catalog.edit")} canEditSettings={biz.can("settings.edit")} gridProps={list.gridProps} reload={list.reload}
        help={lawRate ? `${lawRate} is a rule of GST law kept by the software, not a setting: no change here moves it.` : undefined}
        rates={rates} categories={categories} pricesInclude={inclusive} today={businessToday(biz.business.timezone)} currency={biz.symbol}
        description={`The yearly GST change, entered ahead of its date: from that day every sale, quotation and bill uses the new slab, and a bill made before keeps its rate. ${inclusive
          ? "Your prices include GST: they keep their total unless a change keeps the price before GST."
          : "Your prices are before GST: they stay, and the GST added on them follows the slab."}`} />
    </>
  );
}
