import { useCallback, useEffect, useState } from "react";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import ConfirmDialog from "../../../../components/ConfirmDialog";
import ActionMenu from "../../../../components/ActionMenu";
import Icon from "@bmp/ui/Icon";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { rememberedPageSize } from "../../../../components/DataGrid/useGridLayout";
import CustomerHistoryModal from "./CustomerHistoryModal";
import GuestFormModal from "./GuestFormModal";
import MergeGuestsModal from "./MergeGuestsModal";
import EraseGuestModal from "./EraseGuestModal";
import GuestDuplicates from "./GuestDuplicates";
import GuestReports from "./GuestReports";
import GuestAvatar from "./GuestAvatar";
import GuestOccasion from "./GuestOccasion";
import SheetImportModal from "../../inventory/pages/SheetImportModal";
import {
  deleteCustomer,
  exportGuestBook,
  getGuestImportGuide,
  importGuests,
  listGuestBook,
} from "../services/crm.service";
import { getSettings } from "../../setup/services/restaurant.service";
import { getErrorMessage } from "../../../../services/api";
import { count, money } from "@bmp/shared/format";
import { downloadCsv } from "../../../../services/csv";
import { GUEST_TAGS, guestBookSheet, shortDate, sinceText, tagLabel } from "../../../../services/guestBook";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter, { useQueryFlag } from "../../../../hooks/useQueryFilter";
import useQueryPatch from "./useQueryPatch";
import "../styles/crm.css";

const STATUSES = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "all", label: "All" },
  { value: "erased", label: "Erased" },
];

// What each filter in the address bar is when it is not there. The book opens
// on the guests seen most recently (A to Z filled page one with people who
// never came).
const URL_DEFAULTS = { tab: "book", status: "active", sort: "lastVisit", from: "0" };

// Quick views, worked out by the server (GET /crm/guest-book?view=…). Top
// spenders also sorts by spend. "Lapsed" is the restaurant's own number of
// days (Settings -> Alerts and timings, the one Guest insights uses too),
// which the guest book answers with.
const viewsFor = (lapsedDays) => [
  { value: "occasion", label: "Occasion this week", icon: "gift", hint: "A birthday or anniversary in the next 7 days" },
  { value: "lapsed", label: `Lapsed ${lapsedDays}+ days`, icon: "clock", hint: `Came before, but not in the last ${lapsedDays} days` },
  { value: "top", label: "Top spenders", icon: "star", hint: "Everyone who has spent, biggest first", sort: "spend" },
];

// A WhatsApp chat with the guest (wa.me wants the country code and digits
// only). Only for a full number: a masked one has X's in it.
const whatsAppLink = (mobile) => {
  const digits = String(mobile || "").replace(/\D/g, "");

  if (!mobile || /x/i.test(mobile) || digits.length < 10) {
    return null;
  }

  return `https://wa.me/${digits.length === 10 ? `91${digits}` : digits}`;
};

// Names read A to Z; every number reads biggest first. A sort in that
// natural order stays out of the address ("dir" is left off).
const FIRST_DIRECTION = { name: true, visits: false, lastVisit: false, spend: false, points: false };

// The icon beside each tab, so the three read apart at a glance.
const TAB_ICONS = { book: "book", duplicates: "copy", reports: "chart" };

export default function CustomersPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission("customers.manage");
  const canMerge = hasPermission("customers.merge");
  const canErase = hasPermission("customers.erase");
  const canExport = hasPermission("customers.export");
  const canSeePoints = hasPermission("reports.view");
  const canSeeSales = hasPermission("sales.view");

  const [tab, setTab] = useQueryFilter("tab", "book");
  // The guest list from the old system, points balances included (sweep
  // SW-B-13). It brings in every mobile number, so it needs both the right
  // to manage guests and the right to export them.
  const canImport = canManage && canExport;
  const [importing, setImporting] = useState(false);
  const [importMode, setImportMode] = useState("update");
  const [search] = useQueryFilter("q");
  const [status] = useQueryFilter("status", "active");
  const [tag] = useQueryFilter("tag");
  const [optedIn] = useQueryFlag("offers");
  const [business] = useQueryFlag("gst");
  const [sortKey] = useQueryFilter("sort", "lastVisit");
  const [view] = useQueryFilter("view");
  const [direction] = useQueryFilter("dir", "");
  const [offsetText, setOffsetText] = useQueryFilter("from", "0");
  const patch = useQueryPatch(URL_DEFAULTS);
  // The rows-per-page this viewer chose last time, so the first request
  // already asks for it.
  const [limit, setLimit] = useState(() => rememberedPageSize("crm-guest-book", 25));

  const [typed, setTyped] = useState(search);
  const [book, setBook] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [currency, setCurrency] = useState("₹");

  const [editing, setEditing] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [merging, setMerging] = useState(null);
  const [erasing, setErasing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [blocked, setBlocked] = useState(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  const offset = Math.max(0, Number(offsetText) || 0);
  const ascending = direction ? direction === "asc" : FIRST_DIRECTION[sortKey] ?? true;

  // The search box waits for a pause in typing before it asks the server.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (typed.trim() !== search) {
        patch({ q: typed.trim(), from: 0 });
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [typed, search, patch]);

  const filters = {
    search: search || undefined,
    status,
    tag: tag || undefined,
    optedIn: optedIn ? "true" : undefined,
    business: business ? "true" : undefined,
    view: view || undefined,
    sort: sortKey,
    dir: ascending ? "asc" : "desc",
  };
  const filterKey = JSON.stringify(filters);

  const load = useCallback(
    () =>
      listGuestBook({ ...JSON.parse(filterKey), limit, offset })
        .then((data) => {
          // The page emptied under us (its only guest was erased, deleted or
          // merged, or an old link points past the end): step back to the
          // last page that has guests rather than show an empty book.
          if (data.items.length === 0 && data.total > 0 && offset > 0) {
            setOffsetText(String(Math.floor((data.total - 1) / limit) * limit));
            return;
          }

          setBook(data);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    [filterKey, limit, offset, setOffsetText]
  );

  useEffect(() => {
    load();
  }, [load]);

  // The history panel and the reports show money, so they need the currency.
  useEffect(() => {
    getSettings()
      .then((settings) => setCurrency(settings.currencySymbol))
      .catch(() => setCurrency("₹"));
  }, []);

  // A new filter starts the list again from its first page, in one update.
  const refilter = (key) => (value) => patch({ [key]: value, from: 0 });

  // The server sorts the guest book, so the grid's header clicks (and the
  // phone's "Sort by") come here. The grid's third click ("list order") has
  // no meaning for a sorted list: it turns the column round instead.
  const onGridChange = ({ page, pageSize, sort: next }) => {
    setLimit(pageSize);
    const key = next ? next.key : sortKey;
    const ascendingNext = next ? next.direction === "asc" : !ascending;

    if (key !== sortKey || ascendingNext !== ascending) {
      const natural = FIRST_DIRECTION[key] ?? true;
      patch({ sort: key, dir: ascendingNext === natural ? "" : ascendingNext ? "asc" : "desc", from: 0 });
      return;
    }

    setOffsetText(String((page - 1) * pageSize));
  };

  const done = (message) => {
    setSuccess(message);
    setError("");
    load();
  };

  const confirmDelete = async () => {
    setBusy(true);

    try {
      await deleteCustomer(deleting.id);
      setDeleting(null);
      done(`${deleting.name} deleted`);
    } catch (err) {
      const reason = err.response?.data?.data?.reason;
      setDeleting(null);

      if (reason === "has_history") {
        setBlocked({ guest: deleting, message: getErrorMessage(err) });
      } else {
        setError(getErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  // A guest with visits or points can never be deleted (their bills must be
  // kept), and the row already says so: explain at once rather than asking
  // "are you sure?" for a delete the server will refuse. The server still
  // checks feedback and complaints the row does not show.
  const askDelete = (guest) => {
    if (guest.visits > 0 || guest.loyaltyPoints > 0) {
      const held = [
        guest.visits > 0 ? `${count(guest.visits)} visit${guest.visits === 1 ? "" : "s"}` : null,
        guest.loyaltyPoints > 0 ? `${count(guest.loyaltyPoints)} points` : null,
      ].filter(Boolean);

      setBlocked({
        guest,
        message:
          `${guest.name} has ${held.join(" and ")} on record, so the record cannot be deleted: bills must be kept. ` +
          (canErase
            ? "If the guest asked for their data to be removed, use “Erase personal details”, which keeps the bills and removes who they are."
            : "If the guest asked for their data to be removed, ask a manager to erase their personal details: the bills stay, who they are goes."),
      });
      return;
    }

    setDeleting(guest);
  };

  const exportCsv = async () => {
    setExporting(true);

    try {
      const data = await exportGuestBook(filters);
      downloadCsv(guestBookSheet(data.items), `guest-book-${status}${search ? "-matching" : ""}-${new Date().toLocaleDateString("en-CA")}.csv`);
      setSuccess(
        data.truncated
          ? `Exported the first ${count(data.cap)} of ${count(data.total)} guests. Narrow the filter for the rest.`
          : `Exported ${count(data.items.length)} guests. The export is on the activity log.`
      );
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  const counts = book ? book.counts : null;
  const lapsedDays = book?.lapsedDays ?? 45;
  const items = book ? book.items : [];
  const hidden = items.some((row) => row.contactHidden);
  const showReports = canSeePoints || canSeeSales;
  const tabs = [
    { key: "book", label: "Guest book" },
    { key: "duplicates", label: "Possible duplicates", count: counts ? counts.duplicates : 0 },
    ...(showReports ? [{ key: "reports", label: "Points & guest sales" }] : []),
  ];
  const activeTab = tabs.some((t) => t.key === tab) ? tab : "book";
  const statusLabel = (STATUSES.find((option) => option.value === status) || STATUSES[0]).label.toLowerCase();

  // Every label fits on one line of the menu, and there is no separator line.
  // The shared menu decides whether to open up or down from a fixed height per
  // item and does not count separators, so a label that wrapped to two lines
  // (or a separator) made it think it fitted when it did not: it ran off the
  // bottom of the window, taking Erase and Delete with it. The two red items
  // still read apart by their colour and icons; the dialog each one opens
  // says the rest.
  const rowActions = (guest) => {
    const actions = [{ label: "Open history", icon: "history", onClick: () => setViewing(guest) }];

    if (guest.erased) {
      return actions;
    }

    if (canManage) {
      actions.push({ label: "Edit guest", icon: "edit", onClick: () => setEditing(guest) });
    }

    if (canMerge) {
      actions.push({ label: "Merge records…", icon: "users", onClick: () => setMerging(guest) });
    }

    if (canErase) {
      actions.push({ label: "Erase details…", icon: "eye-off", danger: true, onClick: () => setErasing(guest) });
    }

    if (canManage) {
      actions.push({ label: "Delete guest…", icon: "trash", danger: true, onClick: () => askDelete(guest) });
    }

    return actions;
  };

  // "1 active guest matches these filters", "No active guest matches…",
  // "12 active guests in the book": the count and the verb agree.
  const bookSummary = () => {
    const filtered = Boolean(search || tag || optedIn || business || view);
    const kind = statusLabel === "all" ? "" : `${statusLabel} `;

    if (book.total === 0) {
      return filtered ? `No ${kind}guest matches these filters.` : `No ${kind}guests.`;
    }

    const who = `${count(book.total)} ${kind}${book.total === 1 ? "guest" : "guests"}`;

    if (filtered) {
      return `${who} ${book.total === 1 ? "matches" : "match"} these filters.`;
    }

    return statusLabel === "all" ? `${who} in all.` : `${who}.`;
  };

  return (
    <div className="stack crm-page">
      <PageHeader
        icon="users"
        title="Customers"
        description="Who comes, how often, what they spend, and who agreed to hear from you."
        action={
          <div className="header-actions">
            {canExport && activeTab === "book" && (
              <button type="button" className="button button-secondary" onClick={exportCsv} disabled={exporting}>
                <Icon name="download" size={16} />
                {exporting ? "Preparing…" : "Export CSV"}
              </button>
            )}
            {canImport && (
              <button type="button" className="button button-secondary" onClick={() => setImporting(true)}>
                <Icon name="upload" size={16} /> Import
              </button>
            )}
            {canManage && (
              <button type="button" className="button" onClick={() => setEditing({})}>
                <Icon name="user-plus" size={16} /> Add guest
              </button>
            )}
          </div>
        }
      />

      {importing && (
        <SheetImportModal
          title="Import guests from a spreadsheet"
          description="The guest list from your old system — birthdays, anniversaries, GST details, offers consent and points balances — checked row by row first."
          noun="guest"
          nounPlural="guests"
          sampleName="guests-sample.csv"
          loadGuide={getGuestImportGuide}
          runImport={importGuests}
          options={{ mode: importMode }}
          optionsControl={
            <div className="field crm-import-mode">
              <span id="crm-import-mode">A mobile already in the guest book</span>
              <div className="segmented" role="radiogroup" aria-labelledby="crm-import-mode">
                <button
                  type="button"
                  role="radio"
                  aria-checked={importMode === "update"}
                  className={`segment ${importMode === "update" ? "is-active" : ""}`}
                  onClick={() => setImportMode("update")}
                >
                  Update the guest
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={importMode === "skip"}
                  className={`segment ${importMode === "skip" ? "is-active" : ""}`}
                  onClick={() => setImportMode("skip")}
                >
                  Leave them as they are
                </button>
              </div>
              <small className="muted">Never a second card for the same number: +91, a leading 0 and spaces are read as the same mobile.</small>
            </div>
          }
          lead="A guest is found by their mobile (or their email when there is none). Only the columns in your file change, and opening points go in once, as 'Opening balance (import)' on the points history."
          promises={[
            {
              title: "Points add up.",
              text: "Opening points land in the points ledger, so points owed and the loyalty report agree to the point.",
            },
          ]}
          describeRow={(row) =>
            [row.mobileDisplay, row.points ? `${count(row.points)} opening points` : null].filter(Boolean).join(" · ")
          }
          extraTiles={(check) =>
            check.openingPoints ? (
              <StatTile
                size="sm"
                icon="gift"
                tone="primary"
                label="Opening points"
                value={count(check.openingPoints.points)}
                note={`${count(check.openingPoints.guests)} guest${check.openingPoints.guests === 1 ? "" : "s"}${check.skipped ? ` · ${count(check.skipped)} left as they are` : ""}`}
              />
            ) : null
          }
          onClose={() => setImporting(false)}
          onImported={(message) => {
            setImporting(false);
            setSuccess(message);
            load();
          }}
        />
      )}

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      <div className="tab-row crm-tabs" role="tablist" aria-label="Customers">
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={activeTab === item.key}
            className={`tab ${activeTab === item.key ? "active" : ""}`}
            onClick={() => setTab(item.key === "book" ? "" : item.key)}
          >
            <Icon name={TAB_ICONS[item.key]} size={15} />
            {item.label}
            {item.count > 0 && <span className="crm-tab-count">{count(item.count)}</span>}
          </button>
        ))}
      </div>

      {activeTab === "duplicates" && (
        <GuestDuplicates canMerge={canMerge} currency={currency} onChanged={load} />
      )}

      {activeTab === "reports" && (
        <GuestReports currency={currency} canSeePoints={canSeePoints} canSeeSales={canSeeSales} canExport={canExport} />
      )}

      {activeTab === "book" && (
        <>
          {counts && (
            <div className="stat-grid">
              <StatTile
                icon="users"
                tone="primary"
                label="Guests in the book"
                value={count(counts.active)}
                note={`${count(counts.inactive)} inactive${counts.erased ? ` · ${count(counts.erased)} erased on request` : ""}`}
              />
              <StatTile
                icon="message"
                tone="success"
                label="Said yes to offers"
                value={count(counts.opted_in)}
                note={`${counts.active ? Math.round((counts.opted_in / counts.active) * 100) : 0}% of active guests can be sent offers`}
              />
              <StatTile
                icon="receipt"
                tone="info"
                label="Business guests"
                value={count(counts.business)}
                note="With a GSTIN for a B2B tax invoice"
              />
              <StatTile
                icon="gift"
                tone="violet"
                label="Points owed"
                value={count(counts.points)}
                note="Across every guest, today"
              />
            </div>
          )}

          {counts && counts.duplicates > 0 && (
            <div className="alert alert-notice crm-dup-banner">
              <span>
                <strong>{count(counts.duplicates)}</strong> {counts.duplicates === 1 ? "guest is" : "guests are"} probably
                on file twice (the same mobile typed two ways). Their points and visits are split until they are merged.
              </span>
              <button type="button" className="button button-secondary button-sm" onClick={() => setTab("duplicates")}>
                Review <Icon name="arrow-right" size={15} />
              </button>
            </div>
          )}

          <SectionCard
            icon="book"
            title="Guest book"
            description={
              book
                ? `${bookSummary()} Click a name for their visits, points and contact details.`
                : "Click a name for their visits, points and contact details."
            }
            className="crm-list"
            flush
          >
            {hidden && (
              <p className="alert alert-info small crm-masked-note">
                Mobiles and emails show only their last digits for your role. Search finds a guest by their whole
                number or its last 4 digits; open their history to show one number (that is on the activity log).
              </p>
            )}

            {book && book.searchLimited && (
              <p className="alert alert-info small crm-masked-note">
                For your role, part of a mobile finds a guest only by its last 4 digits. Type the whole number, or just the last 4.
              </p>
            )}

            <DataGrid
              id="crm-guest-book"
              caption="Guest book"
              columns={[
                {
                  key: "name",
                  header: "Guest",
                  value: (guest) => guest.name,
                  mobile: "title",
                  render: (guest) => (
                    <div className="crm-guest">
                      <GuestAvatar guest={guest} />
                      <div className="crm-guest-text">
                        <div className="crm-guest-line">
                          <button type="button" className="link-button crm-guest-name" onClick={() => setViewing(guest)}>
                            {guest.name}
                          </button>
                          {guest.status === "inactive" && !guest.erased && (
                            <span className="badge badge-neutral status-badge">
                              <span className="badge-dot" />
                              Inactive
                            </span>
                          )}
                          {guest.tags.map((value) => (
                            <span key={value} className={`crm-tag crm-tag-${value}`}>
                              {tagLabel(value)}
                            </span>
                          ))}
                        </div>
                        {view === "occasion" && !guest.erased && <GuestOccasion guest={guest} />}
                        {(guest.companyName || guest.allergies || guest.erased) && (
                          <div className="small crm-guest-sub">
                            {guest.erased ? (
                              <span className="muted">Details erased on request {shortDate(guest.erasedAt)}</span>
                            ) : (
                              <>
                                {guest.companyName && (
                                  <span className="muted">
                                    {guest.companyName}
                                    {guest.gstin ? ` · GST ${guest.gstin}` : ""}
                                  </span>
                                )}
                                {guest.allergies && (
                                  <span className="crm-allergy">
                                    <Icon name="alert" size={13} />
                                    Allergic to {guest.allergies}
                                  </span>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ),
                },
                {
                  key: "mobile",
                  header: "Mobile",
                  value: (guest) => guest.mobileDisplay,
                  sortable: false,
                  mobile: "subtitle",
                  render: (guest) => {
                    // WhatsApp only for guests who said yes to offers, and
                    // only where this person may see the whole number.
                    const chat = guest.marketingOptIn && !guest.erased && !guest.contactHidden ? whatsAppLink(guest.mobile) : null;

                    return (
                      <span className="nowrap crm-mobile-cell">
                        <span className="mono">{guest.mobileDisplay || <span className="muted">—</span>}</span>
                        {chat && (
                          <a
                            className="link-button small crm-wa-link"
                            href={chat}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`WhatsApp ${guest.name}`}
                            title="Said yes to offers: open a WhatsApp chat"
                          >
                            <Icon name="message" size={14} /> WhatsApp
                          </a>
                        )}
                      </span>
                    );
                  },
                },
                { key: "visits", header: "Visits", type: "number", value: (guest) => guest.visits, mobile: "show" },
                {
                  key: "lastVisit",
                  header: "Last visit",
                  type: "date",
                  value: (guest) => guest.lastVisit,
                  mobile: "show",
                  render: (guest) =>
                    guest.lastVisit ? (
                      <span className="nowrap">
                        {shortDate(guest.lastVisit)}
                        <div className="muted small">{sinceText(guest.lastVisit)}</div>
                      </span>
                    ) : (
                      <span className="muted">Not yet</span>
                    ),
                },
                {
                  key: "spend",
                  header: "Total spend",
                  type: "money",
                  value: (guest) => guest.spend,
                  mobile: "show",
                  render: (guest) => <span className="crm-strong">{money(guest.spend, currency)}</span>,
                },
                { key: "points", header: "Points", type: "number", value: (guest) => guest.loyaltyPoints, mobile: "show" },
                {
                  key: "offers",
                  header: "Offers",
                  type: "status",
                  value: (guest) => (guest.marketingOptIn ? "yes" : "no"),
                  sortable: false,
                  render: (guest) =>
                    guest.marketingOptIn ? (
                      <span className="badge badge-success status-badge" title={`Recorded ${shortDate(guest.marketingOptInAt)}`}>
                        <span className="badge-dot" />
                        Yes
                      </span>
                    ) : (
                      <span className="muted small">No</span>
                    ),
                },
                {
                  key: "actions",
                  header: "",
                  label: "Actions",
                  type: "actions",
                  render: (guest) => (
                    <div className="row-actions">
                      <ActionMenu label={`More actions for ${guest.name}`} items={rowActions(guest)} />
                    </div>
                  ),
                },
              ]}
              rows={items}
              rowKey={(guest) => guest.id}
              loading={loading && !book}
              error={book ? "" : error}
              onRetry={load}
              empty={
                view === "occasion"
                  ? "No birthdays or anniversaries in the next 7 days."
                  : view === "lapsed"
                    ? `Nobody has lapsed: every guest came in the last ${lapsedDays} days.`
                    : tag || optedIn || business || view
                      ? "No guest matches these filters."
                      : "No guests here yet."
              }
              emptyIcon="users"
              emptyHint="Guests are added here or at the till, the first time they give their mobile."
              rowNoun={["guest", "guests"]}
              currency={currency}
              rowClassName={(guest) => (guest.erased ? "dg-tone-muted crm-erased-row" : "")}
              // The API pages, searches and sorts. The guest book's own
              // "Export CSV" (above) is the server's export, on the activity log.
              server={{
                total: book?.total ?? 0,
                page: Math.floor(offset / limit) + 1,
                pageSize: limit,
                sort: { key: sortKey, direction: ascending ? "asc" : "desc" },
                onChange: onGridChange,
              }}
              search={{ value: typed, onChange: setTyped, placeholder: "Name, mobile, company, GSTIN" }}
              toolbar={
                <>
                  <div className="field">
                    <span>Show</span>
                    <div className="segmented" role="radiogroup" aria-label="Which guests">
                      {STATUSES.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-checked={status === option.value}
                          className={`segment ${status === option.value ? "is-active" : ""}`}
                          onClick={() => refilter("status")(option.value)}
                        >
                          {option.label}
                          {counts && <span className="crm-seg-count">{count(counts[option.value] ?? 0)}</span>}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="field">
                    <span>Quick view</span>
                    <div className="segmented" role="radiogroup" aria-label="Quick view">
                      {viewsFor(lapsedDays).map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-checked={view === option.value}
                          className={`segment ${view === option.value ? "is-active" : ""}`}
                          title={option.hint}
                          onClick={() =>
                            view === option.value
                              ? patch({ view: "", from: 0 })
                              : patch({ view: option.value, ...(option.sort ? { sort: option.sort, dir: "" } : {}), from: 0 })
                          }
                        >
                          <Icon name={option.icon} size={14} /> {option.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <label className="field crm-tag-filter">
                    <span>Tag</span>
                    <select value={tag} onChange={(event) => refilter("tag")(event.target.value)}>
                      <option value="">Any tag</option>
                      {GUEST_TAGS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="field crm-flags">
                    <span>Only</span>
                    <div className="crm-flag-row">
                      <label className="checkbox">
                        <input type="checkbox" checked={optedIn} onChange={(event) => refilter("offers")(event.target.checked)} />
                        <span>Said yes to offers</span>
                      </label>
                      <label className="checkbox">
                        <input type="checkbox" checked={business} onChange={(event) => refilter("gst")(event.target.checked)} />
                        <span>Has a GSTIN</span>
                      </label>
                    </div>
                  </div>
                </>
              }
            />
          </SectionCard>
        </>
      )}

      {editing && (
        <GuestFormModal
          guest={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved, message) => {
            setEditing(null);
            done(message);
          }}
        />
      )}

      {viewing && (
        <CustomerHistoryModal
          customer={viewing}
          currency={currency}
          canManage={canManage}
          onClose={() => setViewing(null)}
          onChanged={load}
        />
      )}

      {merging && (
        <MergeGuestsModal
          first={merging}
          currency={currency}
          onClose={() => setMerging(null)}
          onMerged={(message) => {
            setMerging(null);
            done(message);
          }}
        />
      )}

      {erasing && (
        <EraseGuestModal
          guest={erasing}
          onClose={() => setErasing(null)}
          onErased={(message) => {
            setErasing(null);
            done(message);
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete this guest?"
          message={`Delete “${deleting.name}”? Only a record added by mistake, with no orders, feedback or points, can be deleted. ${
            canErase
              ? "For a guest asking to have their data removed, use “Erase details…” in the same menu instead."
              : "For a guest asking to have their data removed, ask a manager to erase their personal details."
          }`}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
          busy={busy}
        />
      )}

      {blocked && (
        <Modal
          title="This guest has history"
          icon="lock"
          description="A record with visits or points is kept, because its bills must be kept."
          onClose={() => setBlocked(null)}
          width={480}
        >
          <p>{blocked.message}</p>
          <div className="form-actions">
            <button type="button" className="button button-secondary" onClick={() => setBlocked(null)}>
              Close
            </button>
            {canErase && (
              <button
                type="button"
                className="button button-danger"
                onClick={() => {
                  setErasing(blocked.guest);
                  setBlocked(null);
                }}
              >
                <Icon name="eye-off" size={16} /> Erase personal details instead
              </button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
