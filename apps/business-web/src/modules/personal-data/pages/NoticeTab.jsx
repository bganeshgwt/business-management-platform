import { useCallback, useEffect, useState } from "react";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../components/SectionCard";
import FormField from "../../../components/FormField";
import { ErrorMessage } from "../../../components/Feedback";
import { getErrorMessage } from "../../../services/api";
import { toast } from "../../../services/toast";
import { dateTime } from "@bmp/shared/format";
import { consentStore } from "../consentStore";

// The privacy notice and the privacy contact. The notice says, item by item,
// what is collected and why, how to see, correct or erase it, how to complain
// and whom to contact; each purpose has its own short consent notice, read to
// a person when they are asked. It is published in versions: each consent
// keeps the version it was given on. Bills and receipts print one line with
// the contact. It states no period of keeping: how long tax law keeps a bill
// is the accountant's to say.

const fieldsOf = (source, fallback = {}) => ({
  notice: source?.notice || "",
  billsText: source?.bills_text ?? source?.billsText ?? "",
  remindersText: source?.reminders_text ?? source?.remindersText ?? "",
  offersText: source?.offers_text ?? source?.offersText ?? "",
  contactName: source?.contact_name ?? fallback.contactName ?? "",
  contactPhone: source?.contact_phone ?? fallback.contactPhone ?? "",
  contactEmail: source?.contact_email ?? fallback.contactEmail ?? "",
});

export default function NoticeTab({ privacy }) {
  const [state, setState] = useState(null);
  const [versions, setVersions] = useState([]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);
  const load = useCallback((signal) => Promise.all([privacy.api.notice(signal), privacy.canView ? privacy.api.notices(signal) : Promise.resolve([])])
    .then(([notice, list]) => { setState(notice); setVersions(list); setError(""); })
    .catch((err) => { if (!signal?.aborted) setError(getErrorMessage(err)); }), [privacy.api, privacy.canView]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (!state) return error ? <ErrorMessage message={error} /> : <p className="muted">Loading…</p>;
  const current = state.current;
  const startEditing = () => setEditing(current ? fieldsOf(current) : fieldsOf(state.starter, state.starter));

  return (
    <div className="stack">
      <ErrorMessage message={error} />
      {!current && !editing && (
        <SectionCard icon="alert" tone="warning" title="Not published yet"
          description="Consent is taken on your privacy notice, and bills print its contact line. Read the starter text, change what does not fit your business, and publish it.">
          {privacy.canManage
            ? <button type="button" className="button" onClick={startEditing}><Icon name="edit" size={16} /> Check the starter text and publish</button>
            : <p className="muted">The owner or a manager publishes it.</p>}
        </SectionCard>
      )}
      {current && !editing && (
        <SectionCard icon="shield" title={`Privacy notice ${current.label}`}
          description={`Published ${dateTime(current.published_at)}${current.published_by_name ? ` by ${current.published_by_name}` : ""}. Consents given from then name this version.`}
          actions={privacy.canManage && <button type="button" className="button button-secondary" onClick={startEditing}><Icon name="edit" size={16} /> Publish a new version</button>}>
          <div className="pd-notice">
            <div>
              <h3>The privacy contact</h3>
              <p>{[current.contact_name, current.contact_phone, current.contact_email].filter(Boolean).join(" · ")}</p>
              <h3>The line on bills and receipts</h3>
              <p className="pd-print-line">{current.print_line}</p>
              <h3>What a person is asked</h3>
              <dl className="pd-record">
                <dt>Bills on WhatsApp or SMS</dt><dd>{current.bills_text}</dd>
                <dt>Reminders</dt><dd>{current.reminders_text}</dd>
                <dt>Offers</dt><dd>{current.offers_text}</dd>
              </dl>
            </div>
            <pre className="pd-notice-text">{current.notice}</pre>
          </div>
        </SectionCard>
      )}
      {editing && (
        <NoticeForm privacy={privacy} initial={editing} version={(current?.version || 0) + 1} onCancel={() => setEditing(null)}
          onPublished={(row) => {
            setEditing(null);
            consentStore(privacy.api).setNotice({ id: row.id, version: row.version, bills_text: row.bills_text, reminders_text: row.reminders_text, offers_text: row.offers_text });
            toast.success(`Privacy notice ${row.label} published.`);
            load();
          }} />
      )}
      {versions.length > 1 && (
        <SectionCard icon="history" title="Earlier versions" description="Each is kept as it was published: a consent given on it names it.">
          <ul className="pd-consents">
            {versions.slice(1).map((v) => <li key={v.id}><strong>{v.label}</strong><small className="muted">Published {dateTime(v.published_at)}{v.published_by_name ? ` by ${v.published_by_name}` : ""}</small></li>)}
          </ul>
        </SectionCard>
      )}
    </div>
  );
}

function NoticeForm({ privacy, initial, version, onCancel, onPublished }) {
  const [form, setForm] = useState(initial);
  const [requestKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onPublished(await privacy.api.publish({ requestKey, notice: form.notice.trim(), billsText: form.billsText.trim(), remindersText: form.remindersText.trim(),
        offersText: form.offersText.trim(), contactName: form.contactName.trim(), contactPhone: form.contactPhone.trim() || null, contactEmail: form.contactEmail.trim() || null }));
    } catch (err) {
      setError(getErrorMessage(err));
      setBusy(false);
    }
  };
  return (
    <SectionCard as="form" icon="edit" title={`Privacy notice v${version}`} onSubmit={submit}
      description="Say it plainly, item by item. Once published it is kept as it is: a change is a new version.">
      <div className="form-grid">
        {error && <div className="field-wide"><ErrorMessage message={error} /></div>}
        <FormField label="Privacy contact" hint="The person people ask about their data: printed on every bill and receipt.">
          <input required maxLength={150} value={form.contactName} onChange={set("contactName")} />
        </FormField>
        <FormField label="Contact phone" optional>
          <input maxLength={30} inputMode="tel" value={form.contactPhone} onChange={set("contactPhone")} />
        </FormField>
        <FormField label="Contact e-mail" optional hint="A phone or an e-mail, or both.">
          <input type="email" maxLength={150} value={form.contactEmail} onChange={set("contactEmail")} />
        </FormField>
        <FormField label="The notice" wide hint="What is collected and why, what is sent only with a yes, how to see, correct or erase it, how to complain, and the contact.">
          <textarea required rows={16} maxLength={8000} value={form.notice} onChange={set("notice")} />
        </FormField>
        <FormField label="Consent notice: bills on WhatsApp or SMS" wide>
          <textarea required rows={2} maxLength={600} value={form.billsText} onChange={set("billsText")} />
        </FormField>
        <FormField label="Consent notice: reminders" wide>
          <textarea required rows={2} maxLength={600} value={form.remindersText} onChange={set("remindersText")} />
        </FormField>
        <FormField label="Consent notice: offers" wide>
          <textarea required rows={2} maxLength={600} value={form.offersText} onChange={set("offersText")} />
        </FormField>
        <div className="form-actions">
          <button type="button" className="button button-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="button" disabled={busy}>{busy ? "Publishing…" : `Publish v${version}`}</button>
        </div>
      </div>
    </SectionCard>
  );
}
