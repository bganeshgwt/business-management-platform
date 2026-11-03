import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import SectionCard from "../../../../components/SectionCard";
import StatTile from "../../../../components/StatTile";
import ContentTabs from "../../../../components/ContentTabs";
import LiveIndicator from "../../../../components/LiveIndicator";
import { ErrorMessage } from "../../../../components/Feedback";
import useLiveRefresh from "../../../../hooks/useLiveRefresh";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import { useConsentGate } from "../../../personal-data/useConsentGate";
import { useShopPrivacy } from "../../../personal-data/usePrivacy";
import { whatsappLink } from "../../receivables/pages/receivablesFormat";
import FormDialog from "../../core/pages/FormDialog";
import { Badge, BusinessHeader, Field, PeriodFilter } from "../../core/pages/ui";
import { newKey, useOpenBusiness, useServerList } from "../../core/pages/hooks";
import { zonedInstant } from "../../salon/pages/salon";
import OnlineBookingSettings from "./OnlineBookingSettings";
import { REASONS, STATUS, answerWithin, linkAddress, reminderText, rupees } from "./onlineBooking";
import "../styles/online-booking.css";

// Online booking (a Business Admin screen): what people booked from the booking link.
//   Requests      bookings waiting for the desk (accept, at another time or
//                 with another person agreed by phone, or decline with a reason
//                 the person reads), and requests nobody answered in time, to call
//   Bookings      every online booking, by the time it is for
//   Tomorrow      tomorrow's online bookings, with the prepared WhatsApp
//                 reminder for those who agreed to reminders
//   Booking link  the link of each location: its QR poster, the text to share,
//                 its rules and what shows online
// Live: a booking made, changed or cancelled online, or answered at another
// desk, shows within a second. The people are named in the business's words
// (services/terms.js): a salon's clients and stylists, a clinic's patients and
// doctors, a gym's members and trainers.

const TABS = [
  { value: "requests", label: "Requests" },
  { value: "bookings", label: "Bookings" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "link", label: "Booking link" },
];

const whenOf = (row, timeZone) => {
  const at = new Date(row.starts_at);
  return `${at.toLocaleDateString("en-IN", { timeZone, weekday: "short", day: "numeric", month: "short" })}, ${at.toLocaleTimeString("en-IN", { timeZone, hour: "numeric", minute: "2-digit" })}`;
};
const statusBadge = (status) => <Badge status={status} tone={STATUS[status]?.tone || "neutral"} label={STATUS[status]?.label || status} />;
const forWhom = (row) => {
  if (row.for_whom !== "someone_else") return null;
  const about = [row.person_age !== null && row.person_age !== undefined ? `${row.person_age} y` : null, row.person_sex].filter(Boolean).join(", ");
  return `For ${row.person_name}${about ? ` (${about})` : ""}`;
};

export default function OnlineBookingPage() {
  const biz = useOpenBusiness();
  const { t } = biz;
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.value === params.get("tab")) ? params.get("tab") : "requests";
  const setTab = (value) => setParams((p) => { const next = new URLSearchParams(p); next.set("tab", value); return next; }, { replace: true });
  const [waiting, setWaiting] = useState(null);
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  const live = useLiveRefresh({ business: biz.id }, ["appointment", "online_booking"], reload);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([businessRead(biz.id, "online-booking/requests", {}, controller.signal), businessRead(biz.id, "online-booking", {}, controller.signal)])
      .then(([w, o]) => { setWaiting(w); setOverview(o); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version]);
  const link = overview?.locations?.find((l) => l.link)?.link || null;
  const url = link ? linkAddress(link) : "";
  return (
    <div className="stack ob-page">
      <BusinessHeader icon="calendar" title="Online booking"
        description={`${t("customer", "many")} book ${t.lower("provider", "many")} from your booking link. Requests wait here for you; bookings go straight onto your calendar.`}
        actions={<span className="ob-head-actions"><LiveIndicator status={live} />{url && link?.enabled && <a className="button button-secondary" href={url} target="_blank" rel="noreferrer"><Icon name="external" size={15} /> Open my booking page</a>}</span>} />
      <ErrorMessage message={error} />
      <div className="stat-grid ob-stats">
        <StatTile icon="clock" tone={waiting?.requests.length ? "warning" : "neutral"} label="Requests waiting" value={waiting ? String(waiting.requests.length) : ""} loading={!waiting}
          note={waiting?.requests[0] ? `Answer the first ${answerWithin(waiting.requests[0].request_expires_at)}` : "Nothing to answer"} onClick={() => setTab("requests")} />
        <StatTile icon="alert" tone={waiting?.unanswered.length ? "danger" : "neutral"} label="Not answered in time" value={waiting ? String(waiting.unanswered.length) : ""} loading={!waiting}
          note="In the last two days: call them to book again" onClick={() => setTab("requests")} />
        <StatTile icon="link" tone={link?.enabled ? "success" : "neutral"} label="Booking link" value={overview ? (link ? (link.enabled ? "On" : "Off") : "Not set up") : ""} loading={!overview}
          note={link ? (link.confirmMode === "confirm" ? "You confirm each booking" : "Free times book at once") : "Set it up under Booking link"} onClick={() => setTab("link")} />
      </div>
      <ContentTabs label="Online booking" value={tab} options={TABS.map((t) => ({ ...t, label: t.value === "requests" && waiting?.requests.length ? `${t.label} (${waiting.requests.length})` : t.label }))} onChange={setTab}>
        {tab === "requests" && <Requests waiting={waiting} error={error} onChanged={reload} />}
        {tab === "bookings" && <Bookings version={version} />}
        {tab === "tomorrow" && <Tomorrow version={version} />}
        {tab === "link" && <OnlineBookingSettings overview={overview} onChanged={reload} />}
      </ContentTabs>
    </div>
  );
}

// --- Requests --------------------------------------------------------------------------------------

function Requests({ waiting, error, onChanged }) {
  const biz = useOpenBusiness();
  const { t } = biz;
  const tz = biz.business.timezone;
  const [accepting, setAccepting] = useState(null);
  const [declining, setDeclining] = useState(null);
  const canAnswer = biz.can("online_appointments.approve");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const columns = useMemo(() => [
    { key: "when", header: "Wants", value: (r) => r.starts_at, type: "datetime", mobile: "subtitle", minWidth: 190, render: (r) => (
      <span className="ob-when"><strong>{whenOf(r, tz)}</strong><small className="muted">{r.services} · {r.resource_name}</small></span>
    ) },
    { key: "guest", header: t("customer"), value: (r) => r.booker_name, mobile: "title", pin: true, render: (r) => (
      <span className="ob-guest">
        <strong>{r.booker_name}</strong>
        <span className="muted small">{r.mobile ? <a href={`tel:+91${r.mobile}`}>{r.mobile}</a> : "Details erased"}</span>
        {forWhom(r) && <span className="ob-chip">{forWhom(r)}</span>}
        {r.no_shows > 0 && <span className="ob-chip is-warning"><Icon name="alert" size={12} /> {r.no_shows} no-show{r.no_shows === 1 ? "" : "s"} in 90 days</span>}
      </span>
    ) },
    { key: "why", header: "Why it waits", value: (r) => REASONS[r.request_reason]?.label || "", mobile: "show", render: (r) => (
      <span className="ob-why">
        <span className={`ob-reason is-${r.request_reason}`} title={REASONS[r.request_reason]?.hint(t)}>{REASONS[r.request_reason]?.label || "—"}</span>
        {r.advance_amount && <small className="muted">{rupees(r.advance_amount)} · UTR <span className="mono">{r.advance_utr}</span></small>}
      </span>
    ) },
    { key: "note", header: "Note", value: (r) => [r.reason, r.note, r.vehicle_no].filter(Boolean).join(" · "), mobile: "show", render: (r) => (
      <span className="ob-note">
        {r.visit_kind && <span className="ob-chip">{r.visit_kind === "follow_up" ? "Visited before" : `New ${t.lower("customer")}`}</span>}
        {r.vehicle_no && <span className="ob-chip mono">{r.vehicle_no}{r.vehicle_make ? ` · ${r.vehicle_make} ${r.vehicle_model || ""}` : ""}</span>}
        {(r.reason || r.note) && <span>{[r.reason, r.note].filter(Boolean).join(" · ")}</span>}
        {!r.visit_kind && !r.vehicle_no && !r.reason && !r.note && <span className="muted">—</span>}
      </span>
    ) },
    { key: "answer_by", header: "Answer", value: (r) => r.request_expires_at, type: "datetime", mobile: "show", render: (r) => <span className="ob-answer">{answerWithin(r.request_expires_at, now)}</span> },
    canAnswer && { key: "actions", header: "", label: "Answer", type: "actions", render: (r) => (
      <div className="row-actions ob-actions">
        <button type="button" className="button button-ghost button-sm" onClick={() => setDeclining(r)}>Decline</button>
        <button type="button" className="button button-sm" onClick={() => setAccepting(r)}><Icon name="check" size={14} /> Accept</button>
      </div>
    ) },
  ].filter(Boolean), [canAnswer, now, tz, t]);
  const unanswered = [
    { key: "when", header: "Wanted", value: (r) => r.starts_at, type: "datetime", mobile: "subtitle", render: (r) => <span className="ob-when"><strong>{whenOf(r, tz)}</strong><small className="muted">{r.services}</small></span> },
    { key: "guest", header: t("customer"), value: (r) => r.booker_name, mobile: "title", render: (r) => (
      <span className="ob-guest"><strong>{r.booker_name}</strong>{r.mobile && <a className="muted small" href={`tel:+91${r.mobile}`}>Call {r.mobile}</a>}</span>
    ) },
    { key: "advance", header: "Advance", value: (r) => r.advance_amount || "", render: (r) => (r.advance_amount ? <span className="ob-chip is-warning">Return {rupees(r.advance_amount)} · UTR {r.advance_utr}</span> : <span className="muted">—</span>) },
  ];
  return (
    <>
      <SectionCard flush icon="clock" title="Waiting for your answer"
        description={`The ${t.lower("customer")}'s page changes the moment you answer. A request nobody answers in time expires and frees its time.`}>
        <DataGrid id="online-booking-requests" caption="Online booking requests" rows={waiting?.requests || []} rowKey={(r) => r.id} columns={columns}
          loading={!waiting && !error} rowNoun={["request", "requests"]} empty="No requests waiting. Bookings that need no answer go straight onto the calendar." emptyIcon="check" />
      </SectionCard>
      {waiting?.unanswered.length > 0 && (
        <SectionCard flush tone="danger" icon="alert" title="Not answered in time" description={`These ${t.lower("customer", "many")} were told the booking was not confirmed. Call them to book again.`}>
          <DataGrid id="online-booking-unanswered" caption="Requests not answered in time" variant="compact" rows={waiting.unanswered} rowKey={(r) => r.id} columns={unanswered} rowNoun={["request", "requests"]} />
        </SectionCard>
      )}
      {accepting && <AcceptDialog row={accepting} onClose={() => setAccepting(null)} onSaved={() => { setAccepting(null); onChanged(); }} />}
      {declining && <DeclineDialog row={declining} onClose={() => setDeclining(null)} onSaved={() => { setDeclining(null); onChanged(); }} />}
    </>
  );
}

// The day and time (business clock) of an instant, for the form.
const localParts = (iso, timeZone) => {
  const at = new Date(iso);
  return { date: new Intl.DateTimeFormat("en-CA", { timeZone }).format(at), time: at.toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" }) };
};

function AcceptDialog({ row, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { t } = biz;
  const tz = biz.business.timezone;
  const start = localParts(row.starts_at, tz);
  const [form, setForm] = useState({ change: false, date: start.date, time: start.time, resourceId: String(row.resource_id), received: false,
    deposit: "", methodId: "", method: "cash", reference: "" });
  const [people, setPeople] = useState([]);
  const [requestKey] = useState(newKey);
  useEffect(() => {
    businessRead(biz.id, "resources", { limit: 100, location: row.location_id }).then((r) => setPeople((r.items || []).filter((p) => p.active))).catch(() => setPeople([]));
  }, [biz.id, row.location_id]);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const advance = row.request_reason === "advance" && row.advance_amount;
  const deposit = biz.type === "salon" && row.request_reason === "deposit";
  const changed = form.change && (form.date !== start.date || form.time !== start.time || form.resourceId !== String(row.resource_id));
  const submit = () => {
    if (advance && !form.received) throw new Error("Tick that the advance reached your account, or decline the request");
    return businessWrite(biz.id, `online-booking/bookings/${row.id}/accept`, {
      requestKey,
      ...(changed ? { startsAt: zonedInstant(form.date, form.time, tz), resourceId: form.resourceId } : {}),
      ...(advance ? { advanceReceived: true } : {}),
      ...(deposit && Number(form.deposit) > 0 ? { deposit: { amount: form.deposit, method: form.method, reference: form.reference || undefined } } : {}),
    });
  };
  return (
    <FormDialog title={`Accept ${row.booker_name}'s booking`} icon="check" width={600} submitLabel={changed ? "Accept at the new time" : "Accept"} onClose={onClose} onSaved={onSaved}
      successMessage={() => `${row.booker_name} is booked. Their page shows it now.`}
      description={`${row.services} with ${row.resource_name}, ${whenOf(row, tz)}.`} onSubmit={submit}>
      {advance && (
        <div className="field-wide ob-advance">
          <p><Icon name="rupee" size={15} /> The {t.lower("customer")} says they paid <strong>{rupees(row.advance_amount)}</strong> by UPI, UTR <strong className="mono">{row.advance_utr}</strong>.
            Find it in your UPI or bank app first.</p>
          <label className="hl-check"><input type="checkbox" checked={form.received} onChange={set("received")} /> It reached our account: record it as the booking's deposit</label>
        </div>
      )}
      {deposit && (
        <>
          <p className="field-wide muted small">Bookings here take a deposit. Call the {t.lower("customer")}, take it, and record it here (or leave it empty to book without one).</p>
          <Field label="Deposit taken (₹)"><input type="number" min="0" step="1" value={form.deposit} onChange={set("deposit")} /></Field>
          <Field label="Paid by"><select value={form.method} onChange={set("method")}><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option><option value="bank">Bank transfer</option></select></Field>
          <Field label="Reference" hint="The UPI reference, if paid by UPI"><input maxLength={100} value={form.reference} onChange={set("reference")} /></Field>
        </>
      )}
      <label className="field-wide hl-check"><input type="checkbox" checked={form.change} onChange={set("change")} /> We agreed another time or {t.lower("provider")} on the phone</label>
      {form.change && (
        <>
          <Field label="Date"><input type="date" required value={form.date} onChange={set("date")} /></Field>
          <Field label="Time"><input type="time" required step="300" value={form.time} onChange={set("time")} /></Field>
          {biz.type !== "healthcare" && (
            <Field label={t("provider")}>
              <select value={form.resourceId} onChange={set("resourceId")}>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            </Field>
          )}
          <p className="field-wide muted small">The same rules as any booking apply: hours, leave, skills and other bookings. The {t.lower("customer")}'s page shows the new time.</p>
        </>
      )}
    </FormDialog>
  );
}

const DECLINE_WORDS = ["Fully booked at that time", "Not available that day", "Please call us to book this", "We could not reach you on the phone"];

function DeclineDialog({ row, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const { t } = biz;
  const [reason, setReason] = useState("");
  const person = t.lower("customer");
  return (
    <FormDialog title={`Decline ${row.booker_name}'s request`} icon="x" width={560} submitLabel="Decline" onClose={onClose} onSaved={onSaved}
      successMessage={`Declined. The ${person}'s page says so, with your words.`}
      description={`The ${person} reads your reason on their page, with your phone number to call.`}
      onSubmit={() => businessWrite(biz.id, `online-booking/bookings/${row.id}/decline`, { reason })}>
      <Field label={`Reason the ${person} reads`} wide>
        <textarea required rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div className="field-wide ob-chips">
        {DECLINE_WORDS.map((word) => <button key={word} type="button" className="chip-button" onClick={() => setReason(word)}>{word}</button>)}
      </div>
      {row.advance_amount && <p className="field-wide alert alert-notice">Return the {person}'s advance of {rupees(row.advance_amount)} (UTR {row.advance_utr}) from your UPI app: their page tells them you will.</p>}
    </FormDialog>
  );
}

// --- Every online booking --------------------------------------------------------------------------

function Bookings({ version }) {
  const biz = useOpenBusiness();
  const { t } = biz;
  const tz = biz.business.timezone;
  const [status, setStatus] = useState("");
  const list = useServerList("online-booking/bookings", { gridId: "online-bookings", period: "ahead", params: status ? { status } : {} });
  const { reload } = list;
  useEffect(() => { if (version) reload(); }, [version, reload]);
  const columns = [
    { key: "starts_at", header: "For", type: "datetime", value: (r) => r.starts_at, mobile: "subtitle", render: (r) => whenOf(r, tz) },
    { key: "booker_name", header: t("customer"), value: (r) => r.booker_name, mobile: "title", pin: true, render: (r) => (
      <span className="ob-guest"><strong>{r.booker_name}</strong>{forWhom(r) && <small className="muted">{forWhom(r)}</small>}</span>
    ) },
    { key: "mobile", header: "Mobile", value: (r) => r.mobile || "" },
    { key: "services", header: "Booked", value: (r) => r.services, mobile: "show" },
    { key: "resource_name", header: "With", value: (r) => r.resource_name },
    { key: "status", header: "Status", type: "status", value: (r) => r.status, mobile: "show", render: (r) => statusBadge(r.status) },
    { key: "created_at", header: "Booked on", type: "datetime", value: (r) => r.created_at, defaultHidden: true },
    { key: "note", header: `${t("customer")}'s note`, value: (r) => r.note || "", defaultHidden: true },
    { key: "answered_by_name", header: "Answered by", value: (r) => r.answered_by_name || "", defaultHidden: true },
    { key: "decline_reason", header: "Reason declined", value: (r) => r.decline_reason || "", defaultHidden: true },
  ];
  return (
    <SectionCard flush icon="list" title="Online bookings" description={`Every booking ${t.lower("customer", "many")} made from the link, by the time it is for.`}>
      <DataGrid {...list.gridProps} caption="Online bookings" columns={columns} rowNoun={["booking", "bookings"]} empty="No online bookings in these dates" emptyIcon="calendar"
        toolbar={(
          <>
            <PeriodFilter list={list} />
            <label className="field">
              <span>Status</span>
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All</option>
                {Object.entries(STATUS).map(([value, s]) => <option key={value} value={value}>{s.label}</option>)}
              </select>
            </label>
          </>
        )}
        rowClassName={(r) => (["cancelled", "declined", "expired"].includes(r.status) ? "dg-tone-muted" : r.status === "requested" ? "dg-tone-warning" : "")} />
    </SectionCard>
  );
}

// --- Tomorrow --------------------------------------------------------------------------------------

function Tomorrow({ version }) {
  const biz = useOpenBusiness();
  const { t } = biz;
  const gate = useConsentGate(useShopPrivacy());
  const tz = biz.business.timezone;
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [mine, setMine] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(biz.id, "online-booking/tomorrow", {}, controller.signal).then((r) => { setData(r); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, version, mine]);
  const send = async (row) => {
    if (!(await gate.ensure("reminders", { id: row.contact_id, name: row.booker_name }))) return;
    const href = whatsappLink(row.mobile, reminderText(row, biz.business.name, tz));
    if (href) window.open(href, "_blank", "noopener");
    try {
      await businessWrite(biz.id, `online-booking/bookings/${row.id}/reminder-sent`, {});
      setMine((n) => n + 1);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };
  const rows = data?.bookings || [];
  const left = rows.filter((r) => !r.reminder_sent_at).length;
  return (
    <SectionCard flush icon="message" title={`Tomorrow${data ? `, ${new Date(`${data.day}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", weekday: "long", day: "numeric", month: "short" })}` : ""}`}
      description={rows.length ? `${left} reminder${left === 1 ? "" : "s"} still to send. Each opens your WhatsApp with the message ready; ${t.a("customer")} who did not agree to reminders is asked first.` : "Tomorrow's online bookings, to remind on WhatsApp."}>
      <ErrorMessage message={error} />
      <DataGrid id="online-booking-tomorrow" caption="Tomorrow's online bookings" variant="compact" rows={rows} rowKey={(r) => r.id} loading={!data && !error}
        rowNoun={["booking", "bookings"]} empty="No online bookings for tomorrow" emptyIcon="calendar" columns={[
          { key: "time", header: "Time", value: (r) => r.starts_at, mobile: "subtitle", render: (r) => new Date(r.starts_at).toLocaleTimeString("en-IN", { timeZone: tz, hour: "numeric", minute: "2-digit" }) },
          { key: "guest", header: t("customer"), value: (r) => r.booker_name, mobile: "title" },
          { key: "what", header: "Booked", value: (r) => `${r.services} · ${r.resource_name}`, mobile: "show" },
          { key: "consent", header: "Reminders", value: (r) => (r.reminders_ok ? "Agreed" : "Not agreed"), render: (r) => (r.reminders_ok ? <Badge tone="success" label="Agreed" /> : <Badge tone="neutral" label="Not agreed" />) },
          { key: "actions", header: "", label: "Remind", type: "actions", render: (r) => (r.reminder_sent_at ? <Badge tone="success" label="Sent" />
            : r.mobile && <button type="button" className="button button-sm" onClick={() => send(r)}><Icon name="message" size={14} /> Send on WhatsApp</button>) },
        ]} />
      {gate.dialog}
    </SectionCard>
  );
}

