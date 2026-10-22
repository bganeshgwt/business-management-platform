import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import SectionCard from "../../../../components/SectionCard";
import Icon from "@bmp/ui/Icon";
import { getBusinessHours, getSettings, listPaymentTypes } from "../services/restaurant.service";
import { listTaxRates } from "../../menu/services/menu.service";

// Restaurant profile's set-up checklist (B-35): what a restaurant needs before
// its first bill is right, each with a tick and a link to the exact section
// where it is filled in. Each check reads what the owner already has; one
// that cannot be read (no permission, offline) shows as "not checked" rather
// than as missing.
//
// name: the name on the profile form (it changes as they type).
export default function SetupChecklist({ name }) {
  const [state, setState] = useState(null);

  useEffect(() => {
    let live = true;
    const settled = (promise) => promise.then((value) => ({ ok: true, value }), () => ({ ok: false }));

    Promise.all([settled(getSettings()), settled(getBusinessHours()), settled(listPaymentTypes()), settled(listTaxRates())]).then(
      ([settings, hours, types, rates]) => {
        if (live) {
          setState({ settings, hours, types, rates });
        }
      }
    );

    return () => {
      live = false;
    };
  }, []);

  if (!state) {
    return null;
  }

  const { settings, hours, types, rates } = state;
  const s = settings.ok ? settings.value : {};
  // null = could not be checked.
  const known = (ok, value) => (ok ? Boolean(value) : null);
  const activeTypes = types.ok ? types.value.filter((type) => type.status === "active").length : 0;
  const defaultRate = rates.ok ? rates.value.find((rate) => rate.isDefault && rate.status !== "inactive") : null;

  const items = [
    { key: "name", label: "Restaurant name", done: Boolean(String(name || "").trim()), to: "#profile-name", note: "On every bill" },
    {
      key: "gstin",
      label: "GSTIN",
      done: known(settings.ok, s.gstNumber),
      to: "/restaurant/settings#settings-gst",
      note: "Bills print as a Tax Invoice",
    },
    {
      key: "fssai",
      label: "FSSAI number",
      done: known(settings.ok, s.fssaiNumber),
      to: "/restaurant/settings#settings-gst",
      note: "Printed on the bill",
    },
    {
      key: "logo",
      label: "Logo",
      done: known(settings.ok, s.receiptLogoPath),
      to: "/restaurant/settings#settings-logo",
      note: "Above the name on receipts",
    },
    {
      key: "hours",
      label: "Business hours",
      done: known(hours.ok, hours.ok && hours.value.some((day) => day.isOpen)),
      to: "/restaurant/hours",
      note: "The bell warns when the day is not opened",
    },
    {
      key: "payments",
      label: "Payment types",
      done: settings.ok || types.ok ? Boolean(s.upiVpa) || activeTypes > 0 : null,
      to: "/restaurant/settings#settings-payment-types",
      note: s.upiVpa ? `UPI ${s.upiVpa}${activeTypes ? ` · ${activeTypes} more` : ""}` : "A UPI ID for QR codes, meal cards…",
    },
    {
      key: "tax",
      label: "Default tax rate",
      done: rates.ok ? Boolean(defaultRate) : null,
      to: "/menu/tax-rates",
      note: defaultRate ? `New dishes get ${defaultRate.name}` : "What a new dish is charged",
    },
  ];

  const doneCount = items.filter((item) => item.done === true).length;

  return (
    <SectionCard
      icon="check-circle"
      tone={doneCount === items.length ? "success" : "warning"}
      title="Set-up checklist"
      description={
        doneCount === items.length
          ? "Everything a bill needs is in place."
          : `${doneCount} of ${items.length} done. Each link opens the place to fill it in.`
      }
    >
      <ul className="setup-checklist">
        {items.map((item) => {
          const inner = (
            <>
              <span className={`setup-check ${item.done === true ? "is-done" : item.done === null ? "is-unknown" : "is-missing"}`} aria-hidden="true">
                <Icon name={item.done === true ? "check" : item.done === null ? "help" : "alert"} size={14} />
              </span>
              <span className="setup-check-text">
                <strong>{item.label}</strong>
                <small className="muted">
                  {item.done === null ? "Not checked (needs another permission)" : item.done ? item.note : `Not set · ${item.note}`}
                </small>
              </span>
              <Icon name="chevron-right" size={16} />
            </>
          );

          return (
            <li key={item.key}>
              {item.to.startsWith("#") ? (
                <a href={item.to} aria-label={`${item.label}: ${item.done ? "done" : "not set"}`}>
                  {inner}
                </a>
              ) : (
                <Link to={item.to} aria-label={`${item.label}: ${item.done ? "done" : "not set"}`}>
                  {inner}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
