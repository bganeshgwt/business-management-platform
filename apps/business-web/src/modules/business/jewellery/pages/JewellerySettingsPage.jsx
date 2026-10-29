import { useEffect, useState } from "react";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import { dateShort } from "@bmp/shared/format";
import { dateTime, newKey } from "../../core/pages/hooks";
import { Badge, BusinessHeader, Field } from "../../core/pages/ui";
import { useOpenBusiness } from "../../core/pages/hooks";
import { METALS } from "./jewellery";
import "../styles/jewellery.css";

// A jeweller's settings: how new tags are numbered and the hallmarking charge
// a new hallmarked piece starts with; the hallmarking rules the jewellery bill
// follows: whether the business's turnover is up to ₹40 lakh (left out of
// mandatory hallmarking), and for each location whether its district is under
// mandatory hallmarking (taken as so until the owner says); the rate sessions
// the shop names beyond morning and evening; old gold: the buy-back rules (the
// general deduction, one for the shop's own pieces, one for each purity) and
// any lower cash limit of the shop's own; the cash report's alert levels; the
// KYC documents the shop accepts; whether a counter discount may come off the
// metal; and a company's net worth (its gold scheme money is held against 25%
// of it). Saved by a role that may change settings; everyone else sees them.
// Below the form: the shop's offers on making, by dates (jewellery.approve).

const joined = (list) => (list || []).join(", ");
const split = (text) => String(text || "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
const formOf = (d) => ({ tagPrefix: d.tagPrefix, hallmarkCharge: d.hallmarkCharge ?? "", turnoverExempt: d.turnoverExempt,
  rateSessions: joined(d.rateSessions), oldGoldDeduction: d.oldGoldDeduction ?? "0", ownPieceDeduction: d.ownPieceDeduction ?? "",
  purityDeductions: (d.purityDeductions || []).map((p) => ({ ...p, deductionPercent: p.deductionPercent ?? "" })),
  oldGoldCashLimit: d.oldGoldCashLimit ?? "", cashAlertLevels: joined(d.cashAlertLevels), reportingEntity: Boolean(d.reportingEntity), kycKinds: joined(d.kycKinds),
  discountOnMetal: Boolean(d.discountOnMetal), companyNetWorth: d.companyNetWorth ?? "", netWorthOn: d.netWorthOn ?? "",
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
  const setPurity = (key, value) => setForm((f) => ({ ...f, purityDeductions: f.purityDeductions.map((p) => (`${p.metal}:${p.purity}` === key ? { ...p, deductionPercent: value } : p)) }));
  const save = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await businessWrite(biz.id, "jewellery/settings", {
        tagPrefix: form.tagPrefix, rateSessions: split(form.rateSessions), kycKinds: split(form.kycKinds),
        ...(money ? { hallmarkCharge: form.hallmarkCharge || "0", oldGoldDeduction: form.oldGoldDeduction || "0", ownPieceDeduction: form.ownPieceDeduction,
          purityDeductions: form.purityDeductions.filter((p) => String(p.deductionPercent).trim() !== "").map((p) => ({ metal: p.metal, purity: p.purity, deductionPercent: p.deductionPercent })),
          oldGoldCashLimit: form.oldGoldCashLimit, cashAlertLevels: split(form.cashAlertLevels), reportingEntity: form.reportingEntity, discountOnMetal: form.discountOnMetal,
          companyNetWorth: form.companyNetWorth, ...(form.companyNetWorth ? { netWorthOn: form.netWorthOn } : {}) } : {}),
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
    <div className="stack">
      <form className="stack" onSubmit={save}>
        <BusinessHeader icon="settings" title="Jewellery settings" description="How the shop's tags are numbered, what a new hallmarked piece is charged for hallmarking, the hallmarking rules the jewellery bill follows, the rate sessions, how old gold is bought, and the rules for cash, KYC and discounts." />
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
          <SectionCard icon="clock" title="Rate sessions" description="Every shop has a morning and an evening rate sheet; name any others the shop sets in a day (up to 8), such as Noon. A bill always takes the latest sheet of its day.">
            <Field label="The shop's own sessions" hint="Commas between them, e.g. Noon, Late evening." wide>
              <input maxLength={400} value={form.rateSessions} onChange={set("rateSessions")} placeholder="e.g. Noon" />
            </Field>
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
            <SectionCard icon="scale" title="Old gold: the buy-back rules" description="Each line of old gold takes its rule's deduction: the shop's own piece (known by its HUID or tag) takes the own-piece deduction, outside jewellery its purity's, or the general one. Another deduction on a line needs a manager's approval and is written in the activity log. A seller does not receive ₹2,00,000 or more in cash for old gold in a day or for one voucher (Income-tax Act 2025, section 186); any lower limit here is the shop's own.">
              <div className="form-grid bz-form">
                <Field label="General deduction (%)" hint="Melting loss or the shop's own rule, for outside jewellery of a purity without its own.">
                  <input type="number" min="0" max="99.99" step="0.01" value={form.oldGoldDeduction} onChange={set("oldGoldDeduction")} />
                </Field>
                <Field label="The shop's own pieces bought back (%)" hint="Empty: they take the outside rules.">
                  <input type="number" min="0" max="99.99" step="0.01" value={form.ownPieceDeduction} onChange={set("ownPieceDeduction")} />
                </Field>
                <Field label="The shop's own cash limit, to one seller in a day (₹)" hint="Empty: none of the shop's own.">
                  <input type="number" min="1" max="199999.99" step="0.01" value={form.oldGoldCashLimit} onChange={set("oldGoldCashLimit")} />
                </Field>
              </div>
              <table className="jw-rates">
                <thead><tr><th scope="col">Purity</th><th scope="col">Deduction on outside jewellery (%)</th></tr></thead>
                <tbody>{form.purityDeductions.map((p) => (
                  <tr key={`${p.metal}:${p.purity}`}>
                    <th scope="row">{p.label}</th>
                    <td><input type="number" min="0" max="99.99" step="0.01" aria-label={`${p.label}: deduction`} placeholder={`General (${form.oldGoldDeduction || "0"}%)`}
                      value={p.deductionPercent} onChange={(e) => setPurity(`${p.metal}:${p.purity}`, e.target.value)} /></td>
                  </tr>
                ))}</tbody>
              </table>
            </SectionCard>
          )}
          {money && (
            <SectionCard icon="reports" title="Cash report" description="The cash report adds up the cash with each person in the rolling month (customers sharing a PAN or a phone number, or in one family group, are one person) and flags ₹10 lakh: a jeweller with cash transactions of ₹10 lakh or more with a customer is a reporting entity under the PMLA.">
              <div className="form-grid bz-form">
                <Field label="The shop's own alert levels (₹)" hint="Below ₹10 lakh, up to 5, commas between them; empty: none. People past one are marked and the bell says so." wide>
                  <input maxLength={100} value={form.cashAlertLevels} onChange={set("cashAlertLevels")} placeholder="e.g. 200000, 500000" />
                </Field>
              </div>
              <label className="checkbox bz-check"><input type="checkbox" checked={form.reportingEntity} onChange={set("reportingEntity")} /> The shop is a reporting entity under the PMLA (registered with FIU-IND)</label>
              {data.reportingEntityAt && <p className="muted small">Last said on {dateTime(data.reportingEntityAt)}. The bell then reminds the shop of each month&apos;s cash transactions report by the 15th.</p>}
            </SectionCard>
          )}
          <SectionCard icon="users" title="KYC documents" description={`The documents the shop accepts to know its customers (up to 20). ${data.kycAadhaar} A customer's documents are kept at least five years after their last transaction.`}>
            <Field label="Documents the shop accepts" hint="Commas between them." wide>
              <input maxLength={1200} value={form.kycKinds} onChange={set("kycKinds")} placeholder="e.g. PAN card, Aadhaar card, Passport, Voter ID, Driving licence" />
            </Field>
          </SectionCard>
          {money && (
            <SectionCard icon="cash" title="Discounts and gold schemes">
              <label className="checkbox bz-check"><input type="checkbox" checked={form.discountOnMetal} onChange={set("discountOnMetal")} /> A discount at the counter may come off the metal&apos;s value too (otherwise only off making and wastage)</label>
              <div className="form-grid bz-form">
                <Field label="The company's net worth (₹)" hint="A company keeps its gold scheme money within 25% of its net worth. Empty: not a company, or not given.">
                  <input type="number" min="1" step="0.01" value={form.companyNetWorth} onChange={set("companyNetWorth")} />
                </Field>
                <Field label="As of (its balance sheet's date)">
                  <input type="date" max={data.today || undefined} value={form.netWorthOn} disabled={!form.companyNetWorth} required={Boolean(form.companyNetWorth)} onChange={set("netWorthOn")} />
                </Field>
              </div>
            </SectionCard>
          )}
        </fieldset>
        {canSave && <div className="form-actions"><button type="submit" className="button" disabled={busy}><Icon name="check" size={16} /> {busy ? "Saving…" : "Save"}</button></div>}
      </form>
      {money && <OffersSection />}
    </div>
  );
}

// The shop's offers on making: a percentage off the making charge of a metal's pieces (or every metal's) between two days.
// The bill gives each piece the best one running on its day. Made and switched off by a manager.
function OffersSection() {
  const biz = useOpenBusiness();
  const [list, setList] = useState(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const canMake = biz.can("jewellery.approve");
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "jewellery/offers", undefined, controller.signal).then(setList).catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id]);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const create = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setList(await businessWrite(biz.id, "jewellery/offers", { requestKey: form.requestKey, name: form.name.trim(), makingPercent: form.makingPercent, metal: form.metal || undefined,
        startsOn: form.startsOn, endsOn: form.endsOn }));
      setForm(null);
      toast.success("Offer made.");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const switchOff = async (offer) => {
    if (busy) return;
    setBusy(true);
    try {
      setList(await businessWrite(biz.id, `jewellery/offers/${offer.id}`, { active: false }, "put"));
      toast.success(`${offer.name} is switched off.`);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SectionCard icon="tag" title="Offers on making" description="A percentage off the making charge, between two days. The jewellery bill gives each piece the best offer running that day for its metal and prints it as such; an offer's terms never change (switch it off and make another)."
      actions={canMake && !form && list && <button type="button" className="button button-secondary" onClick={() => setForm({ requestKey: newKey(), name: "", makingPercent: "", metal: "", startsOn: list.today, endsOn: list.today })}><Icon name="plus" size={15} /> New offer</button>}>
      <ErrorMessage message={error} />
      {form && (
        <form className="form-grid bz-form" onSubmit={create}>
          <Field label="Name"><input required maxLength={80} value={form.name} onChange={set("name")} placeholder="e.g. Dhanteras" /></Field>
          <Field label="Off the making charge (%)"><input required type="number" min="0.01" max="100" step="0.01" value={form.makingPercent} onChange={set("makingPercent")} /></Field>
          <Field label="Metal"><select value={form.metal} onChange={set("metal")}><option value="">Every metal</option>{METALS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></Field>
          <Field label="From"><input required type="date" value={form.startsOn} onChange={set("startsOn")} /></Field>
          <Field label="Until"><input required type="date" min={form.startsOn} value={form.endsOn} onChange={set("endsOn")} /></Field>
          <div className="form-actions field-wide">
            <button type="button" className="button button-secondary" disabled={busy} onClick={() => setForm(null)}>Cancel</button>
            <button type="submit" className="button" disabled={busy}><Icon name="check" size={16} /> {busy ? "Saving…" : "Make the offer"}</button>
          </div>
        </form>
      )}
      {!list ? (!error && <Loading />) : list.items.length === 0 ? <p className="muted">No offers yet.</p> : (
        <table className="jw-rates">
          <thead><tr><th scope="col">Offer</th><th scope="col">Off making</th><th scope="col">Metal</th><th scope="col">Dates</th><th scope="col">Given</th><th scope="col">Action</th></tr></thead>
          <tbody>{list.items.map((o) => (
            <tr key={o.id}>
              <th scope="row">{o.name} {o.running ? <Badge tone="success" label="Running" /> : !o.active ? <Badge tone="neutral" label="Off" /> : null}</th>
              <td>{Number(o.making_percent)}%</td>
              <td>{o.metal_words}</td>
              <td>{dateShort(o.starts_on, { year: true })} – {dateShort(o.ends_on, { year: true })}</td>
              <td>{o.pieces} {o.pieces === 1 ? "piece" : "pieces"} · {biz.exact(o.given)}</td>
              <td>{canMake && o.active && <button type="button" className="button button-secondary button-sm" disabled={busy} onClick={() => switchOff(o)}>Switch off</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </SectionCard>
  );
}
