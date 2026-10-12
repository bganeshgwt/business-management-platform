import { useEffect, useState } from "react";
import PageHeader from "../../../../components/PageHeader";
import SectionCard from "../../../../components/SectionCard";
import Icon from "../../../../components/Icon";
import { SettingsSaveBar } from "../../../../components/SettingsLayout";
import { toast } from "../../../../services/toast";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import { getBusinessHours, updateBusinessHours } from "../services/restaurant.service";
import { getErrorMessage } from "../../../../services/api";
import useAuth from "../../../../hooks/useAuth";
import "../../../../styles/reports.css";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const minutesOf = (time) => {
  const [hours, minutes] = String(time).split(":").map(Number);
  return hours * 60 + minutes;
};

// How long a day's service runs, said the way a manager would: "13 h",
// "14 h 30 m". A close earlier than the open runs past midnight, so the
// hours carry over into the next day. Only a reading aid — what is saved is
// the two times, exactly as typed.
const serviceLength = (open, close) => {
  if (!open || !close || open === close) {
    return null;
  }

  const start = minutesOf(open);
  const end = minutesOf(close);
  const pastMidnight = end < start;
  const total = pastMidnight ? 24 * 60 - start + end : end - start;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;

  return { text: minutes ? `${hours} h ${minutes} m` : `${hours} h`, pastMidnight };
};

export default function BusinessHoursPage() {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("restaurant.settings.manage");

  const [days, setDays] = useState([]);
  // What the server last said, so the save bar knows about unsaved changes.
  const [saved, setSaved] = useState([]);
  const [savedAt, setSavedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    getBusinessHours()
      .then((loaded) => {
        setDays(loaded);
        setSaved(loaded);
      })
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  const updateDay = (index, changes) =>
    setDays(days.map((day, position) => (position === index ? { ...day, ...changes } : day)));
  const updatePeriod = (dayIndex, periodIndex, changes) => updateDay(dayIndex, {
    periods: days[dayIndex].periods.map((period, index) => index === periodIndex ? { ...period, ...changes } : period),
  });

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setSuccess("");
    setSaving(true);

    try {
      // Closed days send no times, matching what the API expects.
      const payload = days.map((day) => ({
        dayOfWeek: day.dayOfWeek,
        isOpen: day.isOpen,
        openTime: day.isOpen ? day.openTime : null,
        closeTime: day.isOpen ? day.closeTime : null,
        periods: day.isOpen ? day.periods : [],
      }));

      const stored = await updateBusinessHours(payload);
      setDays(stored);
      setSaved(stored);
      setSavedAt(new Date());
      toast.success("Business hours saved");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <Loading />;
  }

  const openDays = days.filter((day) => day.isOpen).length;
  const dirty = canEdit && JSON.stringify(days) !== JSON.stringify(saved);

  return (
    <div className="stack hours-page">
      <PageHeader
        icon="clock"
        title="Business hours"
        description="When the restaurant opens and closes, day by day."
      />

      {/* What the hours are used for, so they are kept true. */}
      <p className="alert alert-info">
        The bell uses these hours to warn when the day has not been opened during service, and when
        yesterday&apos;s day is still open the next morning.
      </p>

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      <SectionCard
        as="form"
        onSubmit={handleSubmit}
        icon="calendar"
        title="Weekly hours"
        description={`Open ${openDays} of 7 days. A closing time earlier than the opening time runs past midnight.`}
        flush
      >
        <div className="hours-list">
          {days.map((day, index) => {
            const periods = day.periods?.length ? day.periods : [{ openTime: day.openTime || "10:00", closeTime: day.closeTime || "23:00" }];
            const length = day.isOpen ? serviceLength(periods[0].openTime, periods[periods.length - 1].closeTime) : null;

            return (
              <div className={`hours-row ${day.isOpen ? "" : "is-closed"}`} key={day.dayOfWeek}>
                <span className="hours-day">{DAY_NAMES[day.dayOfWeek]}</span>

                <label className="checkbox hours-toggle">
                  <input
                    type="checkbox"
                    checked={day.isOpen}
                    onChange={(event) => updateDay(index, { isOpen: event.target.checked })}
                    disabled={!canEdit}
                  />
                  <span>Open</span>
                </label>

                {day.isOpen ? (
                  <div className="stack">
                    {periods.map((period, periodIndex) => <div className="hours-times" key={periodIndex}>
                      <input type="time" aria-label={`${DAY_NAMES[day.dayOfWeek]} period ${periodIndex + 1} opens`} value={period.openTime} onChange={(event) => updatePeriod(index, periodIndex, { openTime: event.target.value })} disabled={!canEdit} required />
                      <span className="muted">to</span>
                      <input type="time" aria-label={`${DAY_NAMES[day.dayOfWeek]} period ${periodIndex + 1} closes`} value={period.closeTime} onChange={(event) => updatePeriod(index, periodIndex, { closeTime: event.target.value })} disabled={!canEdit} required />
                      {canEdit && periods.length > 1 && <button type="button" className="chip-button" onClick={() => updateDay(index, { periods: periods.filter((_, at) => at !== periodIndex) })}>Remove</button>}
                    </div>)}
                    {canEdit && periods.length < 3 && <button type="button" className="chip-button" onClick={() => updateDay(index, { periods: [...periods, { openTime: "18:00", closeTime: "23:00" }] })}>+ Add service period</button>}
                  </div>
                ) : (
                  <span className="hours-closed-note">Closed all day</span>
                )}

                <span className="hours-length">
                  {day.isOpen ? (
                    length && (
                      <span className={`badge status-badge ${length.pastMidnight ? "badge-info" : "badge-active"}`}>
                        <Icon name={length.pastMidnight ? "moon" : "sun"} size={12} />
                        {length.text}
                        {length.pastMidnight ? " · past midnight" : ""}
                      </span>
                    )
                  ) : (
                    <span className="badge badge-neutral status-badge">
                      <span className="badge-dot" aria-hidden="true" />
                      Closed
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>

        <SettingsSaveBar
          dirty={dirty}
          saving={saving}
          savedAt={savedAt}
          disabled={!canEdit}
          saveLabel="Save hours"
          onReset={() => setDays(saved)}
        />
      </SectionCard>

      {!canEdit && (
        <p className="muted small">Only someone who manages the restaurant&apos;s settings can change the hours.</p>
      )}
    </div>
  );
}
