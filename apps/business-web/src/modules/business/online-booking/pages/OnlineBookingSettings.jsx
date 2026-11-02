import { useEffect, useState } from "react";
import QRCode from "qrcode";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, ScreenLoading } from "../../../../components/Feedback";
import { businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import { confirmAction } from "../../../../services/confirm";
import { escapeHtml, printDocument } from "../../../../services/print";
import { Field } from "../../core/pages/ui";
import { useOpenBusiness } from "../../core/pages/hooks";
import { POSTER_STYLES, linkAddress, peopleWord, posterHtml, shareText } from "./onlineBooking";

// Online booking › Booking link: each location's link (its QR poster to
// print, the text to share, a new link that stops the old one), its rules
// and what shows online. Changing them needs online_appointments.manage.

const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

export default function OnlineBookingSettings({ overview, onChanged }) {
  const biz = useOpenBusiness();
  if (!overview) return <ScreenLoading />;
  return (
    <div className="stack">
      {overview.locations.map((place) => (
        <LocationLink key={place.location.id} place={place} overview={overview} canManage={overview.canManage} onChanged={onChanged} business={biz} />
      ))}
    </div>
  );
}

function LocationLink({ place, overview, canManage, onChanged, business: biz }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const link = place.link;
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      await businessWrite(biz.id, "online-booking/links", { locationId: place.location.id });
      toast.success(`${place.location.name} has its booking link.`);
      onChanged();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (!link) {
    return (
      <SectionCard icon="link" title={`Online booking at ${place.location.name}`} description="Guests book from a link of your own: on WhatsApp, Instagram, Google or a QR at the counter.">
        <ErrorMessage message={error} />
        <Notes notes={place.notes} />
        {canManage ? <button type="button" className="button" onClick={create} disabled={busy}><Icon name="plus" size={15} /> Make the booking link</button>
          : <p className="muted">Ask the owner or a manager to set up online booking.</p>}
      </SectionCard>
    );
  }
  return (
    <>
      <ShareCard place={place} link={link} canManage={canManage} onChanged={onChanged} />
      <Notes notes={place.notes} />
      {/* Keyed on what was saved, so a save (here or at another desk) shows afresh. */}
      <RulesCard key={`rules-${link.updatedAt}`} link={link} kind={overview.kind} depositPercent={overview.depositPercent} canManage={canManage} onChanged={onChanged} />
      <ShownCard key={`shown-${JSON.stringify([place.services.map((s) => [s.id, s.shown, s.minutes]), place.people.map((p) => [p.id, p.shown])])}`}
        place={place} link={link} kind={overview.kind} canManage={canManage} onChanged={onChanged} />
    </>
  );
}

function Notes({ notes }) {
  if (!notes?.length) return null;
  return (
    <ul className="ob-notes" aria-label="To look at">
      {notes.map((note) => (
        <li key={note.text} className={`ob-note-line is-${note.level}`}><Icon name={note.level === "warning" ? "alert" : "info"} size={15} /> {note.text}</li>
      ))}
    </ul>
  );
}

function ShareCard({ place, link, canManage, onChanged }) {
  const biz = useOpenBusiness();
  const url = linkAddress(link);
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(url, { width: 480, margin: 1, errorCorrectionLevel: "M" }).then((image) => { if (alive) setQr(image); }).catch(() => setQr(""));
    return () => { alive = false; };
  }, [url]);
  const name = biz.settings?.display_name || biz.business.name;
  const share = shareText(name, biz.type, url);
  const toggle = async () => {
    setBusy(true);
    try {
      await businessWrite(biz.id, `online-booking/links/${link.id}`, { enabled: !link.enabled }, "patch");
      toast.success(link.enabled ? "Online booking is switched off: the link tells guests to call you." : "Taking bookings online again.");
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const replace = async () => {
    if (!(await confirmAction({ title: "Make a new booking link?", message: "The old link, and every QR printed with it, stops working at once. Share and print the new one.", confirmLabel: "Make a new link" }))) return;
    try {
      await businessWrite(biz.id, `online-booking/links/${link.id}/new-link`, {});
      toast.success("New link made. Print the new QR and share the new link.");
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };
  const poster = () => printDocument({ title: `Booking QR - ${name}`, styles: POSTER_STYLES,
    body: posterHtml({ name, logoUrl: biz.settings?.logo_path || "", qr, url, place: place.location.name !== name ? place.location.name : "", type: biz.type, escape: escapeHtml }) });
  return (
    <SectionCard icon="link" title={`Booking link · ${place.location.name}`}
      description="Share it on WhatsApp, Instagram, Google or your website, or print the QR for the counter."
      actions={<span className={`ob-state ${link.enabled ? "is-on" : "is-off"}`}><span className="ob-state-dot" aria-hidden="true" />{link.enabled ? "Taking bookings" : "Switched off"}</span>}>
      <div className="ob-share">
        <div className="ob-share-main">
          <label className="field">
            <span>Booking link</span>
            <span className="ob-link-row">
              <input readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Booking link" />
              <button type="button" className="button button-secondary" onClick={() => copyText(url).then(setCopied)}><Icon name={copied ? "check" : "copy"} size={15} /> {copied ? "Copied" : "Copy"}</button>
              <a className="button button-secondary" href={url} target="_blank" rel="noreferrer"><Icon name="external" size={15} /> Open</a>
            </span>
          </label>
          <div className="ob-share-text">
            <span className="muted small">Ready to share</span>
            <p>{share}</p>
            <span className="ob-share-actions">
              <a className="button button-secondary button-sm" href={`https://wa.me/?text=${encodeURIComponent(share)}`} target="_blank" rel="noreferrer"><Icon name="message" size={14} /> Share on WhatsApp</a>
              <button type="button" className="button button-ghost button-sm" onClick={() => copyText(share).then((ok) => ok && toast.success("Copied"))}><Icon name="copy" size={14} /> Copy text</button>
            </span>
          </div>
          {canManage && (
            <div className="ob-share-manage">
              <button type="button" className={`button ${link.enabled ? "button-secondary" : ""}`} onClick={toggle} disabled={busy}>
                <Icon name={link.enabled ? "x-circle" : "check-circle"} size={15} /> {link.enabled ? "Stop taking bookings online" : "Take bookings online"}
              </button>
              <button type="button" className="link-button" onClick={replace}>Make a new link (the old one stops working)</button>
            </div>
          )}
        </div>
        <figure className="ob-qr">
          {qr ? <img src={qr} alt={`QR code for the ${place.location.name} booking link`} /> : <span className="ob-qr-blank" />}
          <figcaption>
            {qr && <button type="button" className="button button-secondary button-sm" onClick={poster}><Icon name="print" size={14} /> Print the A5 poster</button>}
            {qr && <a className="small" href={qr} download={`booking-link-${place.location.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`}><Icon name="download" size={13} /> Download QR</a>}
          </figcaption>
        </figure>
      </div>
    </SectionCard>
  );
}

const NOTICES = [[0, "No notice"], [30, "30 minutes"], [60, "1 hour"], [120, "2 hours"], [240, "4 hours"], [720, "12 hours"], [1440, "A day"]];

function RulesCard({ link, kind, depositPercent, canManage, onChanged }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState(() => ({ ...link, upiId: link.upiId || "", upiPayee: link.upiPayee || "", guestNote: link.guestNote || "" }));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const number = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value === "" ? "" : Number(e.target.value) }));
  const disabled = !canManage || busy;
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await businessWrite(biz.id, `online-booking/links/${link.id}`, {
        confirmMode: form.confirmMode, daysAhead: form.daysAhead, minNoticeMinutes: form.minNoticeMinutes, slotStepMinutes: form.slotStepMinutes, cancelHours: form.cancelHours,
        maxChanges: form.maxChanges, maxOpenPerMobile: form.maxOpenPerMobile, showPrices: form.showPrices, allowAnyStaff: form.allowAnyStaff,
        confirmAfterNoShows: form.confirmAfterNoShows, requestExpiryHours: form.requestExpiryHours, guestNote: form.guestNote,
        ...(kind === "clinic" ? { onlineSharePercent: form.onlineSharePercent } : {}),
        ...(kind === "salon" ? { upiAdvance: form.upiAdvance, upiId: form.upiId, upiPayee: form.upiPayee } : {}),
      }, "patch");
      toast.success("Online booking rules saved.");
      onChanged();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <SectionCard as="form" icon="sliders" title="Booking rules" description="How guests book: at once or as a request, how far ahead, and what they may change themselves." onSubmit={save}>
      <ErrorMessage message={error} />
      {!canManage && <p className="muted small">Only the owner or a manager changes these.</p>}
      <fieldset className="ob-mode" disabled={disabled}>
        <legend>When a guest books a free time</legend>
        <label className={`ob-mode-choice ${form.confirmMode === "instant" ? "is-on" : ""}`}>
          <input type="radio" name="confirmMode" value="instant" checked={form.confirmMode === "instant"} onChange={set("confirmMode")} />
          <span><strong>Book it at once</strong><small className="muted">It goes straight onto the calendar.</small></span>
        </label>
        <label className={`ob-mode-choice ${form.confirmMode === "confirm" ? "is-on" : ""}`}>
          <input type="radio" name="confirmMode" value="confirm" checked={form.confirmMode === "confirm"} onChange={set("confirmMode")} />
          <span><strong>I confirm each one</strong><small className="muted">It waits as a request, holding its time, until you accept or decline it.</small></span>
        </label>
      </fieldset>
      <div className="form-grid">
        <Field label="Days guests can book ahead"><input type="number" min="1" max="90" required value={form.daysAhead} onChange={number("daysAhead")} disabled={disabled} /></Field>
        <Field label="Notice before a booking"><select value={form.minNoticeMinutes} onChange={number("minNoticeMinutes")} disabled={disabled}>
          {NOTICES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        {kind !== "clinic" && <Field label="Times every"><select value={form.slotStepMinutes} onChange={number("slotStepMinutes")} disabled={disabled}>
          {[10, 15, 20, 30, 60].map((m) => <option key={m} value={m}>{m} minutes</option>)}</select></Field>}
        <Field label="Hours to answer a request" hint="Never later than the booking's own time"><input type="number" min="1" max="72" required value={form.requestExpiryHours} onChange={number("requestExpiryHours")} disabled={disabled} /></Field>
        <Field label="Guests cancel or change online until" hint="Hours before the booking; after that they call you"><input type="number" min="0" max="168" required value={form.cancelHours} onChange={number("cancelHours")} disabled={disabled} /></Field>
        <Field label="Changes online per booking"><input type="number" min="0" max="5" required value={form.maxChanges} onChange={number("maxChanges")} disabled={disabled} /></Field>
        <Field label="Bookings one mobile may hold"><input type="number" min="1" max="10" required value={form.maxOpenPerMobile} onChange={number("maxOpenPerMobile")} disabled={disabled} /></Field>
        <Field label="No-shows in 90 days before you confirm" hint="0: never"><input type="number" min="0" max="10" required value={form.confirmAfterNoShows} onChange={number("confirmAfterNoShows")} disabled={disabled} /></Field>
        {kind === "clinic" && <Field label="Share of each OPD session booked online (%)" hint="The rest stays for walk-ins"><input type="number" min="10" max="100" required value={form.onlineSharePercent} onChange={number("onlineSharePercent")} disabled={disabled} /></Field>}
      </div>
      <div className="ob-switches">
        <label className="hl-check"><input type="checkbox" checked={form.showPrices} onChange={set("showPrices")} disabled={disabled} /> Show prices to guests</label>
        {kind !== "clinic" && <label className="hl-check"><input type="checkbox" checked={form.allowAnyStaff} onChange={set("allowAnyStaff")} disabled={disabled} /> Let guests choose &quot;Any {peopleWord(biz.type)}&quot; (the free one with the fewest bookings that day)</label>}
      </div>
      {kind === "salon" && (
        depositPercent > 0 ? (
          <div className="ob-advance-settings">
            <label className="hl-check"><input type="checkbox" checked={form.upiAdvance} onChange={set("upiAdvance")} disabled={disabled} /> Ask for the {depositPercent}% advance by UPI when guests book</label>
            {form.upiAdvance && (
              <div className="form-grid">
                <Field label="Your UPI id" hint="Like shinesalon@okicici"><input required maxLength={100} value={form.upiId} onChange={set("upiId")} disabled={disabled} /></Field>
                <Field label="Name on the UPI account"><input maxLength={100} value={form.upiPayee} onChange={set("upiPayee")} disabled={disabled} /></Field>
              </div>
            )}
            <p className="muted small">The guest pays you directly and types the payment's 12-digit UTR; you check it in your UPI or bank app before accepting. {form.upiAdvance ? "" : "Without it, online bookings come as requests and you take the deposit when you confirm."}</p>
          </div>
        ) : <p className="muted small">The salon takes no deposit, so there is no advance online. A deposit % is set under Stylists &amp; services › Booking rules.</p>
      )}
      <Field label="A note guests read on the booking page" wide hint="Up to 300 characters, like: Please arrive 10 minutes early."><textarea rows={2} maxLength={300} value={form.guestNote} onChange={set("guestNote")} disabled={disabled} /></Field>
      {canManage && <div className="form-actions"><button type="submit" className="button" disabled={busy}>{busy ? "Saving…" : "Save the rules"}</button></div>}
    </SectionCard>
  );
}

function ShownCard({ place, link, kind, canManage, onChanged }) {
  const biz = useOpenBusiness();
  const [services, setServices] = useState(() => place.services.map((s) => ({ ...s, minutes: s.minutes ?? "" })));
  const [people, setPeople] = useState(() => place.people);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const setService = (id, change) => setServices((list) => list.map((s) => (s.id === id ? { ...s, ...change } : s)));
  const setPerson = (id, shown) => setPeople((list) => list.map((p) => (p.id === id ? { ...p, shown } : p)));
  async function save() {
    setBusy(true);
    setError("");
    try {
      await businessWrite(biz.id, `online-booking/links/${link.id}/shown`, {
        services: kind === "clinic" ? [] : services.map((s) => ({ skuId: s.id, shown: Boolean(s.shown), minutes: kind === "salon" ? undefined : s.minutes === "" ? undefined : s.minutes })),
        people: people.map((p) => ({ resourceId: p.id, shown: Boolean(p.shown) })),
      }, "put");
      toast.success("What shows online is saved.");
      onChanged();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const disabled = !canManage || busy;
  return (
    <SectionCard icon="eye" title="What shows online" description={kind === "salon" ? "Every service with its time (Stylists & services) and every stylist shows unless you hide it. Rooms are never chosen by guests."
      : kind === "clinic" ? "A doctor shows with OPD timings and a consultation fee. Patients see the fee, the qualifications and the registration number."
        : "Tick the services guests may book, each with how long it takes, and who they may book."}>
      <ErrorMessage message={error} />
      {kind !== "clinic" && (
        <div className="ob-shown">
          <h3 className="ob-shown-title">Services</h3>
          {!services.length && <p className="muted small">No services yet. Add them under Services &amp; products.</p>}
          <ul className="ob-shown-list">
            {services.map((s) => (
              <li key={s.id} className={s.shown ? "is-on" : ""}>
                <label className="hl-check"><input type="checkbox" checked={Boolean(s.shown)} disabled={disabled} onChange={(e) => setService(s.id, { shown: e.target.checked, minutes: s.minutes || (kind === "salon" ? s.minutes : 30) })} />
                  <span><strong>{s.label}</strong>{s.category ? <small className="muted"> · {s.category}</small> : null}</span></label>
                {kind === "salon"
                  ? <span className="muted small">{s.minutes} min{s.block > s.minutes ? ` + ${s.block - s.minutes} to clean up` : ""}{s.room ? " · needs a room" : ""}</span>
                  : <label className="ob-minutes"><input type="number" min="5" max="480" step="5" value={s.minutes} disabled={disabled || !s.shown} aria-label={`${s.label}: minutes`}
                    onChange={(e) => setService(s.id, { minutes: e.target.value === "" ? "" : Number(e.target.value) })} /> min</label>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="ob-shown">
        <h3 className="ob-shown-title">{peopleWord(biz.type, true).replace(/^./, (c) => c.toUpperCase())}</h3>
        {!people.length && <p className="muted small">Nobody at this location yet.</p>}
        <ul className="ob-shown-list">
          {people.map((p) => (
            <li key={p.id} className={p.shown ? "is-on" : ""}>
              <label className="hl-check"><input type="checkbox" checked={Boolean(p.shown)} disabled={disabled} onChange={(e) => setPerson(p.id, e.target.checked)} />
                <span><strong>{p.name}</strong>{p.role ? <small className="muted"> · {p.role}</small> : null}</span></label>
              {kind === "clinic" && (
                <span className="ob-doctor muted small">
                  {p.ready ? `${p.sessions} OPD session${p.sessions === 1 ? "" : "s"} a week · fee ₹${Number(p.fee).toLocaleString("en-IN")}` : "Needs OPD timings and a fee"}
                  {" · "}{p.registrationNo ? `Reg. ${p.registrationNo}${p.council ? `, ${p.council}` : ""}` : <strong className="ob-missing">Registration number not given</strong>}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
      {canManage && <div className="form-actions"><button type="button" className="button" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save what shows"}</button></div>}
    </SectionCard>
  );
}
