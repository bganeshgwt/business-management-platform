import { useCallback, useEffect, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SidePanel from "../../../../components/SidePanel";
import { ErrorMessage } from "../../../../components/Feedback";
import { toast } from "../../../../services/toast";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort, dateTime, relative } from "../../../../services/format";
import { Badge, Field } from "../../core/pages/ui";
import { useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { Segmented } from "../../wholesale/pages/shared";
import { whatsappLink } from "./salon";
import { ClientAdvances } from "./SalonRound2Parts";
import "../styles/salon-pro.css";

// The salon client card (pro pass F-05): who they are, what they had and
// with whom, their packages, notes and colour formulas (dated, kept as
// written), allergies, birthday and usual stylist. Opens from the calendar
// and the bill without leaving them.
const TABS = [{ value: "visits", label: "Visits" }, { value: "notes", label: "Notes & formula" }, { value: "packages", label: "Packages" }, { value: "advance", label: "Advance" },
  { value: "profile", label: "Profile" }];

export default function ClientPanel({ contactId, onClose, onBook }) {
  const biz = useOpenBusiness();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("visits");
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  useEffect(() => {
    if (!contactId) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, `salon/clients/${contactId}`, {}, controller.signal)
      .then((result) => { setData(result); setError(""); })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, contactId, version]);
  const c = data?.contact;
  const stats = data?.stats || {};
  const member = data?.memberships?.[0];
  return (
    <SidePanel open={Boolean(contactId)} onClose={onClose} icon="user" title={c ? c.name : "Client"} label="Client card"
      rule={c ? [c.phone, stats.last_visit ? `last visit ${relative(stats.last_visit)}` : "no visits yet"].filter(Boolean).join(" · ") : undefined}
      toolbar={<Segmented label="Show" value={tab} options={TABS} onChange={setTab} />}
      footer={c && (
        <div className="sw-row">
          {c.phone && <a className="button button-secondary button-sm" href={`tel:${c.phone}`}><Icon name="phone" size={14} /> Call</a>}
          {c.phone && <a className="button button-secondary button-sm" href={whatsappLink(c.phone, `Hi ${c.name.split(" ")[0]}, `)} target="_blank" rel="noreferrer"><Icon name="message" size={14} /> WhatsApp</a>}
          {onBook && biz.can("appointments.create") && <button type="button" className="button button-sm" onClick={() => onBook(data)}><Icon name="calendar" size={14} /> Book a visit</button>}
        </div>
      )}>
      <ErrorMessage message={error} />
      {!data && !error && <p className="sw-note">Reading the client card…</p>}
      {data && (
        <div className="sw-stack">
          <div className="sw-chips">
            {member && <span className="sw-chip is-primary"><Icon name="star" size={13} /> {member.name} till {dateShort(member.ends_on)}</span>}
            {Number(data.advance) > 0 && <button type="button" className="sw-chip" onClick={() => setTab("advance")}><Icon name="wallet" size={13} /> Advance {biz.exact(data.advance)}</button>}
            {Number(data.held) > 0 && <button type="button" className="sw-chip is-warning" onClick={() => setTab("advance")}><Icon name="wallet" size={13} /> Deposits held {biz.exact(data.held)}</button>}
            {stats.no_shows > 0 && <span className="sw-chip is-warning"><Icon name="alert" size={13} /> {stats.no_shows} no-show{stats.no_shows === 1 ? "" : "s"}</span>}
            {data.profile?.allergies && <span className="sw-chip is-danger"><Icon name="alert-circle" size={13} /> Allergy: {data.profile.allergies}</span>}
          </div>
          <dl className="sw-facts sw-facts-4">
            <div><dt>Visits</dt><dd>{stats.visits ?? 0}</dd></div>
            <div><dt>Spent</dt><dd>{biz.amount(stats.spent || 0)}</dd></div>
            <div><dt>Usual stylist</dt><dd>{data.profile?.preferred_resource_name || stats.usual_stylist || "—"}</dd></div>
            <div><dt>Birthday</dt><dd>{data.profile?.birthday ? dateShort(data.profile.birthday) : "—"}</dd></div>
          </dl>
          {tab === "visits" && <Visits biz={biz} rows={data.visits} />}
          {tab === "notes" && <Notes biz={biz} contactId={contactId} notes={data.notes} onSaved={reload} />}
          {tab === "packages" && <Plans biz={biz} data={data} />}
          {tab === "advance" && <ClientAdvances biz={biz} data={data} onChanged={reload} />}
          {tab === "profile" && <Profile biz={biz} contactId={contactId} profile={data.profile} onSaved={reload} />}
        </div>
      )}
    </SidePanel>
  );
}

function Visits({ biz, rows }) {
  const columns = [
    { key: "created_at", header: "Date", type: "date", value: (v) => v.created_at, mobile: "subtitle", render: (v) => dateShort(v.created_at) },
    { key: "label", header: "Service / product", value: (v) => v.label, mobile: "title" },
    { key: "resource_name", header: "With", value: (v) => v.resource_name || "—", mobile: "show" },
    { key: "net", header: "Value", type: "money", exact: true, value: (v) => Number(v.net), render: (v) => (v.item_kind === "session" ? "Package" : biz.exact(v.net)) },
    { key: "document_no", header: "Bill", value: (v) => v.document_no, defaultHidden: true },
  ];
  return (
    <DataGrid id="salon-client-visits" variant="compact" caption="Visits" columns={columns} rows={rows || []}
      currency={biz.symbol} rowNoun={["line", "lines"]} pageSize={10} empty="No bills yet" emptyIcon="receipt" />
  );
}

function Notes({ biz, contactId, notes, onSaved }) {
  const [form, setForm] = useState({ kind: "formula", body: "" });
  const [busy, setBusy] = useState(false);
  const canEdit = biz.can("contacts.edit");
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await businessWrite(biz.id, `salon/clients/${contactId}/notes`, form);
      toast.success(form.kind === "formula" ? "Colour formula saved" : "Note saved");
      setForm((f) => ({ ...f, body: "" }));
      onSaved();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sw-stack">
      {canEdit && (
        <form className="sw-note-form" onSubmit={save}>
          <select aria-label="Kind" value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}>
            <option value="formula">Colour formula</option><option value="note">Note</option>
          </select>
          <input aria-label="Text" required maxLength={500} value={form.body} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
            placeholder={form.kind === "formula" ? "L'Oréal 6.1 + 20 vol, 35 min" : "Prefers a quiet chair, sensitive scalp…"} />
          <button type="submit" className="button button-sm" disabled={busy}>{busy ? "Saving…" : "Add"}</button>
        </form>
      )}
      {!notes?.length ? <p className="sw-note">No notes or formulas yet. They stay on the card for the next visit.</p> : (
        <ul className="sw-notes">
          {notes.map((n) => (
            <li key={n.id}>
              <Badge tone={n.kind === "formula" ? "info" : "neutral"} label={n.kind === "formula" ? "Formula" : "Note"} />
              <span>{n.body}</span>
              <small className="muted">{dateTime(n.created_at)} · {n.created_by_name}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Plans({ biz, data }) {
  const all = [...(data.memberships || []), ...(data.packages || []), ...(data.otherPlans || [])];
  if (!all.length) return <p className="sw-note">No packages or memberships.</p>;
  return (
    <ul className="sw-list">
      {all.map((p) => (
        <li key={p.id}>
          <span>
            <strong>{p.name}</strong>{" "}
            {p.kind === "package" ? `· ${p.sessions_total - p.sessions_used} of ${p.sessions_total} sessions left` : `· ${Number(p.service_discount_percent)}% off services`}
            {" "}· till {dateShort(p.ends_on)}
          </span>
          <Badge status={p.state === "active" ? "active" : "inactive"} label={p.state === "active" ? "In use" : p.state.replace("_", " ")} />
        </li>
      ))}
      {Number(data.held) > 0 && <li><span>Deposits held for coming bookings</span><strong>{biz.exact(data.held)}</strong></li>}
    </ul>
  );
}

function Profile({ biz, contactId, profile, onSaved }) {
  const { options } = useOptions(["salon/staff?kind=staff&active=true"]);
  const [form, setForm] = useState(() => ({
    birthday: profile?.birthday ? String(profile.birthday).slice(0, 10) : "", anniversary: profile?.anniversary ? String(profile.anniversary).slice(0, 10) : "",
    gender: profile?.gender || "", preferredResourceId: profile?.preferred_resource_id ? String(profile.preferred_resource_id) : "", allergies: profile?.allergies || "",
  }));
  const [busy, setBusy] = useState(false);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const canEdit = biz.can("contacts.edit");
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await businessWrite(biz.id, `salon/clients/${contactId}/profile`, form, "put");
      toast.success("Client card saved");
      onSaved();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="form-grid" onSubmit={save}>
      <fieldset className="form-grid bz-fieldset field-wide" disabled={!canEdit || busy}>
        <Field label="Birthday"><input type="date" value={form.birthday} onChange={set("birthday")} /></Field>
        <Field label="Anniversary"><input type="date" value={form.anniversary} onChange={set("anniversary")} /></Field>
        <Field label="Gender">
          <select value={form.gender} onChange={set("gender")}><option value="">Not said</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select>
        </Field>
        <Field label="Usual stylist">
          <select value={form.preferredResourceId} onChange={set("preferredResourceId")}>
            <option value="">Anyone</option>
            {(options?.["salon/staff?kind=staff&active=true"] || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Allergies and sensitivities" wide hint="Shown in red on the card and the booking"><input maxLength={300} value={form.allergies} onChange={set("allergies")} placeholder="PPD in hair dye, latex" /></Field>
      </fieldset>
      {canEdit && <div className="form-actions field-wide"><button type="submit" className="button" disabled={busy}>{busy ? "Saving…" : "Save the card"}</button></div>}
    </form>
  );
}
