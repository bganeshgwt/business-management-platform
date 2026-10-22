import { useCallback, useEffect, useState } from "react";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { rememberedPageSize } from "../../../../components/DataGrid/useGridLayout";
import GuestPicker from "./GuestPicker";
import { createFeedback, listFeedback, setFeedbackStatus } from "../services/crm.service";
import { getErrorMessage } from "../../../../services/api";
import { count } from "@bmp/shared/format";
import { formatMobile, mobileHint } from "../../../../services/phone";
import { dateTime } from "../../../../services/guestBook";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import useQueryPatch from "./useQueryPatch";
import "../styles/crm.css";

const SOURCE_LABELS = {
  in_store: "In store",
  qr: "QR code",
  website: "Website",
  phone: "Phone",
  other: "Other",
};

const STATUS_LABELS = {
  new: "New",
  reviewed: "Reviewed",
  archived: "Archived",
};

// Each status as a colour, a dot and its word.
const STATUS_TONES = {
  new: "badge-warning",
  reviewed: "badge-success",
  archived: "badge-neutral",
};

// What each star count means, said beside the picker so staff record what a
// guest said the same way every time.
const RATING_WORDS = ["", "Very unhappy", "Unhappy", "It was fine", "Happy", "Delighted"];

const RATINGS = [
  { value: "", label: "All" },
  { value: "unhappy", label: "1–2★" },
  { value: "neutral", label: "3★" },
  { value: "happy", label: "4–5★" },
];

const EMPTY = {
  guest: null,
  customerName: "",
  customerMobile: "",
  rating: 5,
  comments: "",
  source: "in_store",
};

// The most the API hands back in one request (crm.controller listFeedback).
const API_MAX = 200;
const URL_DEFAULTS = { from: "0" };

// "1 response matches these filters", "No response matches…": the count and
// the verb agree.
const responseSummary = (total, filtered) => {
  if (total === 0) {
    return filtered ? "No response matches these filters." : "No responses yet.";
  }

  const what = `${count(total)} ${total === 1 ? "response" : "responses"}`;

  return filtered ? `${what} ${total === 1 ? "matches" : "match"} these filters.` : `${what}.`;
};

const Stars = ({ rating }) => (
  <span className={`stars crm-stars-${rating <= 2 ? "low" : rating >= 4 ? "high" : "mid"}`} title={`${rating} out of 5`}>
    <span aria-hidden="true">
      {"★".repeat(rating)}
      <span className="crm-stars-off">{"★".repeat(5 - rating)}</span>
    </span>
    <span className="crm-stars-num">{rating}</span>
  </span>
);

export default function FeedbackPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("feedback.manage");
  // The guest picker searches the guest book, which needs customers.view.
  const canPickGuest = hasPermission("customers.view");
  // A whole list with guests' names and numbers leaves the building only
  // with customers.export, as the guest book's own export does.
  const canExport = hasPermission("customers.export");

  const [data, setData] = useState(null);
  const [statusFilter] = useQueryFilter("status");
  const [ratingFilter] = useQueryFilter("rating");
  const [search] = useQueryFilter("q");
  const [offsetText, setOffsetText] = useQueryFilter("from", "0");
  const patch = useQueryPatch(URL_DEFAULTS);
  const [typed, setTyped] = useState(search);
  // The rows-per-page this viewer chose last time, so the first request
  // already asks for it.
  const [limit, setLimit] = useState(() => rememberedPageSize("crm-feedback", 25));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const offset = Math.max(0, Number(offsetText) || 0);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (typed.trim() !== search) {
        patch({ q: typed.trim(), from: 0 });
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [typed, search, patch]);

  const load = useCallback(
    () =>
      listFeedback({
        status: statusFilter || undefined,
        rating: ratingFilter || undefined,
        search: search || undefined,
        limit,
        offset,
      })
        .then((result) => {
          // A page that emptied (or an old link past the end) steps back to
          // the last page that has something on it.
          if (result.items.length === 0 && result.total > 0 && offset > 0) {
            setOffsetText(String(Math.floor((result.total - 1) / limit) * limit));
            return;
          }

          setData(result);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    [statusFilter, ratingFilter, search, limit, offset, setOffsetText]
  );

  useEffect(() => {
    load();
  }, [load]);

  // "Export CSV" takes every response that matches, not only the page on
  // show: the same list call, a page of 200 at a time.
  const fetchAll = async () => {
    const all = [];

    for (let at = 0; ; at += API_MAX) {
      const result = await listFeedback({
        status: statusFilter || undefined,
        rating: ratingFilter || undefined,
        search: search || undefined,
        limit: API_MAX,
        offset: at,
      });
      all.push(...result.items);

      if (result.items.length === 0 || all.length >= result.total) {
        return all;
      }
    }
  };

  const change = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  const save = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    try {
      await createFeedback({
        customerId: form.guest ? form.guest.id : null,
        customerName: form.guest ? null : form.customerName || null,
        customerMobile: form.guest ? null : form.customerMobile || null,
        rating: Number(form.rating),
        comments: form.comments || null,
        source: form.source,
      });

      setAdding(false);
      setSuccess("Feedback saved");
      setOffsetText("0");
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const mark = async (feedback, status) => {
    try {
      await setFeedbackStatus(feedback.id, status);
      load();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const summary = data ? data.summary : null;
  const items = data ? data.items : [];
  const hint = mobileHint(form.customerMobile);

  return (
    <div className="stack crm-page">
      <PageHeader
        icon="star"
        title="Feedback"
        description="How guests rated their visit: at the counter, by table QR code or online."
        action={
          canManage && (
            <button
              type="button"
              className="button"
              onClick={() => {
                setForm(EMPTY);
                setFormError("");
                setAdding(true);
              }}
            >
              <Icon name="plus" size={16} /> Record feedback
            </button>
          )
        }
      />

      {/* A list that failed to load says so inside the list (with Try
          again); this line is for everything else. */}
      <ErrorMessage message={data ? error : ""} />
      <SuccessMessage message={success} />

      {summary && (
        <div className="stat-grid">
          <StatTile
            icon="star"
            tone="warning"
            label="Average rating"
            value={summary.average ? `${summary.average.toFixed(1)} ★` : "—"}
            note={`From ${count(summary.total)} responses`}
          />
          <StatTile
            icon="smile"
            tone="success"
            label="Happy (4–5★)"
            value={count(summary.happy)}
            note={`${summary.total ? Math.round((summary.happy / summary.total) * 100) : 0}% of all responses`}
          />
          <StatTile
            icon="frown"
            tone="danger"
            label="Unhappy (1–2★)"
            value={count(summary.unhappy)}
            note="Worth a call back the same day"
          />
          <StatTile
            icon="bell"
            tone="info"
            label="Not reviewed yet"
            value={count(summary.unread)}
            note="Mark each one reviewed once read"
          />
        </div>
      )}

      <SectionCard
        icon="message"
        title="Responses"
        description={
          data
            ? `${responseSummary(data.total, Boolean(search || statusFilter || ratingFilter))} Read each one, then mark it reviewed.`
            : "Read each one, then mark it reviewed."
        }
        className="crm-list"
        flush
      >
        {data && data.searchLimited && (
          <p className="alert alert-info small crm-masked-note">
            For your role, part of a mobile finds a guest only by its last 4 digits. Type the whole number, or just the last 4.
          </p>
        )}

        <DataGrid
          id="crm-feedback"
          caption="Feedback responses"
          columns={[
            {
              key: "when",
              header: "When",
              type: "datetime",
              value: (item) => item.createdAt,
              mobile: "subtitle",
              render: (item) => <span className="small nowrap">{dateTime(item.createdAt)}</span>,
            },
            {
              key: "rating",
              header: "Rating",
              type: "number",
              align: "left",
              value: (item) => item.rating,
              mobile: "show",
              render: (item) => <Stars rating={item.rating} />,
            },
            {
              key: "guest",
              header: "Guest",
              value: (item) => item.customerName,
              mobile: "title",
              csv: (item) =>
                [item.customerName || "Anonymous", item.customerMobile ? formatMobile(item.customerMobile) || item.customerMobile : null]
                  .filter(Boolean)
                  .join(" · "),
              render: (item) => (
                <>
                  {item.customerName ? <span className="crm-strong">{item.customerName}</span> : <span className="muted">Anonymous</span>}
                  {item.customerMobile && <div className="muted small mono">{formatMobile(item.customerMobile) || item.customerMobile}</div>}
                </>
              ),
            },
            {
              key: "comments",
              header: "Comments",
              value: (item) => item.comments,
              mobile: "show",
              minWidth: 220,
              render: (item) => <span className="crm-comment">{item.comments || <span className="muted">—</span>}</span>,
            },
            {
              key: "source",
              header: "Source",
              value: (item) => SOURCE_LABELS[item.source] || item.source,
              render: (item) => <span className="small">{SOURCE_LABELS[item.source]}</span>,
            },
            {
              key: "status",
              header: "Status",
              type: "status",
              value: (item) => item.feedbackStatus,
              mobile: "show",
              csv: (item) => STATUS_LABELS[item.feedbackStatus] || item.feedbackStatus,
              render: (item) => (
                <span className={`badge status-badge ${STATUS_TONES[item.feedbackStatus] || "badge-neutral"}`}>
                  <span className="badge-dot" />
                  {STATUS_LABELS[item.feedbackStatus]}
                </span>
              ),
            },
            canManage && {
              key: "actions",
              header: "",
              label: "Actions",
              type: "actions",
              render: (item) => (
                <div className="row-actions">
                  {item.feedbackStatus === "new" && (
                    <button type="button" className="link-button crm-row-link" onClick={() => mark(item, "reviewed")}>
                      <Icon name="check" size={15} /> Mark reviewed
                    </button>
                  )}
                  {item.feedbackStatus !== "archived" && (
                    <button type="button" className="link-button crm-row-link crm-row-link-quiet" onClick={() => mark(item, "archived")}>
                      Archive
                    </button>
                  )}
                </div>
              ),
            },
          ]}
          rows={items}
          rowKey={(item) => item.id}
          loading={loading && !data}
          error={data ? "" : error}
          onRetry={load}
          empty={statusFilter || ratingFilter ? "No feedback matches these filters." : "No feedback yet."}
          emptyIcon={statusFilter || ratingFilter ? "search" : "star"}
          emptyHint="Guests rate their visit from the QR code on their table; staff can record what is said at the counter."
          rowNoun={["response", "responses"]}
          rowClassName={(item) => (item.feedbackStatus === "archived" ? "dg-tone-muted" : "")}
          exportName={canExport ? "feedback" : undefined}
          // The API pages and searches; it does not sort, so the headers do
          // not offer to (sorting 25 of 300 would only look like an answer).
          server={{
            total: data?.total ?? 0,
            page: Math.floor(offset / limit) + 1,
            pageSize: limit,
            fetchAll,
            onChange: ({ page, pageSize }) => {
              setLimit(pageSize);
              setOffsetText(String((page - 1) * pageSize));
            },
          }}
          search={{ value: typed, onChange: setTyped, placeholder: "Guest, mobile or comment" }}
          toolbar={
            <>
              <div className="field">
                <span>Rating</span>
                <div className="segmented" role="radiogroup" aria-label="Rating">
                  {RATINGS.map((option) => (
                    <button
                      key={option.value || "all"}
                      type="button"
                      role="radio"
                      aria-checked={ratingFilter === option.value}
                      className={`segment ${ratingFilter === option.value ? "is-active" : ""}`}
                      onClick={() => {
                        patch({ rating: option.value, from: 0 });
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <label className="field">
                <span>Status</span>
                <select
                  value={statusFilter}
                  onChange={(event) => {
                    patch({ status: event.target.value, from: 0 });
                  }}
                >
                  <option value="">All</option>
                  {Object.entries(STATUS_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          }
        />
      </SectionCard>

      {adding && (
        <Modal
          title="Record feedback"
          icon="star"
          description="What a guest told you at the counter or on the phone: the rating first, then their words."
          onClose={() => setAdding(false)}
          width={600}
        >
          <form className="form-grid" onSubmit={save}>
            <ErrorMessage message={formError} />

            <div className="field field-wide">
              <span>Rating *</span>
              <div className="crm-star-picker" role="radiogroup" aria-label="Rating">
                {[1, 2, 3, 4, 5].map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={Number(form.rating) === value}
                    aria-label={`${value} star${value === 1 ? "" : "s"}`}
                    className={`crm-star ${value <= Number(form.rating) ? "is-on" : ""}`}
                    onClick={() => setForm({ ...form, rating: value })}
                  >
                    ★
                  </button>
                ))}
                <span className="crm-star-word">
                  <strong>{form.rating} of 5</strong>
                  <span className="muted small">{RATING_WORDS[Number(form.rating)]}</span>
                </span>
              </div>
            </div>

            <label className="field">
              <span>Where it came from</span>
              <select value={form.source} onChange={change("source")}>
                {Object.entries(SOURCE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            {canPickGuest && (
              <GuestPicker
                value={form.guest}
                onChange={(guest) => setForm({ ...form, guest })}
                label="Guest in the book"
                hint="Optional. Search any guest by name or mobile."
              />
            )}

            {!form.guest && (
              <>
                <label className="field">
                  <span>Guest's name</span>
                  <input value={form.customerName} onChange={change("customerName")} maxLength={150} />
                </label>

                <label className="field">
                  <span>Mobile</span>
                  <input value={form.customerMobile} onChange={change("customerMobile")} inputMode="tel" maxLength={20} />
                  {hint ? (
                    <small className={hint.ok ? "crm-hint-ok" : "crm-hint-bad"}>{hint.text}</small>
                  ) : (
                    <small className="muted">If they are in the book, the feedback joins their record</small>
                  )}
                </label>
              </>
            )}

            <label className="field field-wide">
              <span>What they said</span>
              <textarea rows={3} value={form.comments} onChange={change("comments")} maxLength={1000} />
            </label>

            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving}>
                <Icon name="check" size={16} />
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
