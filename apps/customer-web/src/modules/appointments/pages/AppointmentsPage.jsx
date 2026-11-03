// Online booking for guests (no sign-in):
//   /appointments/:token               a business's booking link: service, who, day and time, details, done
//   /appointments/status/:guestToken   the guest's own booking, followed live: add to calendar, directions,
//                                      call, change the time or cancel while the business allows it
//   /appointments                      the bookings made on this phone, and how to book
//
// Phone first: one step per screen, a summary bar at the bottom with what is
// chosen and the next step. Built from the shared guest pieces (src/shared).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import {
  ConsentChoices, DeclarationCheck, GuestEmpty, GuestError, GuestShell, GuestSkeleton, MobileField, NameField, StatusSteps,
  guestErrorMessage, mapsHref, newClientKey, refusalReason, telHref, useGuestLive,
} from "../../../shared";
import { mobileProblem, nameProblem } from "../../../shared/fieldRules";
import {
  allMine, book, calendarUrl, cancelMine, changeDays, changeTimes, forgetMine, getDays, getMine, getPage, getTimes, moveMine, rememberMine, upiPayLink,
} from "../services/appointments.service";
import { STEP_TITLES, ableFor, advanceOf, dayNote, minutesText, noTimesText, rupees, sortMine, stepsFor, timelineOf, visitOf } from "./appointmentWords";
import "../../../styles/guest.css";
import "../styles/appointments.css";

const CALM = ["feature_off", "booking_off", "not_taking_orders"];
// Who serves at a booking, in the business's own words (its card's terms, as
// the platform and the owner set them): a salon's stylist, a clinic's doctor,
// a gym's trainer. Mid-sentence, so in lower case but for words in capitals.
const personWord = (page) => String(page.card?.terms?.provider?.one || "Person").split(" ")
  .map((part) => (/^[A-Z0-9]{2,}$/.test(part.replace(/[^A-Za-z0-9]/g, "")) ? part : part.toLowerCase())).join(" ");
const timeOfIso = (iso) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

export default function AppointmentsPage() {
  return (
    <Routes>
      <Route path="status/:guestToken" element={<StatusPage />} />
      <Route path=":token" element={<BookingFlow />} />
      <Route index element={<MinePage />} />
      <Route path="*" element={<MinePage />} />
    </Routes>
  );
}

// --- Not taking bookings now -------------------------------------------------------------------------

function Unavailable({ card, message }) {
  const call = card?.location?.phone;
  return (
    <GuestShell card={card} context="Online booking">
      <GuestEmpty heading="h1" icon="calendar" title="Not taking online bookings now"
        action={call ? <a className="g-primary ap-call" href={telHref(call)}><Icon name="phone" size={17} /> Call {call}</a> : null}>
        {message || "Please call the business to book."}
      </GuestEmpty>
    </GuestShell>
  );
}

// --- Booking -------------------------------------------------------------------------------------------

const EMPTY_DETAILS = { name: "", mobile: "", forWhom: "self", personName: "", personAge: "", personSex: "", visitKind: "", reason: "", note: "",
  vehicleNo: "", vehicleMake: "", vehicleModel: "", adult: false, advanceUtr: "", website: "" };

function BookingFlow() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [page, setPage] = useState(null);
  const [failure, setFailure] = useState(null);
  const [step, setStep] = useState(0);
  const [serviceIds, setServiceIds] = useState([]);
  const [person, setPerson] = useState(null);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [details, setDetails] = useState(EMPTY_DETAILS);
  const [consents, setConsents] = useState([]);
  const [clientKey, setClientKey] = useState(newClientKey);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [problems, setProblems] = useState({});
  const [nextFree, setNextFree] = useState([]);
  const top = useRef(null);

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    getPage(token).then((data) => alive && setPage(data))
      .catch((error) => alive && setFailure({ reason: refusalReason(error), message: guestErrorMessage(error, "the business"), card: error?.response?.data?.data?.card || null }));
    return () => { alive = false; };
  }, [token, attempt]);
  const load = () => {
    setFailure(null);
    setAttempt((n) => n + 1);
  };
  // A gym's session, a clinic's appointment, a garage's service: booked online.
  useEffect(() => {
    if (page) document.title = `Book online · ${page.card.name}`;
  }, [page]);

  const steps = page ? stepsFor(page.kind) : [];
  const current = steps[step];
  const selection = useMemo(() => ({ services: serviceIds, person: person ?? "any" }), [serviceIds, person]);
  const visit = page ? visitOf(page, serviceIds, person) : null;
  const advance = page?.advance?.upiId ? advanceOf(visit?.price ?? null, page.advance.percent) : null;
  const go = (index) => {
    setStep(index);
    setSendError(null);
    top.current?.scrollIntoView({ block: "start" });
  };

  if (failure) {
    if (CALM.includes(failure.reason)) return <Unavailable card={failure.card} message={failure.message} />;
    return (
      <GuestShell card={null} context="Online booking">
        <GuestError heading="h1" title={failure.reason === "not_available" ? "This booking link isn't in use" : "Couldn't open the booking page"} message={failure.message}
          onRetry={failure.reason === "not_available" ? null : load} />
      </GuestShell>
    );
  }
  if (!page) {
    return <GuestShell card={null} context="Online booking"><GuestSkeleton cards={3} label="Opening the booking page" /></GuestShell>;
  }

  const ready = {
    service: serviceIds.length > 0,
    person: person !== null,
    time: Boolean(date && time),
    details: true,
  };
  const people = page.kind === "clinic" ? page.people : ableFor(page.people, serviceIds);
  const anyPerson = page.asks.any && people.length > 1;
  const chosenPerson = page.people.find((p) => p.id === person);

  function checkDetails() {
    const found = {};
    const name = nameProblem(details.name);
    if (name) found.name = name;
    const mobile = mobileProblem(details.mobile);
    if (mobile) found.mobile = mobile;
    if (details.forWhom === "someone_else" && nameProblem(details.personName)) found.personName = "Enter the name of the person the booking is for";
    if (page.asks.clinic) {
      if (details.personAge === "" || !/^\d{1,3}$/.test(String(details.personAge)) || Number(details.personAge) > 120) found.personAge = "Enter the patient's age in years";
      if (!details.personSex) found.personSex = "Choose the patient's sex";
      if (!details.visitKind) found.visitKind = "Say whether the patient has visited before";
    }
    if (page.asks.vehicle) {
      if (!/^[A-Z0-9]{4,15}$/.test(details.vehicleNo.toUpperCase().replace(/[^A-Z0-9]/g, ""))) found.vehicleNo = "Enter the number on the plate, like TS09EA4521";
      if (!details.vehicleMake.trim()) found.vehicleMake = "Enter the make, like Maruti or Honda";
      if (!details.vehicleModel.trim()) found.vehicleModel = "Enter the model, like Swift or Activa";
    }
    if (page.asks.adult && !details.adult) found.adult = "Tick this to book";
    if (advance && !/^\d{12}$/.test(details.advanceUtr.replace(/\s/g, ""))) found.advanceUtr = "Type the 12-digit UTR of your UPI payment";
    setProblems(found);
    return Object.keys(found).length === 0;
  }

  async function submit() {
    if (!checkDetails()) {
      setSendError({ message: "Please check the details marked below." });
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      const answer = await book(token, {
        clientKey, services: serviceIds, person: person ?? "any", date, time, name: details.name, mobile: details.mobile, forWhom: details.forWhom,
        personName: details.forWhom === "someone_else" ? details.personName : undefined,
        ...(page.asks.clinic ? { personAge: Number(details.personAge), personSex: details.personSex, visitKind: details.visitKind, reason: details.reason || undefined } : {}),
        ...(page.asks.vehicle ? { vehicleNo: details.vehicleNo, vehicleMake: details.vehicleMake, vehicleModel: details.vehicleModel } : {}),
        ...(page.asks.adult ? { adultDeclared: details.adult } : {}),
        ...(advance ? { advanceUtr: details.advanceUtr.replace(/\s/g, "") } : {}),
        note: details.note || undefined, consents, noticeId: page.card.privacy?.id, website: details.website || undefined,
      });
      const made = answer.data;
      rememberMine({ guestToken: made.guestToken, business: page.card.name, what: made.services.map((s) => s.label).join(" + "), person: made.person,
        startsAt: made.startsAt, link: token });
      navigate(`/appointments/status/${made.guestToken}`, { replace: true, state: { message: answer.message } });
    } catch (error) {
      const reason = refusalReason(error);
      const data = error?.response?.data?.data || {};
      // A refusal answers this submission: the next one is a new one.
      if (error?.response) setClientKey(newClientKey());
      if (CALM.includes(reason)) {
        setFailure({ reason, message: guestErrorMessage(error, "the business"), card: data.card || page.card });
      } else if (reason === "slot_taken") {
        setNextFree(data.next || []);
        setTime("");
        go(steps.indexOf("time"));
        setSendError({ message: guestErrorMessage(error) });
      } else {
        if (data.field) setProblems((p) => ({ ...p, [data.field]: guestErrorMessage(error) }));
        setSendError({ message: guestErrorMessage(error, "the business") });
      }
    } finally {
      setSending(false);
    }
  }

  const last = step === steps.length - 1;
  const canGoOn = ready[current];
  const summary = [
    visit.labels.length ? `${visit.labels.join(" + ")}${visit.minutes ? ` · ${minutesText(visit.minutes)}` : ""}` : null,
    current !== "service" && current !== "person" ? (chosenPerson ? chosenPerson.name : person === "any" ? `Any ${personWord(page)}` : null) : null,
    date && time ? `${dayLabelOf(date)}, ${clockLabelOf(time)}` : null,
  ].filter(Boolean);

  return (
    <GuestShell card={page.card} context="Online booking">
      <div className="ap-flow" ref={top}>
        <ol className="ap-progress" aria-label="Booking steps">
          {steps.map((s, index) => (
            <li key={s} className={index < step ? "is-done" : index === step ? "is-now" : ""} aria-current={index === step ? "step" : undefined}>
              <span className="ap-progress-bar" aria-hidden="true" />
              <span className="ap-progress-label">{STEP_TITLES[s].replace("Choose who", `Choose the ${personWord(page)}`)}</span>
            </li>
          ))}
        </ol>
        {page.link.guestNote && step === 0 && <p className="ap-note"><Icon name="info" size={16} /> {page.link.guestNote}</p>}
        {page.memberClasses && step === 0 && <p className="ap-note"><Icon name="users" size={16} /> Members book their classes with the desk for now: booking a class online needs a member sign-in, which is coming. Here you can book a free trial.</p>}
        <h1 className="ap-title">{current === "person" ? (page.kind === "clinic" ? "Choose your doctor" : `Choose your ${personWord(page)}`) : current === "service" && page.asks.trial ? "Book a free trial" : STEP_TITLES[current]}</h1>

        {current === "service" && (
          <ServiceStep page={page} chosen={serviceIds} onChange={(ids) => { setServiceIds(ids); setPerson(null); setDate(""); setTime(""); }}
            onPicked={() => go(step + 1)} />
        )}
        {current === "person" && (
          <PersonStep page={page} people={people} any={anyPerson} chosen={person}
            onPick={(value) => { setPerson(value); setDate(""); setTime(""); go(step + 1); }} />
        )}
        {current === "time" && (
          <TimeStep token={token} selection={selection} today={page.today} date={date} time={time} nextFree={nextFree}
            onDate={(value) => { setDate(value); setTime(""); }} onTime={(value) => setTime(value)}
            onPickNext={(slot) => { setDate(slot.date); setTime(slot.time); setNextFree([]); setSendError(null); }} />
        )}
        {current === "details" && (
          <DetailsStep page={page} details={details} setDetails={setDetails} problems={problems} consents={consents} setConsents={setConsents} visit={visit}
            advance={advance} summary={summary} confirmMode={page.link.confirm} />
        )}
        {sendError && <p className="ap-error" role="alert"><Icon name="alert-circle" size={17} /> {sendError.message}</p>}
      </div>

      <div className="ap-bar" role="region" aria-label="Your booking so far">
        <div className="ap-bar-inner">
          <div className="ap-bar-text">
            {summary.length ? <strong>{summary[0]}</strong> : <strong>{page.kind === "clinic" ? "Choose a doctor" : "Choose a service"}</strong>}
            {summary.length > 1 && <span>{summary.slice(1).join(" · ")}</span>}
            {visit.price !== null && page.link.showPrices && summary.length > 0 && <span className="ap-bar-price">{rupees(visit.price)}{page.kind === "clinic" ? " fee" : ""}</span>}
          </div>
          <div className="ap-bar-actions">
            {step > 0 && <button type="button" className="g-secondary ap-back" onClick={() => go(step - 1)} aria-label="Back"><Icon name="chevron-left" size={18} /></button>}
            {last ? (
              <button type="button" className="g-primary" onClick={submit} disabled={sending}>
                {sending ? "Sending…" : page.link.confirm || advance || page.advance ? "Send request" : "Book now"}
              </button>
            ) : (
              <button type="button" className="g-primary" onClick={() => go(step + 1)} disabled={!canGoOn}>
                Next <Icon name="chevron-right" size={17} />
              </button>
            )}
          </div>
        </div>
      </div>
    </GuestShell>
  );
}

const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayLabelOf(date) {
  const [y, m, d] = date.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  return `${WEEK[at.getUTCDay()]}, ${d} ${MONTHS[m - 1]}`;
}
function clockLabelOf(time) {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

function ServiceStep({ page, chosen, onChange, onPicked }) {
  const multi = page.asks.multi > 1;
  const groups = useMemo(() => {
    const map = new Map();
    for (const s of page.services) {
      const key = s.category || "Services";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(s);
    }
    return [...map.entries()];
  }, [page.services]);
  if (!page.services.length) {
    return <GuestEmpty icon="calendar" title="Nothing to book online yet">Please call the business to book.</GuestEmpty>;
  }
  const toggle = (id) => {
    if (!multi) {
      onChange([id]);
      onPicked();
      return;
    }
    onChange(chosen.includes(id) ? chosen.filter((x) => x !== id) : chosen.length >= page.asks.multi ? chosen : [...chosen, id]);
  };
  return (
    <div className="ap-services">
      {multi && <p className="ap-hint">Choose up to {page.asks.multi}: they are done one after another, by the same {personWord(page)}.</p>}
      {groups.map(([group, list]) => (
        <section key={group} className="ap-group">
          {groups.length > 1 && <h2 className="ap-group-title">{group}</h2>}
          <ul className="ap-options" role="list">
            {list.map((s) => {
              const on = chosen.includes(s.id);
              const full = multi && !on && chosen.length >= page.asks.multi;
              return (
                <li key={s.id}>
                  <button type="button" className={`ap-option ${on ? "is-on" : ""}`} aria-pressed={on} onClick={() => toggle(s.id)} disabled={full}>
                    <span className="ap-option-main">
                      <strong>{s.label}</strong>
                      <span className="ap-option-meta"><Icon name="clock" size={13} /> {minutesText(s.minutes)}</span>
                    </span>
                    {s.price !== null && <span className="ap-option-price">{rupees(s.price)}</span>}
                    <span className="ap-tick" aria-hidden="true">{on ? <Icon name="check" size={15} /> : null}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {page.link.showPrices && page.services.some((s) => s.price !== null) && <p className="ap-hint">Prices include GST. You pay at the visit.</p>}
    </div>
  );
}

function PersonStep({ page, people, any, chosen, onPick }) {
  const clinic = page.kind === "clinic";
  if (!people.length) {
    return <GuestEmpty icon="users" title={`No ${personWord(page)} takes this online`}>Please go back and choose again, or call the business.</GuestEmpty>;
  }
  return (
    <ul className="ap-options ap-people" role="list">
      {any && (
        <li>
          <button type="button" className={`ap-option ${chosen === "any" ? "is-on" : ""}`} aria-pressed={chosen === "any"} onClick={() => onPick("any")}>
            <span className="ap-avatar is-any" aria-hidden="true"><Icon name="users" size={18} /></span>
            <span className="ap-option-main"><strong>Any {personWord(page)}</strong><span className="ap-option-meta">The first free, so you get the most times</span></span>
          </button>
        </li>
      )}
      {people.map((p) => (
        <li key={p.id}>
          <button type="button" className={`ap-option ${chosen === p.id ? "is-on" : ""}`} aria-pressed={chosen === p.id} onClick={() => onPick(p.id)}>
            <span className="ap-avatar" aria-hidden="true">{p.name.replace(/^Dr\.?\s+/i, "").slice(0, 1).toUpperCase()}</span>
            <span className="ap-option-main">
              <strong>{p.name}</strong>
              {clinic ? (
                <>
                  {(p.speciality || p.qualifications) && <span className="ap-option-meta">{[p.qualifications, p.speciality].filter(Boolean).join(" · ")}</span>}
                  {p.registrationNo && <span className="ap-option-meta">Reg. No. {p.registrationNo}{p.council ? `, ${p.council}` : ""}</span>}
                  {p.followUpDays > 0 && <span className="ap-option-meta">Follow-up within {p.followUpDays} days: {p.followUpFee === null ? "free" : rupees(p.followUpFee)}</span>}
                </>
              ) : (p.role && <span className="ap-option-meta">{p.role}</span>)}
            </span>
            {clinic && p.fee !== null && page.link.showPrices && <span className="ap-option-price">{rupees(p.fee)}<small>fee</small></span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

function TimeStep({ token, selection, today, date, time, nextFree, onDate, onTime, onPickNext, loaders }) {
  const [days, setDays] = useState(null);
  const [times, setTimes] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const fetchDays = loaders?.days || ((s) => getDays(token, s));
  const fetchTimes = loaders?.times || ((s, d) => getTimes(token, s, d));
  const selectionKey = JSON.stringify(selection);
  useEffect(() => {
    let alive = true;
    setDays(null);
    fetchDays(selection).then((r) => {
      if (!alive) return;
      setDays(r.days);
      if (!date) {
        const first = r.days.find((d) => d.open);
        if (first) onDate(first.date);
      }
    }).catch((err) => alive && setError(guestErrorMessage(err)));
    return () => { alive = false; };
    // The days follow the services and the person chosen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey, attempt]);
  useEffect(() => {
    if (!date) return undefined;
    let alive = true;
    setTimes(null);
    fetchTimes(selection, date).then((r) => alive && setTimes(r)).catch((err) => alive && setError(guestErrorMessage(err)));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey, date, attempt]);
  const strip = useRef(null);
  useEffect(() => {
    const node = strip.current?.querySelector(".is-on");
    if (node) node.scrollIntoView({ block: "nearest", inline: "center" });
  }, [date, days]);
  if (error) return <GuestError message={error} onRetry={() => { setError(""); setAttempt((n) => n + 1); }} />;
  return (
    <div className="ap-time">
      {nextFree.length > 0 && (
        <div className="ap-next">
          <span>Free soon after:</span>
          <div className="ap-chips">{nextFree.map((slot) => <button key={`${slot.date}-${slot.time}`} type="button" className="ap-chip" onClick={() => onPickNext(slot)}>{slot.label}</button>)}</div>
        </div>
      )}
      <div className="ap-days" ref={strip} role="listbox" aria-label="Days">
        {!days && Array.from({ length: 7 }, (_, n) => <span key={n} className="ap-day skeleton" aria-hidden="true" />)}
        {days && days.map((d) => (
          <button key={d.date} type="button" role="option" aria-selected={d.date === date} className={`ap-day ${d.date === date ? "is-on" : ""} ${d.open ? "" : "is-closed"}`}
            onClick={() => onDate(d.date)}>
            <span className="ap-day-week">{d.today ? "Today" : d.weekday}</span>
            <strong>{d.day}</strong>
            <span className="ap-day-note">{d.open ? d.firstLabel : dayNote(d)}</span>
          </button>
        ))}
      </div>
      {date && !times && <GuestSkeleton cards={1} lines={2} label="Finding free times" />}
      {times && !times.groups.length && <p className="ap-empty-times"><Icon name="calendar" size={16} /> {noTimesText(times.reason, date === today)}</p>}
      {times && times.groups.map((group) => (
        <section key={group.part} className="ap-part">
          <h2 className="ap-part-title">{group.part}</h2>
          <div className="ap-times">
            {group.times.map((t) => (
              <button key={t.time} type="button" className={`ap-chip ap-time-chip ${t.time === time ? "is-on" : ""}`} aria-pressed={t.time === time} onClick={() => onTime(t.time)}>{t.label}</button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function DetailsStep({ page, details, setDetails, problems, consents, setConsents, visit, advance, summary, confirmMode }) {
  const set = (key) => (value) => setDetails((d) => ({ ...d, [key]: value && value.target ? (value.target.type === "checkbox" ? value.target.checked : value.target.value) : value }));
  const someoneElse = details.forWhom === "someone_else";
  return (
    <div className="ap-details">
      <div className="ap-recap">
        <Icon name="calendar" size={18} />
        <span><strong>{summary[0]}</strong>{summary.slice(1).map((line) => <span key={line}>{line}</span>)}</span>
        {visit.price !== null && page.link.showPrices && <strong className="ap-recap-price">{rupees(visit.price)}</strong>}
      </div>
      <fieldset className="ap-who">
        <legend>Who is it for?</legend>
        <div className="ap-segment" role="radiogroup">
          {[["self", "Me"], ["someone_else", "Someone else"]].map(([value, label]) => (
            <label key={value} className={details.forWhom === value ? "is-on" : ""}>
              <input type="radio" name="forWhom" value={value} checked={details.forWhom === value} onChange={set("forWhom")} /> {label}
            </label>
          ))}
        </div>
      </fieldset>
      <NameField value={details.name} onChange={set("name")} error={problems.name} label={someoneElse ? "Your name" : "Your name"} />
      <MobileField value={details.mobile} onChange={set("mobile")} error={problems.mobile}
        hint={someoneElse ? "Your mobile: the business calls you about the booking." : "The business calls this number if it needs to."} />
      {someoneElse && <NameField value={details.personName} onChange={set("personName")} error={problems.personName} label={page.asks.clinic ? "Patient's name" : "Their name"} />}
      {page.asks.clinic && (
        <div className="ap-pair">
          <label className={`gs-field ${problems.personAge ? "has-problem" : ""}`}>
            <span>{someoneElse ? "Patient's age" : "Your age"}</span>
            <input inputMode="numeric" maxLength={3} value={details.personAge} onChange={(e) => set("personAge")(e.target.value.replace(/\D/g, ""))} aria-invalid={Boolean(problems.personAge)} />
            {problems.personAge && <small className="gs-field-problem" role="alert">{problems.personAge}</small>}
          </label>
          <label className={`gs-field ${problems.personSex ? "has-problem" : ""}`}>
            <span>Sex</span>
            <select value={details.personSex} onChange={set("personSex")} aria-invalid={Boolean(problems.personSex)}>
              <option value="">Choose…</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option>
            </select>
            {problems.personSex && <small className="gs-field-problem" role="alert">{problems.personSex}</small>}
          </label>
        </div>
      )}
      {page.asks.clinic && (
        <fieldset className={`ap-who ${problems.visitKind ? "has-problem" : ""}`}>
          <legend>Has {someoneElse ? "the patient" : "the patient (you)"} visited this clinic before?</legend>
          <div className="ap-segment" role="radiogroup">
            {[["new", "First visit"], ["follow_up", "Visited before"]].map(([value, label]) => (
              <label key={value} className={details.visitKind === value ? "is-on" : ""}>
                <input type="radio" name="visitKind" value={value} checked={details.visitKind === value} onChange={set("visitKind")} /> {label}
              </label>
            ))}
          </div>
          {problems.visitKind && <small className="gs-field-problem" role="alert">{problems.visitKind}</small>}
        </fieldset>
      )}
      {page.asks.clinic && (
        <label className="gs-field">
          <span>Reason for the visit <em>optional</em></span>
          <input maxLength={200} value={details.reason} onChange={set("reason")} placeholder="Fever for three days, a check-up…" />
          <small className="gs-field-hint">Up to 200 characters. Leave it empty if you prefer to tell the doctor.</small>
        </label>
      )}
      {page.asks.vehicle && (
        <>
          <label className={`gs-field ${problems.vehicleNo ? "has-problem" : ""}`}>
            <span>Vehicle number</span>
            <input className="ap-plate" autoCapitalize="characters" maxLength={15} value={details.vehicleNo} onChange={(e) => set("vehicleNo")(e.target.value.toUpperCase())} placeholder="TS09EA4521" aria-invalid={Boolean(problems.vehicleNo)} />
            {problems.vehicleNo && <small className="gs-field-problem" role="alert">{problems.vehicleNo}</small>}
          </label>
          <div className="ap-pair">
            <label className={`gs-field ${problems.vehicleMake ? "has-problem" : ""}`}>
              <span>Make</span><input maxLength={60} value={details.vehicleMake} onChange={set("vehicleMake")} placeholder="Maruti" />
              {problems.vehicleMake && <small className="gs-field-problem" role="alert">{problems.vehicleMake}</small>}
            </label>
            <label className={`gs-field ${problems.vehicleModel ? "has-problem" : ""}`}>
              <span>Model</span><input maxLength={60} value={details.vehicleModel} onChange={set("vehicleModel")} placeholder="Swift" />
              {problems.vehicleModel && <small className="gs-field-problem" role="alert">{problems.vehicleModel}</small>}
            </label>
          </div>
        </>
      )}
      <label className="gs-field">
        <span>A note for the business <em>optional</em></span>
        <textarea rows={2} maxLength={300} value={details.note} onChange={set("note")} />
      </label>
      {advance !== null && <AdvanceBox page={page} amount={advance} details={details} set={set} problem={problems.advanceUtr} />}
      {page.advance?.deposits && <p className="ap-note"><Icon name="info" size={16} /> {page.card.name} takes an advance on bookings: they call you to take it as they confirm.</p>}
      <ConsentChoices privacy={page.card.privacy} purposes={page.consents} value={consents} onChange={setConsents} businessName={page.card.name} />
      {page.asks.adult && (
        <DeclarationCheck checked={details.adult} onChange={set("adult")} error={problems.adult}>
          I am 18 or over, or I am booking for my child as their parent or guardian.
        </DeclarationCheck>
      )}
      <input className="ap-website" tabIndex={-1} autoComplete="off" aria-hidden="true" value={details.website} onChange={set("website")} />
      <p className="ap-hint">
        {confirmMode || advance !== null || page.advance ? `${page.card.name} confirms your request, usually within ${page.link.expiryHours} hours; you'll see it on the next page.` : "Your time is booked as soon as you press Book now."}
        {" "}You can change or cancel it online until {page.link.cancelHours} {page.link.cancelHours === 1 ? "hour" : "hours"} before.
      </p>
    </div>
  );
}

function AdvanceBox({ page, amount, details, set, problem }) {
  const link = upiPayLink({ upiId: page.advance.upiId, payee: page.advance.payee || page.card.name, amount, note: `Advance for a booking at ${page.card.name}` });
  return (
    <section className="ap-advance" aria-label="Advance">
      <h2><Icon name="rupee" size={17} /> Pay the advance of {rupees(amount)}</h2>
      <p>{page.card.name} asks for {page.advance.percent}% in advance. Pay it by UPI, then type the payment's 12-digit UTR (in your UPI app, under the payment's details).</p>
      <a className="g-primary ap-upi" href={link}>Pay {rupees(amount)} with a UPI app</a>
      <p className="ap-upi-id">Or pay to <strong className="mono">{page.advance.upiId}</strong>{page.advance.payee ? ` (${page.advance.payee})` : ""}</p>
      <label className={`gs-field ${problem ? "has-problem" : ""}`}>
        <span>UTR of your payment</span>
        <input inputMode="numeric" maxLength={14} value={details.advanceUtr} onChange={(e) => set("advanceUtr")(e.target.value.replace(/[^\d ]/g, ""))} placeholder="12 digits" aria-invalid={Boolean(problem)} />
        {problem && <small className="gs-field-problem" role="alert">{problem}</small>}
      </label>
    </section>
  );
}

// --- The guest's own booking -----------------------------------------------------------------------

function StatusPage() {
  const { guestToken } = useParams();
  const location = useLocation();
  const [booking, setBooking] = useState(null);
  const [live, setLive] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(location.state?.message || "");
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [askCancel, setAskCancel] = useState(false);
  // Reads may overlap (a change heard as the page opens): only the newest one
  // asked is applied, so an older answer never undoes a newer one.
  const asked = useRef(0);
  const reload = useCallback(() => {
    const turn = (asked.current += 1);
    return getMine(guestToken).then((answer) => {
      if (turn !== asked.current) return;
      setBooking(answer.booking);
      setLive(answer.live);
      setError(null);
      rememberMine({ guestToken, business: answer.booking.card?.name, what: answer.booking.services.map((s) => s.label).join(" + "), person: answer.booking.person,
        startsAt: answer.booking.startsAt, link: answer.booking.bookAgain });
    }).catch((err) => {
      if (turn !== asked.current) return;
      setError({ message: guestErrorMessage(err, "the business"), gone: err?.response?.status === 404 });
      if (err?.response?.status === 404) forgetMine(guestToken);
    });
  }, [guestToken]);
  useEffect(() => { reload(); }, [reload]);
  const status = useGuestLive(live, reload, { fallbackMs: 15000 });
  useEffect(() => {
    if (booking) document.title = `Your booking · ${booking.card?.name || booking.services.map((s) => s.label).join(" + ")}`;
  }, [booking]);

  if (error && !booking) {
    return (
      <GuestShell card={null} context="Your booking">
        <GuestError heading="h1" title={error.gone ? "We couldn't find that booking" : "Couldn't open your booking"} message={error.message} onRetry={error.gone ? null : reload} />
      </GuestShell>
    );
  }
  if (!booking) return <GuestShell card={null} context="Your booking"><GuestSkeleton cards={2} label="Opening your booking" /></GuestShell>;

  const timeline = timelineOf(booking, timeOfIso);
  const phone = booking.card?.location?.phone;
  const open = ["requested", "booked"].includes(booking.status);
  async function cancel() {
    setBusy(true);
    try {
      const answer = await cancelMine(guestToken);
      setBooking(answer.data);
      setLive(answer.live || null);
      setNotice(answer.message);
      setAskCancel(false);
    } catch (err) {
      setNotice("");
      setError({ message: guestErrorMessage(err, "the business") });
    } finally {
      setBusy(false);
    }
  }
  return (
    <GuestShell card={booking.card} context="Your booking">
      <div className="ap-status">
        {notice && <p className="ap-ok" role="status"><Icon name="check-circle" size={17} /> {notice}</p>}
        {error && <p className="ap-error" role="alert"><Icon name="alert-circle" size={17} /> {error.message}</p>}
        <section className={`ap-card ap-hero is-${booking.tone}`}>
          <span className="ap-hero-label">{booking.statusLabel}</span>
          <h1 className="ap-hero-title">{booking.services.map((s) => s.label).join(" + ")}</h1>
          <p className="ap-hero-when"><Icon name="calendar" size={16} /> {booking.dateLabel}, {booking.timeLabel} – {booking.endTimeLabel}</p>
          <p className="ap-hero-who"><Icon name="user" size={16} /> With {booking.person}</p>
          {booking.next && <p className="ap-hero-next">{booking.next}</p>}
          <StatusSteps steps={timeline.steps} current={timeline.current} stopped={timeline.stopped} live={status} label="Your booking" />
        </section>

        {open && (
          <div className="ap-actions">
            <a className="g-secondary" href={calendarUrl(guestToken)} download><Icon name="calendar" size={16} /> Add to calendar</a>
            {mapsHref(booking.card) && <a className="g-secondary" href={mapsHref(booking.card)} target="_blank" rel="noopener noreferrer"><Icon name="map-pin" size={16} /> Directions</a>}
            {telHref(phone) && <a className="g-secondary" href={telHref(phone)}><Icon name="phone" size={16} /> Call</a>}
          </div>
        )}

        {booking.advance && booking.status === "requested" && (
          <p className="ap-note"><Icon name="rupee" size={16} /> Advance {rupees(booking.advance.amount)} · UTR <span className="mono">{booking.advance.utr}</span> · {booking.advance.received ? "received" : "being checked"}</p>
        )}

        <section className="ap-card">
          <h2 className="ap-card-title">Booking {booking.ref}</h2>
          <dl className="ap-facts">
            <div><dt>For</dt><dd>{booking.forWhom === "someone_else" ? booking.personName : booking.name}</dd></div>
            {booking.forWhom === "someone_else" && <div><dt>Booked by</dt><dd>{booking.name}</dd></div>}
            {booking.mobile && <div><dt>Mobile</dt><dd>{booking.mobile}</dd></div>}
            <div><dt>Time</dt><dd>{booking.services.map((s) => `${s.label} (${minutesText(s.minutes)})`).join(", ")}</dd></div>
            {booking.vehicle && <div><dt>Vehicle</dt><dd>{booking.vehicle.number} · {booking.vehicle.make} {booking.vehicle.model}</dd></div>}
            {booking.reason && <div><dt>Reason</dt><dd>{booking.reason}</dd></div>}
            {booking.note && <div><dt>Your note</dt><dd>{booking.note}</dd></div>}
          </dl>
        </section>

        {open && (booking.may.change || booking.may.cancel) && !changing && (
          <section className="ap-card ap-manage">
            <h2 className="ap-card-title">Need to change it?</h2>
            <p className="ap-hint">Online until {booking.cancelHours} {booking.cancelHours === 1 ? "hour" : "hours"} before{booking.may.change ? ` · ${booking.changesLeft} ${booking.changesLeft === 1 ? "change" : "changes"} left` : ""}.</p>
            <div className="ap-actions">
              {booking.may.change && <button type="button" className="g-secondary" onClick={() => { setChanging(true); setNotice(""); }}><Icon name="clock" size={16} /> Change the time</button>}
              {booking.may.cancel && !askCancel && <button type="button" className="g-secondary ap-danger" onClick={() => setAskCancel(true)}><Icon name="x" size={16} /> Cancel</button>}
            </div>
            {askCancel && (
              <div className="ap-confirm" role="alertdialog" aria-label="Cancel this booking?">
                <p>Cancel {booking.status === "requested" ? "this request" : "this booking"}? The time goes to someone else.</p>
                <div className="ap-actions">
                  <button type="button" className="g-secondary" onClick={() => setAskCancel(false)} disabled={busy}>Keep it</button>
                  <button type="button" className="g-primary ap-danger-solid" onClick={cancel} disabled={busy}>{busy ? "Cancelling…" : "Yes, cancel"}</button>
                </div>
              </div>
            )}
          </section>
        )}
        {open && booking.may.cutOffPassed && (
          <p className="ap-note"><Icon name="phone" size={16} /> It's less than {booking.cancelHours} hours away: to change or cancel it now, please {phone ? <a href={telHref(phone)}>call {phone}</a> : "call the business"}.</p>
        )}
        {changing && (
          <ChangeTime guestToken={guestToken} booking={booking} onClose={() => setChanging(false)}
            onMoved={(answer) => { setBooking(answer.data); setLive(answer.live || null); setNotice(answer.message); setChanging(false); }} />
        )}
        {!open && booking.bookAgain && (
          <p className="ap-again"><Link className="g-primary" to={`/appointments/${booking.bookAgain}`}><Icon name="calendar" size={16} /> Book again</Link></p>
        )}
        <p className="ap-hint ap-center"><Link to="/appointments">Your bookings on this phone</Link></p>
      </div>
    </GuestShell>
  );
}

function ChangeTime({ guestToken, booking, onClose, onMoved }) {
  const [date, setDate] = useState(booking.date);
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const loaders = useMemo(() => ({ days: () => changeDays(guestToken), times: (_s, d) => changeTimes(guestToken, d) }), [guestToken]);
  async function move() {
    setBusy(true);
    setError("");
    try {
      onMoved(await moveMine(guestToken, { date, time }));
    } catch (err) {
      setError(guestErrorMessage(err, "the business"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="ap-card ap-change" aria-label="Change the time">
      <h2 className="ap-card-title">Pick a new time</h2>
      <p className="ap-hint">Same {booking.services.length > 1 ? "services" : "service"}, with {booking.person}.</p>
      <TimeStep token="" selection={{ services: [], person: "own" }} today={booking.date} date={date} time={time} nextFree={[]} loaders={loaders}
        onDate={(value) => { setDate(value); setTime(""); }} onTime={setTime} onPickNext={() => {}} />
      {error && <p className="ap-error" role="alert"><Icon name="alert-circle" size={17} /> {error}</p>}
      <div className="ap-actions">
        <button type="button" className="g-secondary" onClick={onClose} disabled={busy}>Back</button>
        <button type="button" className="g-primary" onClick={move} disabled={!time || busy}>{busy ? "Moving…" : time ? `Move to ${dayLabelOf(date)}, ${clockLabelOf(time)}` : "Choose a time"}</button>
      </div>
    </section>
  );
}

// --- This phone's bookings -------------------------------------------------------------------------

function MinePage() {
  const [list] = useState(() => sortMine(allMine()));
  const [now] = useState(() => Date.now());
  useEffect(() => {
    document.title = "Your bookings";
  }, []);
  return (
    <main className="guest-app ap-mine-page">
      <div className="g-shell gs-main">
        <h1 className="ap-title">Your bookings</h1>
        {list.length ? (
          <ul className="ap-mine" role="list">
            {list.map((item) => {
              const past = Date.parse(item.startsAt || 0) < now;
              return (
                <li key={item.guestToken}>
                  <Link className={`ap-option ${past ? "is-past" : ""}`} to={`/appointments/status/${item.guestToken}`}>
                    <span className="ap-avatar" aria-hidden="true"><Icon name="calendar" size={17} /></span>
                    <span className="ap-option-main">
                      <strong>{item.what || "Booking"}</strong>
                      <span className="ap-option-meta">{item.business}{item.person ? ` · ${item.person}` : ""}</span>
                      {item.startsAt && <span className="ap-option-meta">{new Date(item.startsAt).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}{past ? " · past" : ""}</span>}
                    </span>
                    <Icon name="chevron-right" size={18} />
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <GuestEmpty icon="calendar" title="No bookings on this phone yet">The bookings you make on this phone show here, so you can find them again.</GuestEmpty>
        )}
        <section className="ap-card ap-how">
          <h2 className="ap-card-title">Booking an appointment</h2>
          <p>Open the booking link your salon, clinic, optical shop, garage or gym shared with you (on WhatsApp, Instagram or a QR at the counter). Choose the service, who you'd like, a day and a time, and you're booked, or the business confirms your request.</p>
          <p className="ap-hint">Each booking has its own page that changes by itself: keep its link, or find it here on this phone.</p>
        </section>
      </div>
    </main>
  );
}
