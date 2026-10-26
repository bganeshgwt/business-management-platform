import { useCallback, useEffect, useMemo, useState } from "react";
import { ErrorMessage } from "../../../components/Feedback";
import useAuth from "../../../hooks/useAuth";
import { getErrorMessage } from "../../../services/api";
import { listCategories, listTaxRates } from "../../restaurant/menu/services/menu.service";
import { getSettings } from "../../restaurant/setup/services/restaurant.service";
import { menuChanges } from "../services/taxChanges.service";
import { WORDS } from "../taxChanges";
import TaxChangesView from "./TaxChangesView";

// A restaurant's GST rate changes (Menu › GST rate changes): its dishes moved
// to another tax rate from a day entered ahead, on the restaurant's own
// trading day. Its bills keep the rates they were made at.
export default function MenuTaxChangesPage() {
  const { hasPermission } = useAuth();
  const api = useMemo(() => menuChanges(), []);
  const [list, setList] = useState(null);
  const [rates, setRates] = useState([]);
  const [categories, setCategories] = useState([]);
  const [currency, setCurrency] = useState("₹");
  const [error, setError] = useState("");

  const load = useCallback((signal) => api.list(signal).then(setList).catch((err) => { if (!signal?.aborted) setError(getErrorMessage(err)); }), [api]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    Promise.all([listTaxRates(), listCategories()])
      .then(([taxRates, menuCategories]) => {
        setRates(taxRates.filter((r) => r.status === "active").map((r) => ({ id: r.id, name: r.name, rate: r.percentage })));
        setCategories(menuCategories.map((c) => ({ id: c.id, name: c.name })));
      })
      .catch((err) => setError(getErrorMessage(err)));
    // The currency symbol shown against every price.
    getSettings().then((settings) => setCurrency(settings.currencySymbol || "₹")).catch(() => undefined);
    return () => controller.abort();
  }, [load]);

  return (
    <>
      <ErrorMessage message={error} />
      <TaxChangesView api={api} words={WORDS.menu} canEdit={hasPermission("menu.manage")}
        gridProps={{ id: "menu-tax-changes", rows: list?.changes || [], loading: !list && !error, error: list ? "" : error, onRetry: () => load() }}
        reload={() => load()} rates={rates} categories={categories} pricesInclude="mixed" today={list?.today || null}
        currency={currency}
        description="The yearly GST change, entered ahead of its day: from that trading day every order and bill uses the new tax rate, and a bill made before keeps its rate." />
    </>
  );
}
