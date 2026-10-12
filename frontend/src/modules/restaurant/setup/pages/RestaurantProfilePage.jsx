import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import SectionCard from "../../../../components/SectionCard";
import Icon from "../../../../components/Icon";
import FormField from "../../../../components/FormField";
import { SettingsSaveBar } from "../../../../components/SettingsLayout";
import { toast } from "../../../../services/toast";
import SetupChecklist from "./SetupChecklist";
import "../styles/setup.css";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import { getRestaurant, updateRestaurant } from "../services/restaurant.service";
import { getErrorMessage } from "../../../../services/api";
import useAuth from "../../../../hooks/useAuth";
import "../../../../styles/reports.css";

const EMPTY = { name: "", contact: "", email: "", address: "" };

// Where everything else on the bill lives, so nobody hunts for a GST field on
// this page.
const ELSEWHERE = [
  {
    to: "/restaurant/settings",
    icon: "settings",
    title: "Settings",
    note: "GST and FSSAI numbers, the bill's header and footer, and the paper size.",
  },
  {
    to: "/restaurant/outlets",
    icon: "store",
    title: "Outlets",
    note: "Branches, and the GSTIN of a branch registered separately.",
    needs: "outlets.view",
  },
  {
    to: "/restaurant/hours",
    icon: "clock",
    title: "Business hours",
    note: "When you open and close, day by day.",
  },
];

export default function RestaurantProfilePage() {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("restaurant.settings.manage");

  const [form, setForm] = useState(EMPTY);
  const [saved, setSaved] = useState(EMPTY);
  const [savedAt, setSavedAt] = useState(null);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    getRestaurant()
      .then((restaurant) => {
        setCode(restaurant.code);
        const loaded = {
          name: restaurant.name || "",
          contact: restaurant.contact || "",
          email: restaurant.email || "",
          address: restaurant.address || "",
        };
        setForm(loaded);
        setSaved(loaded);
      })
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  const change = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setSuccess("");
    setSaving(true);

    try {
      await updateRestaurant(form);
      setSaved(form);
      setSavedAt(new Date());
      toast.success("Restaurant details saved");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <Loading />;
  }

  return (
    <div className="stack">
      <PageHeader
        icon="store"
        title="Restaurant profile"
        description="Your restaurant's name and contact details, as they appear on bills and reports."
      />

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      {!canEdit && (
        <p className="alert alert-info">Only someone who manages the restaurant&apos;s settings can change these.</p>
      )}

      <div className="profile-grid">
        <form className="stack" onSubmit={handleSubmit}>
          <SectionCard id="profile-name" icon="store" title="Name" description="The restaurant as your guests know it.">
            <div className="form-grid">
              <FormField label="Name">
                <input value={form.name} onChange={change("name")} required disabled={!canEdit} />
              </FormField>

              <FormField label="Restaurant code" hint="Fixed after creation, because invoices refer to it">
                <input value={code} disabled className="mono" />
              </FormField>
            </div>
          </SectionCard>

          <SectionCard
            icon="phone"
            tone="info"
            title="Contact"
            description="How guests and suppliers reach you."
          >
            <div className="form-grid">
              <FormField label="Contact number" optional>
                <input value={form.contact} onChange={change("contact")} disabled={!canEdit} inputMode="tel" />
              </FormField>

              <FormField label="Email" optional>
                <input type="email" value={form.email} onChange={change("email")} disabled={!canEdit} />
              </FormField>

              <FormField label="Address" optional wide hint="Printed under the name on bills">
                <textarea rows={3} value={form.address} onChange={change("address")} disabled={!canEdit} />
              </FormField>
            </div>
          </SectionCard>

          <SettingsSaveBar
            dirty={canEdit && JSON.stringify(form) !== JSON.stringify(saved)}
            saving={saving}
            savedAt={savedAt}
            disabled={!canEdit}
            onReset={() => setForm(saved)}
          />
        </form>

        <aside className="profile-aside stack">
          <SetupChecklist name={saved.name} />

          <SectionCard
            icon="info"
            tone="neutral"
            title="Looking for something else?"
            description="The rest of the restaurant's details are kept on these pages."
          >
            <ul className="profile-links">
              {ELSEWHERE.filter((item) => !item.needs || hasPermission(item.needs)).map((item) => (
                <li key={item.to}>
                  <Link to={item.to}>
                    <span className="profile-link-icon" aria-hidden="true">
                      <Icon name={item.icon} size={16} />
                    </span>
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.note}</small>
                    </span>
                    <Icon name="chevron-right" size={16} />
                  </Link>
                </li>
              ))}
            </ul>
          </SectionCard>
        </aside>
      </div>
    </div>
  );
}
