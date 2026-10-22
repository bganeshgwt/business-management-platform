import { useEffect, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import FormDialog from "../../core/pages/FormDialog";
import { Field } from "../../core/pages/ui";
import { businessToday, newKey, useOpenBusiness } from "../../core/pages/hooks";
import { inPacks } from "./tradeFormat";
import { emptyTransport, printChallan, transportBody } from "./deliveryFormat";

// Getting goods to the shop (pro pass D-04, D-05, D-10): transport and
// e-way bill details, marking a delivery, goods that came back in the van,
// the load sheet of a run and the invoices printed together.

// The transport block shared by a dispatch, a run and a later e-way bill entry.
export function TransportFields({ form, set, eway = true, compact = false }) {
  return (
    <>
      <Field label="Vehicle number (optional)"><input maxLength={20} value={form.vehicleNo} onChange={set("vehicleNo")} placeholder="MH12 AB 1234" /></Field>
      <Field label="Driver (optional)"><input maxLength={100} value={form.driverName} onChange={set("driverName")} /></Field>
      <Field label="Helper (optional)"><input maxLength={100} value={form.helperName} onChange={set("helperName")} /></Field>
      {!compact && <Field label="Transporter (optional)"><input maxLength={150} value={form.transporterName} onChange={set("transporterName")} placeholder="Own vehicle, or the transport company" /></Field>}
      {!compact && <Field label="Transporter GSTIN / ID (optional)"><input maxLength={15} value={form.transporterId} onChange={set("transporterId")} /></Field>}
      {!compact && <Field label="LR / docket no. (optional)"><input maxLength={50} value={form.lrNo} onChange={set("lrNo")} /></Field>}
      {eway && (
        <>
          <Field label="E-way bill no. (optional)" hint="Needed when the goods are worth more than ₹50,000. 12 digits."><input inputMode="numeric" maxLength={14} value={form.ewayBillNo} onChange={set("ewayBillNo")} /></Field>
          <Field label="E-way bill date"><input type="date" value={form.ewayBillDate} onChange={set("ewayBillDate")} /></Field>
          <Field label="Distance (km, optional)"><input type="number" min="0" max="4000" step="1" value={form.distanceKm} onChange={set("distanceKm")} /></Field>
        </>
      )}
    </>
  );
}
// Fill in the e-way bill and transport after the dispatch.
export function TransportDialog({ dispatch, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState(() => ({ ...emptyTransport(dispatch), ewayBillDate: dispatch.eway_bill_date || businessToday(biz.business.timezone) }));
  const set = (name) => (event) => setForm((f) => ({ ...f, [name]: event.target.value }));
  return (
    <FormDialog title={`Transport · ${dispatch.document_no}`} icon="truck" width={760} submitLabel="Save" onClose={onClose} onSaved={onSaved}
      successMessage="Transport details saved" description="These print on the tax invoice. Generate the e-way bill on the GST portal, then enter its number here."
      onSubmit={() => businessWrite(biz.id, `dispatches/${dispatch.id}/transport`, { ...transportBody(form), ...(form.ewayBillNo ? {} : { ewayBillDate: undefined }) }, "patch")}>
      <TransportFields form={form} set={set} />
    </FormDialog>
  );
}

// The delivery challan (round 2): check the transporter, vehicle, LR and
// e-way bill (typed in by hand) for this dispatch, then print the A4
// challan. Someone who may not change transport prints it as it is.
export function ChallanDialog({ dispatch, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const canEdit = biz.can("sales_orders.approve");
  const [form, setForm] = useState(() => ({ ...emptyTransport(dispatch), ewayBillDate: dispatch.eway_bill_date || (dispatch.eway_bill_no ? "" : businessToday(biz.business.timezone)) }));
  const set = (name) => (event) => setForm((f) => ({ ...f, [name]: event.target.value }));
  const submit = async () => {
    if (canEdit) await businessWrite(biz.id, `dispatches/${dispatch.id}/transport`, { ...transportBody(form), ...(form.ewayBillNo ? {} : { ewayBillDate: undefined }) }, "patch");
    const challan = await businessWrite(biz.id, `dispatches/${dispatch.id}/challan`, {});
    printChallan(challan, biz);
    return challan;
  };
  return (
    <FormDialog title={`Delivery challan · ${dispatch.challan_no || dispatch.document_no}`} icon="truck" width={760} submitLabel={canEdit ? "Save and print challan" : "Print challan"}
      onClose={onClose} onSaved={onSaved} onSubmit={submit} successMessage={(c) => `Challan ${c.challan_no} ready to print`}
      description={`${dispatch.contact_name} · invoice ${dispatch.document_no}. The challan travels with the goods; it prints these transport details. Generate the e-way bill on the GST portal and type its number here.`}>
      {canEdit ? <TransportFields form={form} set={set} /> : <p className="field-wide muted">The challan prints the transport details already saved on this dispatch.</p>}
    </FormDialog>
  );
}

// Delivered, part returned (some lines came back) or refused (all came back).
export function DeliveryDialog({ dispatch, initial = "delivered", onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [requestKey] = useState(newKey);
  const [status, setStatus] = useState(initial);
  const [form, setForm] = useState({ receivedBy: "", note: "" });
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState("");
  const [back, setBack] = useState({});
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, `documents/${dispatch.document_id}`, undefined, controller.signal).then(setDoc)
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, dispatch.document_id]);
  const canReturn = biz.can("sales.refund");
  const set = (name) => (event) => setForm((f) => ({ ...f, [name]: event.target.value }));
  const submit = () => businessWrite(biz.id, `dispatches/${dispatch.id}/delivery`, {
    status, receivedBy: form.receivedBy || undefined, note: form.note || undefined,
    ...(status !== "delivered" ? { requestKey } : {}),
    ...(status === "part_returned" ? { returns: Object.entries(back).filter(([, v]) => Number(v) > 0).map(([id, quantity]) => ({ documentLineId: Number(id), quantity })) } : {}),
  });
  return (
    <FormDialog title={`Delivery · ${dispatch.document_no}`} icon="truck" width={760} onClose={onClose} onSaved={onSaved} onSubmit={submit}
      submitLabel={{ delivered: "Mark delivered", part_returned: "Take back and mark", refused: "Mark refused" }[status]}
      successMessage={(r) => (r.return ? `Goods back in stock · credit note ${r.return.return_no}` : "Marked delivered")}
      description={`${dispatch.contact_name} · ${biz.exact(dispatch.total)}. Goods that come back go back into stock and the invoice is credited; take a new order if the shop still wants them.`}>
      {error && <div className="field-wide"><ErrorMessage message={error} /></div>}
      <Field label="What happened" wide>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="delivered">Delivered in full</option>
          {canReturn && <option value="part_returned">Some goods came back in the van</option>}
          {canReturn && <option value="refused">Refused — everything came back</option>}
        </select>
      </Field>
      {status === "delivered" && <Field label="Received by (optional)" wide><input maxLength={100} value={form.receivedBy} onChange={set("receivedBy")} placeholder="Who signed at the shop" /></Field>}
      {status === "part_returned" && (
        <div className="field-wide bz-lines">
          {!doc ? <Loading /> : (
            <DataGrid variant="editor" caption="Came back" rows={doc.lines} rowKey={(l) => l.id} columns={[
              { key: "label", header: "Item", value: (l) => l.label },
              { key: "sent", header: "Sent", value: (l) => Number(l.quantity), render: (l) => inPacks(l.quantity, l.unit, l.entered_unit, l.unit_factor) },
              { key: "back", header: `Came back (${doc.lines[0]?.unit || "units"})`, render: (l, ctx) => (
                <input aria-label={ctx.label} type="number" min="0" max={Number(l.quantity) - Number(l.returned_quantity)} step="1" value={back[l.id] || ""} onChange={(e) => setBack((b) => ({ ...b, [l.id]: e.target.value }))} />
              ) },
            ]} />
          )}
        </div>
      )}
      {status !== "delivered" && <Field label="Why" wide><input required maxLength={300} value={form.note} onChange={set("note")} placeholder="e.g. Shop closed, damaged case, wrong item" /></Field>}
    </FormDialog>
  );
}

