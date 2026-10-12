import { useEffect, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { newKey, useOpenBusiness } from "../../core/pages/hooks";

// Exchange credit customers kept on their account, and the button that
// spends it on their unpaid bills (oldest first). Shown only when someone has
// credit left; works whether or not the receivables module is on.
export default function CustomerCredit({ onUsed, version }) {
  const biz = useOpenBusiness();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "exchanges/credits", undefined, controller.signal)
      .then((result) => { setRows(result); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version, reload]);

  const use = async (row) => {
    setBusy(row.contact_id); setError("");
    try {
      const result = await businessWrite(biz.id, `exchanges/credits/${row.contact_id}/use`, { requestKey: newKey() });
      onUsed?.(`${biz.exact(result.applied)} of ${row.name}'s exchange credit used on their unpaid bills.`);
      setReload((n) => n + 1);
    } catch (err) { setError(getErrorMessage(err)); } finally { setBusy(null); }
  };
  const canUse = biz.can("exchanges.create") && biz.can("sales.edit");
  if (!rows?.length && !error) return null;
  return (
    <SectionCard flush icon="wallet" title="Exchange credit kept on account"
      description="Credit customers chose to keep. Post their next sale as unpaid, then use the credit on it here.">
      <ErrorMessage message={error} />
      {rows?.length > 0 && (
        <DataGrid variant="compact" id="exchange-credits" caption="Customers with exchange credit" rows={rows} rowKey={(r) => r.contact_id}
          currency={biz.symbol} rowNoun={["customer", "customers"]} columns={[
            { key: "name", header: "Customer", value: (r) => r.name, mobile: "title" },
            { key: "phone", header: "Phone", value: (r) => r.phone || "" },
            { key: "notes", header: "From", value: (r) => r.notes.map((n) => n.reference || n.collectionNo).join(", "), className: "mono" },
            { key: "credit", header: "Credit left", type: "money", exact: true, value: (r) => Number(r.credit), total: "sum", mobile: "show" },
            { key: "owed", header: "Unpaid bills", type: "money", exact: true, value: (r) => Number(r.owed), mobile: "show" },
            canUse && { key: "actions", header: "", label: "Actions", type: "actions",
              render: (r) => <button type="button" className="chip-button" disabled={busy === r.contact_id || Number(r.owed) <= 0} onClick={() => use(r)}>
                {Number(r.owed) > 0 ? "Use on unpaid bills" : "No unpaid bill"}</button> },
          ].filter(Boolean)} />
      )}
    </SectionCard>
  );
}
