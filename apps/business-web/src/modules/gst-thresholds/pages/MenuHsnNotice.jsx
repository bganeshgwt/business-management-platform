import { useEffect, useState } from "react";
import { menuHsn } from "../services/gstThresholds.service";
import { hsnWhen } from "../gstThresholds";

// On the restaurant's Tax rates, once its PAN's turnover has passed the figure
// from which every invoice carries a longer HSN / SAC code (last year: asked
// now; this year so far: from the next 1 April, named now to prepare): a dish
// prints its rate's code, so the rates with a shorter code (or none) and a
// dish on them are named, to fix. `rates` is the page's list: when it changes,
// this asks again.
export default function MenuHsnNotice({ rates }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    menuHsn(controller.signal).then(setData).catch(() => { if (!controller.signal.aborted) setData(null); });
    return () => controller.abort();
  }, [rates]);
  if (!data?.applies || data.rates.length === 0) return null;
  const named = data.rates.map((rate) => `${rate.name} (${rate.hsn_code ? `code ${rate.hsn_code}` : "no code"}, ${rate.dishes} ${rate.dishes === 1 ? "dish" : "dishes"})`);
  return (
    <div className="alert alert-notice" role="status">
      {data.rule.applies} This applies to this restaurant&apos;s invoices {hsnWhen(data)}, and each dish prints its rate&apos;s code: {named.join("; ")}. Edit {data.rates.length === 1 ? "the rate" : "each rate"} to give it the full {data.digits}-digit code.
    </div>
  );
}
