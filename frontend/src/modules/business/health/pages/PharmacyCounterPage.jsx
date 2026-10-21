import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import SidePanel from "../../../../components/SidePanel";
import { ErrorMessage } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { businessPath } from "../../../../services/businessNav";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "../../../../services/format";
import { toast } from "../../../../services/toast";
import { printTaxInvoice } from "../../core/pages/invoice";
import { BusinessHeader, Field } from "../../core/pages/ui";
import { businessToday, newKey, quantity, useDirtyGuard, useOpenBusiness } from "../../core/pages/hooks";
import useAuth from "../../../../hooks/useAuth";
import { BillerButton, BillerDialog } from "../../retail/pages/counterPay";
import { PART_KINDS, takeCarry, writeCarry } from "../../retail/pages/counterPayState";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import { ScheduleBadge, SignOff } from "./healthParts";
import { RX_SCHEDULES, SIGNED_SCHEDULES, uploadPrescriptionFile, useSignatories } from "./healthFormat";
import "../styles/health.css";

// The pharmacy counter: medicines found by name, salt or maker; sold by the
// strip or (where the drug master allows) by the tablet; batches taken first
// to expire first on the server (never a recalled one); substitutes with the
// same salt and strength one click away. A Schedule H / H1 / X medicine needs
// the prescription (doctor, registration number, date, a photo or scan); a
// Schedule X one also the registered pharmacist's PIN. H1 and X lines are
// written to their registers with the bill.
const emptyRx = { patientName: "", patientPhone: "", patientAge: "", patientAddress: "", doctorName: "", doctorRegNo: "", doctorAddress: "", prescribedOn: "" };

export default function PharmacyCounterPage() {
  const biz = useOpenBusiness();
  const { switchUser } = useAuth();
  // The bill being built survives a switch of biller (Quick bill's rule).
  const [carried] = useState(() => takeCarry(`${biz.id}-rx`));
  const counters = biz.locations.filter((l) => l.active && l.sells_at_counter !== false);
  const [locationId, setLocationId] = useState(String(counters[0]?.id || biz.locations[0]?.id || ""));
  const [lines, setLines] = useState(() => carried?.lines || []);
  const [rx, setRx] = useState(() => carried?.rx || { ...emptyRx, prescribedOn: businessToday(biz.business.timezone) });
  const [askPin, setAskPin] = useState(null);
  const pinEveryBill = Boolean(biz.settings?.counter_pin_every_bill);
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [signoff, setSignoff] = useState({});
  // One payment method for the bill.
  const [method, setMethod] = useState("cash");
  const methods = usePaymentMethods();
  const payButtons = methods.options(PART_KINDS).map((m) => [m.key, m.name]);
  const chosen = methods.resolve(method, PART_KINDS);
  // One key per bill: a retry after a lost reply is the same bill.
  const [requestKey, setRequestKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [last, setLast] = useState(null);
  const [subsFor, setSubsFor] = useState(null);
  const pharmacists = useSignatories(biz.id, "pharmacist");
  useDirtyGuard(lines.length > 0);

  const needsRx = lines.some((l) => RX_SCHEDULES.includes(l.drug.schedule));
  const needsSign = lines.some((l) => SIGNED_SCHEDULES.includes(l.drug.schedule));
  const estimate = lines.reduce((s, l) => s + Number(l.drug.price || 0) * Number(l.quantity || 0) * (l.unit === l.drug.unit ? 1 : Number(l.drug.packs.find((p) => p.unit_code === l.unit)?.quantity_in_base || 1)), 0);

  async function addDrug(found) {
    if (!found) return;
    try {
      const drug = await businessRead(biz.id, `pharmacy/drugs/${found.id}`);
      const strip = drug.packs.find((p) => p.unit_code === "strip");
      const unit = strip && drug.unit !== "strip" ? "strip" : drug.unit;
      setLines((all) => [...all, { key: newKey(), drug, unit, quantity: "1" }]);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }
  const setLine = (key, patch) => setLines((all) => all.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const swap = async (line, substitute) => {
    const drug = await businessRead(biz.id, `pharmacy/drugs/${substitute.id}`);
    const strip = drug.packs.find((p) => p.unit_code === "strip");
    setLines((all) => all.map((l) => (l.key === line.key ? { ...l, drug, unit: strip && drug.unit !== "strip" ? "strip" : drug.unit } : l)));
    setSubsFor(null);
    toast.success(`${line.drug.label} swapped for ${drug.label}`);
  };

  async function attach(event) {
    const chosen = event.target.files?.[0];
    if (!chosen) return;
    setUploading(true);
    try {
      const saved = await uploadPrescriptionFile(biz.id, chosen);
      setFile(saved);
      toast.success("Prescription attached");
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  }

  // The server works out the exact total for the selected method.
  function payBody() {
    return { payment: { amount: "full", ...methods.body(method, PART_KINDS) } };
  }
  async function sell(event, pin = null) {
    event?.preventDefault();
    // The biller's PIN for every bill, when the business asks for it.
    if (pinEveryBill && !pin) { setAskPin({ error: "" }); return; }
    setBusy(true); setError("");
    const body = {
      requestKey, locationId: Number(locationId), channel: "counter", ...(pin ? { counterPin: pin } : {}), ...payBody(),
      lines: lines.map((l) => ({ skuId: l.drug.id, quantity: String(l.quantity), ...(l.unit !== l.drug.unit ? { unit: l.unit } : {}) })),
      ...(needsRx ? { prescription: { ...rx, patientAge: rx.patientAge === "" ? null : Number(rx.patientAge), fileId: file?.id || null } } : {}),
      ...(needsSign ? { signoff: { signatoryId: Number(signoff.signatoryId), pin: signoff.pin } } : {}),
    };
    try {
      const result = await businessWrite(biz.id, "pharmacy/sales", body);
      setAskPin(null);
      setLast(result);
      setLines([]); setRx({ ...emptyRx, prescribedOn: businessToday(biz.business.timezone) }); setFile(null); setSignoff({});
      setRequestKey(newKey());
      toast.success(`Bill ${result.document.document_no} saved${result.registers?.length ? ` · ${result.registers.length} register entr${result.registers.length === 1 ? "y" : "ies"}` : ""}`,
        { action: { label: "Print", onClick: () => printBill(result.document.id) } });
    } catch (err) {
      const reason = err?.response?.data?.data?.reason;
      if (reason === "pin_required" || (pin && ["wrong_pin", "pin_locked", "too_many_attempts", "no_pin"].includes(reason))) setAskPin((was) => ({ error: getErrorMessage(err), n: (was?.n || 0) + 1 }));
      else { setAskPin(null); setError(getErrorMessage(err)); }
    } finally {
      setBusy(false);
    }
  }
  function switched(session) {
    if (lines.length) writeCarry(`${biz.id}-rx`, { lines, rx });
    toast.success(`${session.user.name} is billing now`);
    switchUser(session);
  }
  async function printBill(documentId, paper = "80mm") {
    try { printTaxInvoice(await businessRead(biz.id, `documents/${documentId}`), biz, { paper }); } catch (err) { toast.error(getErrorMessage(err)); }
  }

  const columns = useMemo(() => [
    { key: "item", header: "Medicine", value: (l) => l.drug.label, mobile: "title", render: (l) => (
      <span className="bz-two-line"><strong>{l.drug.label}</strong>
        <small className="muted">{[l.drug.composition, l.drug.strength, l.drug.manufacturer].filter(Boolean).join(" · ") || "No drug details yet"}{l.drug.cold_chain ? " · Cold chain" : ""}</small></span>) },
    { key: "schedule", header: "Schedule", value: (l) => l.drug.schedule || "", render: (l) => <ScheduleBadge schedule={l.drug.schedule || "unset"} />, mobile: "subtitle" },
    { key: "unit", header: "Sold by", value: (l) => l.unit, render: (l, ctx) => (
      <select aria-label={ctx.label} value={l.unit} onChange={(e) => setLine(l.key, { unit: e.target.value })}>
        {l.drug.unit !== "strip" && l.drug.packs.some((p) => p.unit_code === "strip") && <option value="strip">Strip of {Number(l.drug.packs.find((p) => p.unit_code === "strip").quantity_in_base)}</option>}
        {(l.drug.loose_sale || !l.drug.packs.some((p) => p.unit_code === "strip") || l.drug.unit === "strip") && <option value={l.drug.unit}>{l.drug.unit === "tablet" ? "Loose tablet" : l.drug.unit}</option>}
        {l.drug.packs.filter((p) => !["strip"].includes(p.unit_code)).map((p) => <option key={p.unit_code} value={p.unit_code}>{p.unit_code} of {Number(p.quantity_in_base)}</option>)}
      </select>) },
    { key: "quantity", header: "Qty", type: "number", value: (l) => Number(l.quantity), render: (l, ctx) => (
      <input aria-label={ctx.label} className="hl-qty" type="number" min="1" step="1" required value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} />) },
    { key: "batch", header: "Batch (first to expire)", value: (l) => l.drug.lots[0]?.lot_code || "", render: (l) => (l.drug.lots.length
      ? <span className="bz-two-line"><span className="mono">{l.drug.lots[0].lot_code}</span><small className="muted">Exp {dateShort(l.drug.lots[0].expires_on, { year: true })} · {quantity(l.drug.lots.reduce((s, x) => s + Number(x.quantity), 0), l.drug.unit)} usable</small></span>
      : <span className="bz-minus">No usable stock</span>) },
    { key: "price", header: "MRP", type: "money", exact: true, value: (l) => Number(l.drug.price) },
    { key: "actions", header: "", label: "Actions", type: "actions", render: (l) => (
      <span className="bz-inline">
        {l.drug.substitutes?.length > 0 && <button type="button" className="chip-button" onClick={() => setSubsFor(l)}>{l.drug.substitutes.length} substitute{l.drug.substitutes.length === 1 ? "" : "s"}</button>}
        <button type="button" className="link-button danger" onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}>Remove</button>
      </span>) },
  ], []);

  const setR = (key) => (e) => setRx((r) => ({ ...r, [key]: e.target.value }));
  return (
    <div className="stack">
      <BusinessHeader icon="heart" title="Prescription sale"
        description="Find a medicine by name or salt. Prescription medicines need the doctor's prescription; Schedule X also the pharmacist's PIN. Batches go first-to-expire."
        secondary={<span className="bz-inline">
          {biz.can("sales.create") && <BillerButton biz={biz} onSwitch={switched} />}
          <Link className="button button-secondary" to={businessPath(biz.id, "counter")}><Icon name="receipt" size={15} /> Quick bill (OTC)</Link>
        </span>} />
      <form className="stack" onSubmit={sell}>
        <SectionCard icon="search" title="Medicines" flush
          actions={counters.length > 1 && (
            <label className="field hl-inline-field"><span>Counter</span>
              <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>{counters.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
            </label>)}>
          <div className="hl-picker">
            <SearchPicker aria-label="Add a medicine" placeholder="Medicine, salt or maker — e.g. paracetamol" minChars={2} clearOnSelect onChange={addDrug}
              search={(q, { signal }) => businessRead(biz.id, "pharmacy/drugs", { q, limit: 20, active: "true" }, signal).then((r) => r.items)}
              getKey={(d) => d.id} getLabel={(d) => d.label}
              getDescription={(d) => [d.composition && `${d.composition}${d.strength ? ` ${d.strength}` : ""}`, d.schedule !== "none" && d.schedule !== "unset" ? `Sch. ${d.schedule}` : "OTC",
                `${quantity(d.stock, d.unit)} in stock`, d.substitutes ? `${d.substitutes} substitute${d.substitutes === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")}
              isDisabled={(d) => Number(d.stock) <= 0} emptyText="No medicine by that name or salt" />
          </div>
          <DataGrid id="pharmacy-counter-lines" caption="Medicines on this bill" variant="editor" rows={lines} rowKey={(l) => l.key} columns={columns}
            empty="Nothing on the bill yet" emptyHint="Search above; scan works too." emptyIcon="heart" pageSize={false} />
          {lines.length > 0 && <p className="hl-estimate">Estimate at MRP: <strong>{biz.exact(estimate)}</strong> <span className="muted">(the bill works out offers, GST and round-off)</span></p>}
        </SectionCard>
        {needsRx && (
          <SectionCard icon="file" title="Prescription" description="Rule 65: the prescriber's name and registration number, the patient and the date. H1 and Schedule X lines go into their registers with this.">
            <div className="form-grid">
              <Field label="Patient name"><input required maxLength={150} value={rx.patientName} onChange={setR("patientName")} /></Field>
              <Field label="Patient phone" hint="Used to reach them if a batch is recalled."><input type="tel" maxLength={30} value={rx.patientPhone} onChange={setR("patientPhone")} /></Field>
              <Field label="Age (years)"><input type="number" min="0" max="130" value={rx.patientAge} onChange={setR("patientAge")} /></Field>
              <Field label="Patient address"><input maxLength={300} value={rx.patientAddress} onChange={setR("patientAddress")} /></Field>
              <Field label="Doctor's name"><input required maxLength={150} value={rx.doctorName} onChange={setR("doctorName")} /></Field>
              <Field label="Doctor's registration no."><input required maxLength={60} value={rx.doctorRegNo} onChange={setR("doctorRegNo")} placeholder="e.g. TNMC 48213" /></Field>
              <Field label="Doctor's clinic / address"><input maxLength={300} value={rx.doctorAddress} onChange={setR("doctorAddress")} /></Field>
              <Field label="Prescription date"><input required type="date" max={businessToday(biz.business.timezone)} value={rx.prescribedOn} onChange={setR("prescribedOn")} /></Field>
              <div className="field field-wide">
                <span>Photo or scan of the prescription</span>
                <div className="bz-inline">
                  <label className="button button-secondary hl-file"><Icon name="upload" size={15} /> {file ? "Replace" : "Take photo / choose file"}
                    <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment" onChange={attach} disabled={uploading} />
                  </label>
                  {uploading ? <span className="muted">Uploading…</span> : file ? <span className="hl-ok"><Icon name="check" size={14} /> {file.file_name}</span> : <span className="muted">JPG, PNG, WebP or PDF up to 5 MB. Kept privately.</span>}
                </div>
              </div>
            </div>
          </SectionCard>
        )}
        {needsSign && (
          <SectionCard icon="shield" title="Pharmacist sign-off (Schedule X)" description="The registered pharmacist checks the prescription and signs with their PIN.">
            <div className="form-grid"><SignOff kind="pharmacist" signatories={pharmacists} value={signoff} onChange={setSignoff} /></div>
          </SectionCard>
        )}
        <ErrorMessage message={error} />
        <div className="hl-paybar">
          <div className="segmented" role="group" aria-label="Paid by">
            {payButtons.map(([value, label]) => <button key={value} type="button" className={`segment ${chosen === value ? "is-active" : ""}`} aria-pressed={chosen === value} onClick={() => setMethod(value)}>{label}</button>)}
          </div>
          <button type="submit" className="button" disabled={busy || !lines.length || uploading}>{busy ? "Saving…" : "Save bill"}</button>
        </div>
      </form>
      {last && (
        <SectionCard icon="check" title={`Last bill ${last.document.document_no}`} description={`${biz.exact(last.document.total)}${last.prescription ? ` · prescription of ${last.prescription.doctor_name}` : ""}`}
          actions={<span className="bz-inline"><button type="button" className="button button-secondary" onClick={() => printBill(last.document.id)}><Icon name="print" size={15} /> Print 80 mm</button>
            <button type="button" className="button button-secondary" onClick={() => printBill(last.document.id, "a4")}>A4</button></span>} />
      )}
      {askPin && <BillerDialog key={askPin.n || 0} biz={biz} mode="confirm" error={askPin.error} onClose={() => setAskPin(null)} onConfirm={(pin) => sell(null, pin)} onSwitched={switched} />}
      <SidePanel open={Boolean(subsFor)} title={subsFor ? `Substitutes for ${subsFor.drug.label}` : ""} count={subsFor?.drug.substitutes.length} icon="layers"
        rule="Same salt and strength; cheapest in stock first." onClose={() => setSubsFor(null)}>
        {subsFor && (
          <DataGrid id="pharmacy-substitutes" caption="Substitutes" rows={subsFor.drug.substitutes} variant="compact" columns={[
            { key: "label", header: "Medicine", value: (d) => d.label, mobile: "title", render: (d) => <span className="bz-two-line"><strong>{d.label}</strong><small className="muted">{d.manufacturer || ""}</small></span> },
            { key: "price", header: "MRP", type: "money", exact: true, value: (d) => Number(d.price) },
            { key: "stock", header: "Usable stock", type: "number", value: (d) => Number(d.usable_stock), render: (d) => quantity(d.usable_stock, d.unit) },
            { key: "actions", header: "", label: "Actions", type: "actions", render: (d) => <button type="button" className="chip-button" disabled={Number(d.usable_stock) <= 0} onClick={() => swap(subsFor, d)}>Use this</button> },
          ]} empty="No substitutes in stock" />
        )}
      </SidePanel>
    </div>
  );
}
