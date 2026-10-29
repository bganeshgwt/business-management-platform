import { useEffect, useRef, useState } from "react";
import Icon from "@bmp/ui/Icon";
import api, { getErrorMessage } from "../../../../services/api";
import { businessWrite } from "../../../../services/business.service";
import { toast } from "../../../../services/toast";
import { PhotoButton, SignaturePad } from "../../../tasks/pages/parts";
import "../../../tasks/styles/tasks.css";

// The proof of a handover and a return: photos of what goes out and comes
// back and the signatures drawn on the screen by the hirer and the shop
// (private pictures, read only through the API; never a copy of an ID), and
// the scan of each unit's barcode or serial (a keyboard-wedge scanner types
// it and Enter; the server refuses a unit not on the booking).

// A picture added to a booking: fields { bookingId, stage, kind, signer?, lineId? }.
async function uploadRentalFile(biz, fields, file) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) if (value !== undefined && value !== null && value !== "") form.append(name, String(value));
  form.append("file", file);
  return (await api.post(`/businesses/${biz.id}/rentals/files`, form)).data.data;
}

// A booking's picture, read through the API.
export function RentalPicture({ biz, fileId, alt, className = "rnt-picture" }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let gone = false, made = null;
    api.get(`/businesses/${biz.id}/rentals/files/${fileId}`, { responseType: "blob" })
      .then((response) => { if (!gone) { made = URL.createObjectURL(response.data); setUrl(made); } }).catch(() => {});
    return () => { gone = true; if (made) URL.revokeObjectURL(made); };
  }, [biz.id, fileId]);
  return url ? <img src={url} alt={alt} className={className} loading="lazy" /> : <span className={`${className} skeleton`} aria-label="Loading the picture" />;
}

// Photos and both parties' signatures at a handover (stage out) or a return (stage in), added as they are taken.
export function Evidence({ biz, booking, stage }) {
  const [taken, setTaken] = useState([]);
  const [signing, setSigning] = useState(null);
  const add = async (fields, file, words) => {
    const row = await uploadRentalFile(biz, { bookingId: booking.id, stage, ...fields }, file);
    setTaken((all) => [...all, row]);
    toast.success(words);
  };
  const photos = taken.filter((f) => f.kind === "photo").length;
  const signed = taken.filter((f) => f.kind === "signature").map((f) => f.signer);
  return (
    <fieldset className="field-wide rnt-fieldset" aria-label={stage === "out" ? "Photos and signatures of the handover" : "Photos and signatures of the return"}>
      <legend>Photos and signatures</legend>
      <div className="rnt-evidence">
        <PhotoButton label={photos ? `Another photo (${photos})` : "Take a photo"} onUpload={(file) => add({ kind: "photo" }, file, "Photo kept.")} />
        <button type="button" className={`button button-secondary ${signed.includes("hirer") ? "is-done" : ""}`} onClick={() => setSigning("hirer")}>
          <Icon name="edit" size={15} /> {signed.includes("hirer") ? "Hirer signed" : "Hirer signs"}</button>
        <button type="button" className={`button button-secondary ${signed.includes("shop") ? "is-done" : ""}`} onClick={() => setSigning("shop")}>
          <Icon name="edit" size={15} /> {signed.includes("shop") ? "Shop signed" : "Shop signs"}</button>
      </div>
      {signing && (
        <div className="rnt-sign">
          <span className="small">{signing === "hirer" ? "The hirer signs: received in the condition noted" : "The shop signs"}</span>
          <SignaturePad onCancel={() => setSigning(null)} onSave={async (file) => { await add({ kind: "signature", signer: signing }, file, "Signature kept."); setSigning(null); }} />
        </div>
      )}
      <small className="muted field-wide">Photos of what is hired, never of an ID document. Each is kept with the booking and is not changed.</small>
    </fieldset>
  );
}

// A scanner's box: each code read is checked against the booking's units (stage out: any of them; in: those still out).
export function ScanBox({ biz, booking, stage, scanned, onScanned }) {
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState("");
  const input = useRef(null);
  const read = async (event) => {
    event.preventDefault();
    const typed = code.trim();
    if (!typed) return;
    try {
      const hit = await businessWrite(biz.id, `rentals/bookings/${booking.id}/scan`, { code: typed, stage });
      setProblem("");
      onScanned(hit);
    } catch (err) {
      setProblem(getErrorMessage(err));
    } finally {
      setCode("");
      input.current?.focus();
    }
  };
  return (
    <div className="field-wide rnt-scan">
      <label className="field">
        <span>Scan a unit's barcode or type its number</span>
        <input ref={input} className="mono" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") read(e); }} autoComplete="off" />
      </label>
      <button type="button" className="button button-secondary" onClick={read}>Check</button>
      {problem && <p className="bz-due small" role="alert">{problem}</p>}
      {scanned.length > 0 && <p className="small muted">Scanned: {scanned.map((s) => s.unitLabel).join(", ")}</p>}
    </div>
  );
}

// A line's checklist (its class's points): each as it should be, or what is wrong.
export function Checklist({ points, value, onChange }) {
  const set = (point, change) => onChange(value.map((x) => (x.point === point ? { ...x, ...change } : x)));
  return (
    <div className="field-wide rnt-checklist" role="group" aria-label="Checklist">
      {value.map((x) => (
        <div key={x.point} className="rnt-check">
          <label className="checkbox bz-check"><input type="checkbox" checked={x.ok} onChange={(e) => set(x.point, { ok: e.target.checked })} /> {x.point}</label>
          {!x.ok && <input aria-label={`What is wrong: ${x.point}`} required maxLength={200} value={x.note} onChange={(e) => set(x.point, { note: e.target.value })} placeholder="What is wrong" />}
        </div>
      ))}
      {!points.length && <span className="muted small">No checklist</span>}
    </div>
  );
}
