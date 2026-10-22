// Online table booking on the host stand (SW-A-21): the inbox of requests
// guests send from the booking link, and the link itself — on or off, its
// limits, and the address and QR code to share.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import QRCode from "qrcode";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Modal from "../../../../components/Modal";
import ConfirmDialog from "../../../../components/ConfirmDialog";
import Icon from "@bmp/ui/Icon";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { getErrorMessage } from "../../../../services/api";
import { MONTH_NAMES } from "@bmp/shared/dates";
import { addressProblem, guestBase } from "../../../../services/qrSheet";
import { customerWebOrigin } from "../../../../services/customerWeb";
import {
  getOnlineBookingSettings,
  replaceOnlineBookingLink,
  updateOnlineBookingSettings,
} from "../services/reservation.service";

const OCCASION_WORDS = {
  birthday: "Birthday",
  anniversary: "Anniversary",
  business: "Business",
  date_night: "Date night",
  other: "Celebration",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const asUtc = (date) => {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};

const shortDate = (date) => {
  const day = asUtc(date);
  return `${WEEKDAYS[day.getUTCDay()]}, ${day.getUTCDate()} ${MONTH_NAMES[day.getUTCMonth()]}`;
};

const timeLabel = (time) => {
  const [hours, minutes] = String(time).split(":").map(Number);
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelve}:${String(minutes).padStart(2, "0")} ${hours < 12 ? "am" : "pm"}`;
};

const dayWord = (date, today) => {
  const offset = Math.round((asUtc(date) - asUtc(today)) / 86400000);

  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  return `In ${offset} days`;
};

// "4 min ago", "2 h ago", "yesterday" — how long the guest has been waiting
// for an answer, which is what decides who is answered first.
const waitingFor = (iso, now) => {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / 1440)} d ago`;
};

// --------------------------------------------------------------- the inbox

export function OnlineRequestsPanel({ requests, today, nowMs, canManage, onOpen, onAccept, onDecline, onSettings }) {
  const columns = useMemo(
    () => [
      {
        key: "when",
        header: "Wants",
        minWidth: 200,
        value: (row) => `${row.date} ${row.startTime}`,
        mobile: "subtitle",
        render: (row) => (
          <span className="obk-when">
            <strong>
              {shortDate(row.date)} · {timeLabel(row.startTime)}
            </strong>
            <span className={`obk-day ${row.date === today ? "is-today" : ""}`}>{dayWord(row.date, today)}</span>
          </span>
        ),
      },
      {
        key: "guest",
        header: "Guest",
        value: (row) => row.guestName,
        mobile: "title",
        pin: true,
        render: (row) => (
          <span className="obk-guest">
            <strong>{row.guestName}</strong>
            <span className="muted small">{row.guestMobile || "no mobile"}</span>
          </span>
        ),
      },
      { key: "party", header: "Guests", type: "number", value: (row) => row.partySize, mobile: "show", total: "sum" },
      {
        key: "asks",
        header: "Occasion & note",
        value: (row) => [OCCASION_WORDS[row.occasion], row.specialRequests].filter(Boolean).join(" · "),
        mobile: "show",
        render: (row) =>
          row.occasion || row.specialRequests ? (
            <span className="obk-asks">
              {row.occasion && (
                <span className="rsv-tag">
                  <Icon name="gift" size={12} /> {OCCASION_WORDS[row.occasion]}
                </span>
              )}
              {row.specialRequests && <span className="obk-note">{row.specialRequests}</span>}
            </span>
          ) : (
            <span className="muted">—</span>
          ),
      },
      {
        key: "asked",
        header: "Asked",
        type: "datetime",
        value: (row) => row.createdAt,
        mobile: "show",
        render: (row) => <span className="obk-asked">{waitingFor(row.createdAt, nowMs)}</span>,
      },
      { key: "reference", header: "Ref.", value: (row) => row.reference, defaultHidden: true },
      canManage && {
        key: "actions",
        header: "",
        label: "Answer",
        type: "actions",
        render: (row) => (
          <div className="row-actions obk-row-actions">
            <button type="button" className="button button-ghost button-sm" onClick={() => onDecline(row)}>
              Decline
            </button>
            <button type="button" className="button button-sm" onClick={() => onAccept(row)}>
              <Icon name="check" size={14} /> Accept
            </button>
          </div>
        ),
      },
    ],
    [today, nowMs, canManage, onAccept, onDecline]
  );

  if (requests.length === 0) {
    return null;
  }

  const covers = requests.reduce((sum, row) => sum + row.partySize, 0);
  const forToday = requests.filter((row) => row.date === today).length;

  return (
    <section className="card obk-inbox" aria-labelledby="obk-inbox-title">
      <div className="obk-inbox-head">
        <span className="section-card-icon tone-warning" aria-hidden="true">
          <Icon name="bell" size={18} />
        </span>
        <div className="obk-inbox-text">
          <h2 id="obk-inbox-title">
            Online requests <span className="obk-count">{requests.length}</span>
          </h2>
          <p className="muted small">
            {covers} {covers === 1 ? "guest" : "guests"} asked from your booking link
            {forToday > 0 ? ` · ${forToday} for today` : ""}. They hold no table until you accept; your answer shows on
            the guest&apos;s link straight away.
          </p>
        </div>
        <button type="button" className="button button-secondary button-sm" onClick={onSettings}>
          <Icon name="link" size={15} /> Booking link
        </button>
      </div>
      <DataGrid
        id="online-requests"
        caption="Online booking requests waiting for an answer"
        columns={columns}
        rows={requests}
        rowKey={(row) => row.id}
        onRowClick={onOpen}
        rowClassName={(row) => (row.date === today ? "dg-tone-warning" : "")}
        defaultSort={{ key: "asked", direction: "asc" }}
        rowNoun={["request", "requests"]}
        search={false}
        empty="No requests waiting"
      />
    </section>
  );
}

// --------------------------------------------------------------- the link

const NOTICE_CHOICES = [
  [0, "No notice — up to the time itself"],
  [30, "30 minutes"],
  [60, "1 hour"],
  [120, "2 hours"],
  [180, "3 hours"],
  [360, "6 hours"],
  [1440, "1 day"],
];
const AHEAD_CHOICES = [7, 14, 30, 60, 90];
const TABLE_TIME_CHOICES = [60, 75, 90, 105, 120, 150, 180];
const SHARE_CHOICES = [30, 40, 50, 60, 70, 80, 90, 100];

const formOf = (settings) => ({
  isEnabled: settings.isEnabled,
  maxPartySize: settings.maxPartySize,
  seatSharePercent: settings.seatSharePercent,
  minNoticeMinutes: settings.minNoticeMinutes,
  daysAhead: settings.daysAhead,
  durationMinutes: settings.durationMinutes,
  maxOpenPerMobile: settings.maxOpenPerMobile,
  blockedDates: settings.blockedDates || [],
  guestNote: settings.guestNote || "",
});

// Copying needs a secure page and a willing browser; the old way is tried
// when the modern one is refused, and the address stays on screen to copy by
// hand if both are.
const copyText = async (text) => {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Refused: try the old way below.
    }
  }

  const box = document.createElement("textarea");
  box.value = text;
  box.setAttribute("readonly", "");
  box.style.position = "fixed";
  box.style.opacity = "0";
  document.body.appendChild(box);
  box.select();

  let copied = false;

  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }

  box.remove();
  return copied;
};

export function OnlineBookingDialog({ canEdit, onClose, onSaved }) {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState("");
  const [newDate, setNewDate] = useState("");
  const [confirmNew, setConfirmNew] = useState(false);

  useEffect(() => {
    getOnlineBookingSettings()
      .then((data) => {
        setSettings(data);
        setForm(formOf(data));
      })
      .catch((err) => setLoadError(getErrorMessage(err)));
  }, []);

  const url = settings ? `${guestBase(settings.guestWebAddress, customerWebOrigin())}${settings.path}` : "";

  useEffect(() => {
    if (!url) {
      return;
    }

    QRCode.toDataURL(url, { width: 360, margin: 1, errorCorrectionLevel: "M" })
      .then(setQr)
      .catch(() => setQr(""));
  }, [url]);

  useEffect(() => {
    if (!copied) {
      return undefined;
    }

    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  const place = settings ? settings.placeName || "Main counter" : "";

  if (!settings || !form) {
    return (
      <Modal title="Online booking" icon="link" onClose={onClose} width={860}>
        {loadError ? <ErrorMessage message={loadError} /> : <Loading label="Opening the booking link…" />}
      </Modal>
    );
  }

  const set = (key) => (event) => {
    const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    setForm((current) => ({ ...current, [key]: value }));
  };

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");

    try {
      const result = await updateOnlineBookingSettings({
        ...form,
        maxPartySize: Number(form.maxPartySize),
        seatSharePercent: Number(form.seatSharePercent),
        minNoticeMinutes: Number(form.minNoticeMinutes),
        daysAhead: Number(form.daysAhead),
        durationMinutes: Number(form.durationMinutes),
        maxOpenPerMobile: Number(form.maxOpenPerMobile),
        guestNote: form.guestNote.trim() || null,
      });

      setSettings(result.data);
      setForm(formOf(result.data));
      onSaved(result.message);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const makeNewLink = async () => {
    setSaving(true);
    setError("");

    try {
      const result = await replaceOnlineBookingLink();
      setSettings(result.data);
      onSaved(result.message);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
      setConfirmNew(false);
    }
  };

  const addDate = () => {
    if (newDate && !form.blockedDates.includes(newDate)) {
      setForm((current) => ({ ...current, blockedDates: [...current.blockedDates, newDate].sort() }));
    }

    setNewDate("");
  };

  const problem = addressProblem(settings.guestWebAddress, customerWebOrigin());
  const room = settings.room;
  const disabled = !canEdit || saving;

  return (
    <Modal
      title={`Online booking · ${place}`}
      description="Guests ask for a table from this link. Requests land in your Reservations inbox for you to accept or decline."
      icon="link"
      onClose={onClose}
      width={860}
    >
      <div className="obk-dialog">
        <div className="obk-share">
          <div className="obk-share-main">
            <div className="obk-status-line">
              <span className={`obk-state ${settings.isEnabled ? "is-on" : "is-off"}`}>
                <span className="obk-state-dot" aria-hidden="true" />
                {settings.isEnabled ? "Taking bookings" : "Switched off"}
              </span>
              <span className="muted small">
                {room.seats} seats on {room.tables} {room.tables === 1 ? "table" : "tables"} · online guests may fill{" "}
                {room.onlineSeats} at a time
              </span>
            </div>
            <label className="field">
              <span>Booking link for {place}</span>
              <span className="obk-link-row">
                <input readOnly value={url} onFocus={(event) => event.target.select()} aria-label="Booking link" />
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => copyText(url).then(setCopied)}
                >
                  <Icon name={copied ? "check" : "copy"} size={15} /> {copied ? "Copied" : "Copy"}
                </button>
                <a className="button button-secondary" href={url} target="_blank" rel="noreferrer">
                  <Icon name="external" size={15} /> Open
                </a>
              </span>
              <small className="muted">
                Share it on Google, Instagram, WhatsApp or your website. Tables are never shown to guests.
              </small>
            </label>
            {problem && (
              <p className="alert alert-notice obk-address">
                This link uses a local address (this computer or the shop&apos;s own network), which guests&apos; phones
                cannot open. Set the guest
                web address under <Link to="/service/settings">Service settings</Link> before sharing it.
              </p>
            )}
            {!settings.hoursSet && (
              <p className="alert alert-notice obk-address">
                Opening hours are not set, so there are no times to offer. Set them under{" "}
                <Link to="/restaurant/hours">Business hours</Link>.
              </p>
            )}
            {canEdit && (
              <button type="button" className="link-button obk-new-link" onClick={() => setConfirmNew(true)} disabled={saving}>
                Make a new link (the old one stops working)
              </button>
            )}
          </div>
          <figure className="obk-qr">
            {qr ? <img src={qr} alt={`QR code for the ${place} booking link`} /> : <span className="obk-qr-blank" />}
            <figcaption>
              {qr && (
                <a href={qr} download={`booking-link-${place.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`}>
                  <Icon name="download" size={14} /> Download QR
                </a>
              )}
            </figcaption>
          </figure>
        </div>

        <form className="obk-form" onSubmit={save}>
          <ErrorMessage message={error} />
          {!canEdit && (
            <p className="muted small">Only a manager can switch online booking on or off and change its limits.</p>
          )}
          <label className={`obk-switch ${form.isEnabled ? "is-on" : ""}`}>
            <input
              type="checkbox"
              role="switch"
              checked={form.isEnabled}
              onChange={set("isEnabled")}
              disabled={disabled}
            />
            <span className="obk-switch-track" aria-hidden="true">
              <span className="obk-switch-thumb" />
            </span>
            <span>
              <strong>Take bookings online</strong>
              <small className="muted">
                {form.isEnabled
                  ? "Guests can ask for a table from the link."
                  : "The link tells guests to call you instead."}
              </small>
            </span>
          </label>

          <div className="form-grid obk-grid">
            <label className="field">
              <span>Largest party online</span>
              <select value={form.maxPartySize} onChange={set("maxPartySize")} disabled={disabled}>
                {Array.from({ length: 20 }, (_, index) => index + 1).map((size) => (
                  <option key={size} value={size}>
                    {size} {size === 1 ? "guest" : "guests"}
                  </option>
                ))}
              </select>
              <small className="muted">Bigger groups are asked to call you.</small>
            </label>
            <label className="field">
              <span>Seats online guests may fill</span>
              <select value={form.seatSharePercent} onChange={set("seatSharePercent")} disabled={disabled}>
                {SHARE_CHOICES.map((share) => (
                  <option key={share} value={share}>
                    {share}% · {Math.floor((room.seats * share) / 100)} of {room.seats} seats
                  </option>
                ))}
              </select>
              <small className="muted">The rest stay for walk-ins and regulars who phone.</small>
            </label>
            <label className="field">
              <span>Notice needed</span>
              <select value={form.minNoticeMinutes} onChange={set("minNoticeMinutes")} disabled={disabled}>
                {NOTICE_CHOICES.map(([minutes, words]) => (
                  <option key={minutes} value={minutes}>
                    {words}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Book up to</span>
              <select value={form.daysAhead} onChange={set("daysAhead")} disabled={disabled}>
                {AHEAD_CHOICES.map((days) => (
                  <option key={days} value={days}>
                    {days} days ahead
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Table time planned</span>
              <select value={form.durationMinutes} onChange={set("durationMinutes")} disabled={disabled}>
                {TABLE_TIME_CHOICES.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Open bookings per mobile</span>
              <select value={form.maxOpenPerMobile} onChange={set("maxOpenPerMobile")} disabled={disabled}>
                {[1, 2, 3, 4, 5].map((count) => (
                  <option key={count} value={count}>
                    {count} at a time
                  </option>
                ))}
              </select>
              <small className="muted">Stops one person holding every Saturday.</small>
            </label>
            <div className="field field-wide">
              <span>Days closed to online bookings</span>
              <div className="obk-dates">
                {form.blockedDates.length === 0 && <span className="muted small">None — every open day is offered.</span>}
                {form.blockedDates.map((date) => (
                  <span key={date} className="obk-date-chip">
                    {shortDate(date)}
                    {canEdit && (
                      <button
                        type="button"
                        aria-label={`Open ${shortDate(date)} again`}
                        onClick={() =>
                          setForm((current) => ({
                            ...current,
                            blockedDates: current.blockedDates.filter((item) => item !== date),
                          }))
                        }
                        disabled={disabled}
                      >
                        <Icon name="x" size={12} />
                      </button>
                    )}
                  </span>
                ))}
              </div>
              {canEdit && (
                <span className="obk-date-add">
                  <input
                    type="date"
                    value={newDate}
                    onChange={(event) => setNewDate(event.target.value)}
                    aria-label="Date to close to online bookings"
                    disabled={disabled}
                  />
                  <button type="button" className="button button-secondary button-sm" onClick={addDate} disabled={!newDate || disabled}>
                    Close this day
                  </button>
                </span>
              )}
              <small className="muted">A private function or a festival with walk-ins only. Days you are shut are closed already.</small>
            </div>
            <label className="field field-wide">
              <span>Note for guests</span>
              <textarea
                rows={2}
                value={form.guestNote}
                onChange={set("guestNote")}
                maxLength={300}
                disabled={disabled}
                placeholder="Tables are held for 15 minutes. For groups above 8, please call us."
              />
            </label>
          </div>

          <div className="form-actions">
            <button type="button" className="button button-secondary" onClick={onClose}>
              Close
            </button>
            {canEdit && (
              <button type="submit" className="button" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            )}
          </div>
        </form>
      </div>

      {confirmNew && (
        <ConfirmDialog
          title="Make a new booking link?"
          message="Every copy of the current link — on Google, Instagram or printed cards — stops working at once. Guests who already booked keep their own status links."
          confirmLabel="Make a new link"
          busy={saving}
          onConfirm={makeNewLink}
          onCancel={() => setConfirmNew(false)}
        />
      )}
    </Modal>
  );
}
