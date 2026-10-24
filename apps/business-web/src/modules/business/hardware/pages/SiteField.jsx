import { useEffect, useState } from "react";
import Icon from "@bmp/ui/Icon";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "../../core/pages/FormDialog";
import { Field } from "../../core/pages/ui";
import { useCustomerSites, usesSites } from "./hardware";

// A select of the customer's sites. `value` is a site id as text ("" = none).
export default function SiteField({ biz, contactId, value, onChange, label = "Site (optional)", hint, wide }) {
  const sites = useCustomerSites(biz, contactId);
  if (!usesSites(biz) || !contactId) return null;
  const shown = sites.filter((s) => s.active || String(s.id) === String(value));
  return (
    <Field label={label} wide={wide} hint={hint || (shown.length ? "Where the goods go; the site's ledger counts this." : "This customer has no sites yet. Add one on the Sites screen.")}>
      <select value={value || ""} onChange={(e) => onChange(e.target.value)} disabled={!shown.length}>
        <option value="">No site</option>
        {shown.map((s) => <option key={s.id} value={s.id}>{s.name}{s.address ? ` · ${s.address}` : ""}{s.active ? "" : " (closed)"}</option>)}
      </select>
    </Field>
  );
}

// Choosing or changing the site of a posted bill or of a sales order.
export function SiteDialog({ biz, title, contactId, current, path, onClose, onSaved }) {
  const [siteId, setSiteId] = useState(current?.id ? String(current.id) : "");
  return (
    <FormDialog title={title} icon="map-pin" width={520} submitLabel="Save" onClose={onClose} onSaved={onSaved}
      description="The site's ledger counts this from now on. Choosing no site takes it off the site."
      onSubmit={async () => {
        try {
          return await businessWrite(biz.id, path, { siteId: siteId || null }, "put");
        } catch (err) {
          throw new Error(getErrorMessage(err));
        }
      }}>
      <SiteField biz={biz} contactId={contactId} value={siteId} onChange={setSiteId} label="Site" wide />
    </FormDialog>
  );
}

// A sales order's site, on the order: shown, and set or changed while the
// order is still to send. Its invoices go to that site.
export function OrderSite({ biz, order, onChanged }) {
  const [site, setSite] = useState(undefined);
  const [editing, setEditing] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `hardware/orders/${order.id}/site`, undefined, controller.signal)
      .then((r) => setSite(r.site))
      .catch(() => { if (!controller.signal.aborted) setSite(null); });
    return () => controller.abort();
  }, [biz.id, order.id, version]);
  if (site === undefined) return null;
  const live = ["open", "part_dispatched"].includes(order.status);
  return (
    <>
      {site && <span className="bz-chip"><Icon name="map-pin" size={13} /> Site {site.name}</span>}
      {live && biz.can("hardware_sites.edit") && <button type="button" className="chip-button" onClick={() => setEditing(true)}>{site ? "Change the site" : "Set the site"}</button>}
      {editing && <SiteDialog biz={biz} title={`Site of ${order.order_no}`} contactId={order.contact_id} current={site} path={`hardware/orders/${order.id}/site`}
        onClose={() => setEditing(false)} onSaved={() => { setEditing(false); setVersion((n) => n + 1); onChanged?.(); }} />}
    </>
  );
}
