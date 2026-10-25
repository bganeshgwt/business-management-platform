import { useEffect, useState } from "react";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import { dateTime } from "../../core/pages/hooks";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { useOpenBusiness } from "../../core/pages/hooks";
import "../styles/jewellery.css";

// A jeweller's settings: how new tags are numbered and the hallmarking charge
// a new hallmarked piece starts with; the hallmarking rules the jewellery bill
// follows: whether the business's turnover is up to ₹40 lakh (left out of
// mandatory hallmarking), and for each location whether its district is under
// mandatory hallmarking (taken as so until the owner says); and old gold: the
// deduction a new line starts with and any lower cash limit of the shop's own.
// Saved by a role that may change settings; everyone else sees them.

const formOf = (d) => ({ tagPrefix: d.tagPrefix, hallmarkCharge: d.hallmarkCharge ?? "", turnoverExempt: d.turnoverExempt,
  oldGoldDeduction: d.oldGoldDeduction ?? "0", oldGoldCashLimit: d.oldGoldCashLimit ?? "", cashWatchLevel: d.cashWatchLevel ?? "", reportingEntity: Boolean(d.reportingEntity),
  locations: d.locations.filter((l) => l.active).map((l) => ({ locationId: l.id, name: l.name, mandatory: l.confirmed ? (l.mandatory ? "yes" : "no") : "", district: l.district || "",
    confirmedAt: l.confirmedAt, confirmedByName: l.confirmedByName })) });

export default function JewellerySettingsPage() {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canSave = biz.can("settings.edit");
  const money = biz.can("sales.view");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/settings", undefined, controller.signal)
      .then((d) => { setData(d); setForm(formOf(d)); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id]);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const setPlace = (locationId, change) => setForm((f) => ({ ...f, locations: f.locations.map((l) => (l.locationId === locationId ? { ...l, ...change } : l)) }));
  const save = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await businessWrite(biz.id, "jewellery/settings", {
        tagPrefix: form.tagPrefix, ...(money ? { hallmarkCharge: form.hallmarkCharge || "0", oldGoldDeduction: form.oldGoldDeduction || "0", oldGoldCashLimit: form.oldGoldCashLimit,
          cashWatchLevel: form.cashWatchLevel, reportingEntity: form.reportingEntity } : {}),
        turnoverExempt: form.turnoverExempt,
        locations: form.locations.filter((l) => l.mandatory).map((l) => ({ locationId: l.locationId, mandatory: l.mandatory === "yes", district: l.district.trim() || undefined })),
      }, "put");
      setData(next);
      setForm(formOf(next));
      toast.success("Jewellery settings saved.");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (!data) return <div className="stack"><BusinessHeader icon="settings" title="Jewellery settings" /><ErrorMessage message={error} />{!error && <Loading />}</div>;
  return (
    <form className="stack" onSubmit={save}>
      <BusinessHeader icon="settings" title="Jewellery settings" description="How the shop's tags are numbered, what a new hallmarked piece is charged for hallmarking, the hallmarking rules the jewellery bill follows, and how old gold is bought." />
      <ErrorMessage message={error} />
      <fieldset className="stack bz-fieldset" disabled={!canSave || busy}>
        <SectionCard icon="tag" title="Tags and the hallmarking charge">
          <div className="form-grid bz-form">
            <Field label="Letters a new tag starts with" hint={`Up to 6 letters, or none. The next tag: ${data.nextTag}.`}>
              <input maxLength={6} className="mono" value={form.tagPrefix} onChange={set("tagPrefix")} />
            </Field>
            {money && (
              <Field label="Hallmarking charge on a new hallmarked piece (₹)" hint="Each piece keeps its own; the bill prints it for each article.">
                <input type="number" min="0" max="10000" step="0.01" value={form.hallmarkCharge} onChange={set("hallmarkCharge")} />
              </Field>
            )}
          </div>
        </SectionCard>
        <SectionCard icon="shield" title="Mandatory hallmarking"
          description="Gold jewellery of 2 g or more is sold only with its BIS hallmark and HUID in the districts under mandatory hallmarking (380 from 2 March 2026; later amendments may add more), unless the article is left out (set on the piece) or the jeweller's annual turnover is up to ₹40 lakh.">
          <label className="checkbox bz-check"><input type="checkbox" checked={form.turnoverExempt} onChange={set("turnoverExempt")} /> The business's annual turnover is up to ₹40 lakh: mandatory hallmarking leaves it out</label>
          {data.turnoverConfirmedAt && <p className="muted small">Last said on {dateTime(data.turnoverConfirmedAt)}.</p>}
          <table className="jw-rates">
            <thead><tr><th scope="col">Location</th><th scope="col">Its district is under mandatory hallmarking</th><th scope="col">District</th><th scope="col">Said</th></tr></thead>
            <tbody>{form.locations.map((l) => (
              <tr key={l.locationId}>
                <th scope="row">{l.name}</th>
                <td><select aria-label={`${l.name}: under mandatory hallmarking`} value={l.mandatory} onChange={(e) => setPlace(l.locationId, { mandatory: e.target.value })}>
                  <option value="">Not said yet (taken as yes)</option><option value="yes">Yes</option><option value="no">No</option></select></td>
                <td><input aria-label={`${l.name}: district`} maxLength={80} value={l.district} onChange={(e) => setPlace(l.locationId, { district: e.target.value })} placeholder="e.g. Bengaluru Urban" /></td>
                <td>{l.confirmedAt ? <small className="muted">{dateTime(l.confirmedAt)} · {l.confirmedByName}</small> : <span className="bz-minus">Not said</span>}</td>
              </tr>
            ))}</tbody>
          </table>
          <p className="jw-note">Check your district against BIS's list of districts under mandatory hallmarking, and say here when it changes. The HUID is printed on the invoice where the piece has one.</p>
        </SectionCard>
        {money && (
          <SectionCard icon="scale" title="Old gold" description="A seller does not receive ₹2,00,000 or more in cash for old gold in a day or for one voucher (Income-tax Act 2025, section 186). Any lower limit here is the shop's own.">
            <div className="form-grid bz-form">
              <Field label="Deduction a new line starts with (%)" hint="Melting loss or the shop's own rule; each line can change it.">
                <input type="number" min="0" max="99.99" step="0.01" value={form.oldGoldDeduction} onChange={set("oldGoldDeduction")} />
              </Field>
              <Field label="The shop's own cash limit, to one seller in a day (₹)" hint="Empty: none of the shop's own.">
                <input type="number" min="1" max="199999.99" step="0.01" value={form.oldGoldCashLimit} onChange={set("oldGoldCashLimit")} />
              </Field>
            </div>
          </SectionCard>
        )}
        {money && (
          <SectionCard icon="reports" title="Cash report" description="The cash report flags each customer whose cash with the shop reaches ₹10 lakh in a month: a jeweller with cash transactions of ₹10 lakh or more with a customer is a reporting entity under the PMLA.">
            <div className="form-grid bz-form">
              <Field label="The shop's own alert level, cash with one customer in a month (₹)" hint="Below ₹10 lakh; empty: none. Customers past it are marked and the bell says so.">
                <input type="number" min="1" max="999999.99" step="0.01" value={form.cashWatchLevel} onChange={set("cashWatchLevel")} />
              </Field>
            </div>
            <label className="checkbox bz-check"><input type="checkbox" checked={form.reportingEntity} onChange={set("reportingEntity")} /> The shop is a reporting entity under the PMLA (registered with FIU-IND)</label>
            {data.reportingEntityAt && <p className="muted small">Last said on {dateTime(data.reportingEntityAt)}. The bell then reminds the shop of each month&apos;s cash transactions report by the 15th.</p>}
          </SectionCard>
        )}
      </fieldset>
      {canSave && <div className="form-actions"><button type="submit" className="button" disabled={busy}><Icon name="check" size={16} /> {busy ? "Saving…" : "Save"}</button></div>}
    </form>
  );
}
