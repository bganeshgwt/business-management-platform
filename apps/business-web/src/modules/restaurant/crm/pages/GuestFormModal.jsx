import { useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import { ErrorMessage } from "../../../../components/Feedback";
import { createCustomer, listCustomers, updateCustomer } from "../services/crm.service";
import { getErrorMessage } from "../../../../services/api";
import { abroadTenCountry, formatMobile, mobileHint, normaliseMobile, tenDigitTwin } from "../../../../services/phone";
import { GUEST_TAGS, gstinHint, tidyGstin } from "../../../../services/guestBook";
import ConsentChoices from "../../../personal-data/components/ConsentChoices";
import { consentChanges } from "../../../personal-data/personalData";
import { consentStore, useConsent } from "../../../personal-data/consentStore";
import { useRestaurantPrivacy } from "../../../personal-data/usePrivacy";
import "../styles/crm.css";

const fromGuest = (guest) => ({
  name: guest?.name || "",
  mobile: guest?.mobile ? formatMobile(guest.mobile) : "",
  email: guest?.email || "",
  dateOfBirth: guest?.dateOfBirth || "",
  anniversaryDate: guest?.anniversaryDate || "",
  status: guest?.status || "active",
  address: guest?.address || "",
  notes: guest?.notes || "",
  companyName: guest?.companyName || "",
  gstin: guest?.gstin || "",
  tags: guest?.tags || [],
  allergies: guest?.allergies || "",
  // Their PAN, for a bill over ₹2,00,000, or that they declared they have none.
  pan: guest?.pan || "",
  panDeclaration: Boolean(guest?.panDeclaration),
  // What they agree to, per purpose, as tapped on this form (Personal data).
  consents: {},
});

// The PAN as typed, checked as the server checks it.
const panHint = (value) => {
  const pan = value.replace(/\s/g, "").toUpperCase();

  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)
    ? { ok: true, text: "Looks right" }
    : { ok: false, text: "A PAN is five letters, four digits and a letter, like ABCDE1234F" };
};

function Hint({ hint, fallback }) {
  if (!hint) {
    return fallback ? <small className="muted">{fallback}</small> : null;
  }

  return <small className={hint.ok ? "crm-hint-ok" : "crm-hint-bad"}>{hint.text}</small>;
}

// Adding or editing a guest: who they are, how to reach them, what the floor
// should know (tags, allergies), the business details for a GST invoice, and
// what they agree to be sent (bills, reminders, offers), each a consent of its
// own on the restaurant's privacy notice (Settings › Personal data).
//
// Staff who see a guest's contact details masked (a cashier) get those boxes
// empty, with the masked value as a hint. Left empty they keep what is on
// file (the server treats an empty box from them as "unchanged"); a new
// number typed in replaces the old one, for a guest who changed phones.
//
// When another guest holds the same ten digits in the other form (+9598473967
// from Myanmar and the Indian 9598473967), the form asks before saving (and
// the server refuses the save until it is answered): nearly always it is the
// same guest typed with "+" and no 91. "It is a different number" has to be
// ticked for the save to go through.
export default function GuestFormModal({ guest, onClose, onSaved }) {
  const editing = Boolean(guest && guest.id);
  const hidden = editing && Boolean(guest.contactHidden);
  const [form, setForm] = useState(() => fromGuest(guest));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // { name, country } of the guest holding the other form, once found.
  const [twin, setTwin] = useState(null);
  const [differentNumber, setDifferentNumber] = useState(false);
  const privacy = useRestaurantPrivacy();
  const { status: consentStatus } = useConsent(privacy.api, editing ? guest.id : null);

  const change = (field) => (event) => {
    setForm({ ...form, [field]: event.target.value });

    if (field === "mobile") {
      setTwin(null);
      setDifferentNumber(false);
    }
  };

  const toggleTag = (tag) =>
    setForm({
      ...form,
      tags: form.tags.includes(tag) ? form.tags.filter((t) => t !== tag) : [...form.tags, tag],
    });

  // Who holds the same ten digits in the other form, asked before saving so
  // the question comes up without a refused save. The server checks again.
  const findTwin = async () => {
    const mobile = normaliseMobile(form.mobile);
    const other = tenDigitTwin(mobile);

    if (!other || (editing && guest.mobile === mobile)) {
      return null;
    }

    try {
      const rows = await listCustomers({ search: other, limit: 5 });
      const holder = rows.find((row) => row.mobile === other && (!editing || row.id !== guest.id));

      return holder ? { name: holder.name, country: abroadTenCountry(mobile.startsWith("+") ? mobile : other) || "abroad", mobile, other } : null;
    } catch {
      return null;
    }
  };

  const twinMessage = (found) =>
    found.mobile.startsWith("+")
      ? `${found.name} already has the Indian mobile ${formatMobile(found.other)}. “${found.mobile}” is the same ten digits with a + in front, which is how a mobile from ${found.country} is written. If it is ${found.name}'s number, open their record. If this guest's number really is from ${found.country}, confirm that and save again.`
      : `${found.name} already has ${found.other}, a mobile from ${found.country} with the same ten digits. If this is ${found.name}, open their record. If it is a different, Indian mobile, confirm that and save again.`;

  const save = async (event) => {
    event.preventDefault();
    setError("");
    setSaving(true);

    if (!differentNumber) {
      const found = await findTwin();

      if (found) {
        setTwin({ name: found.name, country: found.country });
        setError(twinMessage(found));
        setSaving(false);
        return;
      }
    }

    const payload = {
      name: form.name,
      mobile: form.mobile.trim() || null,
      email: form.email.trim() || null,
      dateOfBirth: form.dateOfBirth || null,
      anniversaryDate: form.anniversaryDate || null,
      status: form.status,
      address: form.address || null,
      notes: form.notes || null,
      companyName: form.companyName.trim() || null,
      gstin: tidyGstin(form.gstin) || null,
      tags: form.tags,
      allergies: form.allergies.trim() || null,
      // Empty from someone who sees it masked keeps what is on file.
      pan: form.panDeclaration ? null : form.pan.replace(/\s/g, "").toUpperCase() || null,
      panDeclaration: form.panDeclaration,
      ...(consentChanges(form.consents, consentStatus?.purposes || []) ? { consents: consentChanges(form.consents, consentStatus?.purposes || []) } : {}),
      ...(twin && differentNumber ? { sameDigitsConfirmed: true } : {}),
    };

    try {
      const saved = editing ? await updateCustomer(guest.id, payload) : await createCustomer(payload);
      consentStore(privacy.api).forget(saved.id);
      onSaved(saved, editing ? `${saved.name} updated` : `${saved.name} added to the guest book`);
    } catch (err) {
      const details = err.response?.data?.data;

      if (details && details.reason === "same_digits") {
        setTwin({ name: details.existingName, country: details.country });
        setDifferentNumber(false);
      }

      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const allergyOn = form.tags.includes("allergy");

  return (
    <Modal
      title={editing ? `Edit ${guest.name}` : "Add a guest"}
      icon={editing ? "edit" : "user-plus"}
      description="Only the name is needed. A mobile lets the till recognise them next time."
      onClose={onClose}
      width={680}
    >
      <form className="form-grid crm-form" onSubmit={save}>
        <ErrorMessage message={error} />

        <p className="section-heading field-wide">Who they are</p>

        <label className="field">
          <span>Name *</span>
          <input value={form.name} onChange={change("name")} required autoFocus maxLength={150} />
        </label>

        <label className="field">
          <span>Mobile</span>
          <input
            value={form.mobile}
            onChange={change("mobile")}
            inputMode="tel"
            maxLength={20}
            placeholder={hidden ? guest.mobileDisplay || "No mobile on file" : "98765 43210"}
          />
          <Hint
            hint={mobileHint(form.mobile)}
            fallback={
              hidden
                ? "Hidden for your role. Leave empty to keep it; type a new number only if it changed."
                : "How the till recognises them next time"
            }
          />
        </label>

        {twin && (
          <div className="field field-wide crm-twin-confirm">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={differentNumber}
                onChange={(event) => setDifferentNumber(event.target.checked)}
              />
              <span>
                <strong>
                  {form.mobile.trim().startsWith("+")
                    ? `It is a different number, from ${twin.country}, not ${twin.name}'s`
                    : `It is a different, Indian number, not ${twin.name}'s`}
                </strong>
                <small className="muted">Tick only after checking with the guest, then save again.</small>
              </span>
            </label>
          </div>
        )}

        <label className="field">
          <span>Email</span>
          <input
            type="email"
            value={form.email}
            onChange={change("email")}
            maxLength={150}
            placeholder={hidden ? guest.emailMasked || "No email on file" : ""}
          />
          {hidden && <small className="muted">Leave empty to keep it</small>}
        </label>

        <label className="field">
          <span>Date of birth</span>
          <input type="date" value={form.dateOfBirth} onChange={change("dateOfBirth")} max={new Date().toLocaleDateString("en-CA")} />
          <small className="muted">Puts them on the birthday list in Guest insights</small>
        </label>

        <label className="field">
          <span>Wedding anniversary</span>
          <input
            type="date"
            value={form.anniversaryDate}
            onChange={change("anniversaryDate")}
            max={new Date().toLocaleDateString("en-CA")}
          />
          <small className="muted">Puts them on the anniversaries list, and the till shows it that week</small>
        </label>

        <fieldset className="field field-wide crm-fieldset">
          <legend className="section-heading">What the floor should know</legend>
          <p className="muted small crm-fieldset-help">Tap every tag that applies. Tags show beside the guest's name wherever staff look them up.</p>
          <div className="crm-tag-picker" role="group" aria-label="Tags">
            {GUEST_TAGS.map((tag) => {
              const on = form.tags.includes(tag.value);

              return (
                <button
                  key={tag.value}
                  type="button"
                  className={`crm-tag-toggle crm-tag-${tag.value} ${on ? "is-on" : ""}`}
                  aria-pressed={on}
                  title={tag.hint}
                  onClick={() => toggleTag(tag.value)}
                >
                  {on ? <Icon name="check" size={14} /> : <Icon name="plus" size={14} />}
                  {tag.label}
                </button>
              );
            })}
          </div>
          {allergyOn && (
            <label className="field crm-allergy-field">
              <span>Allergic to *</span>
              <input
                value={form.allergies}
                onChange={change("allergies")}
                required
                maxLength={300}
                placeholder="Peanuts, shellfish"
              />
              <small className="muted">Shown on their card, so it reaches the kitchen</small>
            </label>
          )}
        </fieldset>

        <fieldset className="field field-wide crm-fieldset">
          <legend className="section-heading">For a GST invoice in their company's name</legend>
          <div className="crm-two">
            <label className="field">
              <span>Company name</span>
              <input value={form.companyName} onChange={change("companyName")} maxLength={150} placeholder="Shah Textiles Pvt Ltd" />
            </label>
            <label className="field">
              <span>GSTIN</span>
              <input
                value={form.gstin}
                onChange={change("gstin")}
                maxLength={20}
                placeholder="27AAPFU0939F1ZV"
                className="mono"
                autoCapitalize="characters"
              />
              <Hint hint={gstinHint(form.gstin)} fallback="Kept on their record for a B2B tax invoice" />
              {editing && guest.gstin && (
                <small className="muted">
                  A change applies to new bills. Bills already issued keep the GSTIN they were made out to.
                </small>
              )}
            </label>
          </div>
        </fieldset>

        <fieldset className="field field-wide crm-fieldset">
          <legend className="section-heading">For a bill over ₹2,00,000</legend>
          <p className="muted small crm-fieldset-help">
            A bill over ₹2,00,000 that names them takes this PAN with its first payment, so the cashier does not type it
            again. Every change is in the activity log.
          </p>
          <div className="crm-two">
            <label className="field">
              <span>PAN</span>
              <input
                value={form.pan}
                onChange={change("pan")}
                maxLength={10}
                placeholder={hidden && guest.panMasked ? guest.panMasked : "ABCDE1234F"}
                className="mono"
                autoCapitalize="characters"
                disabled={form.panDeclaration}
              />
              <Hint
                hint={form.pan.trim() ? panHint(form.pan) : null}
                fallback={hidden && guest.panMasked ? "Hidden for your role. Leave empty to keep it." : "Five letters, four digits and a letter"}
              />
            </label>
            <label className="checkbox crm-pan-declared">
              <input
                type="checkbox"
                checked={form.panDeclaration}
                onChange={(event) => setForm({ ...form, panDeclaration: event.target.checked, pan: event.target.checked ? "" : form.pan })}
              />
              <span>
                Has no PAN: declared it (Form 97)
                <small className="muted">A declaration is signed for each bill: this only reminds the cashier to take one.</small>
              </span>
            </label>
          </div>
        </fieldset>

        <p className="section-heading field-wide">What they agree to be sent</p>

        <ConsentChoices privacy={privacy} personId={editing ? guest.id : null} value={form.consents}
          onChange={(consents) => setForm({ ...form, consents })} />

        <p className="section-heading field-wide">On their record</p>

        <label className="field">
          <span>Status</span>
          <select value={form.status} onChange={change("status")}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          <small className="muted">Inactive guests stay on file but leave the lists</small>
        </label>

        <label className="field">
          <span>Notes</span>
          <input value={form.notes} onChange={change("notes")} maxLength={500} placeholder="Prefers the window table" />
        </label>

        <label className="field field-wide">
          <span>Address</span>
          <textarea
            rows={2}
            value={form.address}
            onChange={change("address")}
            maxLength={500}
            placeholder={hidden ? "Hidden for your role. Leave empty to keep it." : ""}
          />
        </label>

        <div className="form-actions field-wide">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={saving}>
            <Icon name="check" size={16} />
            {saving ? "Saving…" : editing ? "Save changes" : "Add guest"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
