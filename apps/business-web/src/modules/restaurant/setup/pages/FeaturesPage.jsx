import { useCallback, useEffect, useMemo, useState } from "react";
import PageHeader from "../../../../components/PageHeader";
import SectionCard from "../../../../components/SectionCard";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import useAuth from "../../../../hooks/useAuth";
import useConfirm from "../../../../hooks/useConfirm";
import SettingsLayout from "../../../../components/SettingsLayout";
import { toast } from "../../../../services/toast";
import { getCurrentUser } from "../../../../services/auth.service";
import { getErrorMessage } from "../../../../services/api";
import { listFeatures, previewFeature, setFeature } from "../../../../services/features";
import "../../../../styles/features.css";
import FormatCard from "./FormatCard";
import PlanBadge from "../../../plan/components/PlanBadge";
import { moduleBadge } from "../../../plan/planWords";
import { useOwnerPlan, usePlanScope } from "../../../plan/usePlan";

// Settings -> Features: the parts of the restaurant this restaurant uses.
// Switching one off hides it everywhere (menu, pages, buttons, dashboard,
// reports, the bell) and the server refuses its requests; nothing is deleted,
// so switching it back on brings everything back. The owner decides; the
// server refuses a switch that would strand money (an advance still held,
// rider cash not settled) and says what it would hide before it happens.

const ICONS = {
  guests: "users",
  guest_loyalty: "star",
  reservations: "calendar",
  qr_ordering: "qr",
  online_ordering: "store",
  deliveries: "scooter",
  kitchen_display: "chef",
  captain_app: "phone",
  captain_sections: "map-pin",
  tips: "heart",
  advances: "wallet",
  cash_drawers: "cash",
  coupons: "tag",
  stock_recipes: "box",
  staff_payroll: "clock",
  preorders: "calendar",
  brands: "store",
};

const GROUP_NOTES = {
  Guests: "Who your guests are, and what keeps them coming back.",
  Service: "How orders reach you and how the floor and kitchen run.",
  Money: "Extra ways money is taken and counted.",
  "Back office": "Stock, purchasing and the people who work here.",
};

// Always on: what every restaurant needs to sell and account for it.
const CORE = [
  "POS & orders",
  "Bills & payments",
  "Dues & accounts",
  "Menu",
  "Tables",
  "Outlets",
  "Business day",
  "Expenses",
  "Log book",
  "Reports",
  "Users & roles",
  "Settings",
  "Activity log",
];

export default function FeaturesPage() {
  const { refreshUser } = useAuth();
  const confirm = useConfirm();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState("");
  const [asking, setAsking] = useState(null);
  // The plan's badge on each feature (modules/plan): the owner's with the
  // prices of the choice for after the trial and the way to add one, staff's
  // only why a switch stays off.
  const planScope = usePlanScope();
  const ownerPlan = useOwnerPlan(planScope);

  const load = useCallback(() => {
    return listFeatures()
      .then((result) => {
        setData(result);
        setError("");
      })
      .catch((err) => setError(getErrorMessage(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const byCode = useMemo(() => new Map((data?.features || []).map((feature) => [feature.code, feature])), [data]);
  const nameOf = (code) => byCode.get(code)?.name || code;

  const groups = useMemo(() => {
    const result = [];

    for (const feature of data?.features || []) {
      let group = result.find((entry) => entry.title === feature.group);

      if (!group) {
        group = { title: feature.group, features: [] };
        result.push(group);
      }

      group.features.push(feature);
    }

    return result;
  }, [data]);

  const onCount = (data?.features || []).filter((feature) => feature.enabled).length;

  // Every screen of this person follows the new switches at once.
  const afterChange = async (message) => {
    toast.success(message);
    await load();

    try {
      refreshUser(await getCurrentUser());
    } catch {
      // The next page load reads it anyway.
    }
  };

  const apply = async (feature, enabled) => {
    setBusy(feature.code);
    setError("");
    setSuccess("");

    try {
      const result = await setFeature(feature.code, enabled);
      setAsking(null);
      await afterChange(result.message);
    } catch (err) {
      const details = err?.response?.data?.data;

      if (details?.blockers?.length) {
        setAsking({ feature, enabled, blockers: details.blockers, warnings: details.warnings || [] });
      } else {
        setAsking(null);
        setError(getErrorMessage(err));
      }
    } finally {
      setBusy("");
    }
  };

  // Switching on just happens. Switching off first asks the server what it
  // would hide, and whether anything stands in the way.
  const toggle = async (feature) => {
    if (feature.enabled) {
      setBusy(feature.code);
      setError("");
      setSuccess("");

      let result;

      try {
        result = await previewFeature(feature.code, false);
      } catch (err) {
        setError(getErrorMessage(err));
        setBusy("");
        return;
      }

      setBusy("");

      // Something stands in the way: say what, and switch nothing.
      if ((result.blockers || []).length > 0) {
        setAsking({ feature, enabled: false, blockers: result.blockers, warnings: result.warnings || [] });
        return;
      }

      const hides = result.hides || [];
      const warnings = result.warnings || [];
      const yes = await confirm({
        title: `Switch off ${feature.name}?`,
        message: (
          <div className="feature-confirm">
            {hides.length > 0 && (
              <>
                <p>These disappear for everyone until it is switched back on:</p>
                <ul className="feature-dialog-list">
                  {hides.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </>
            )}
            {warnings.length > 0 && (
              <>
                <p>Open work stays saved but hidden:</p>
                <ul className="feature-dialog-list">
                  {warnings.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </>
            )}
            <p className="muted small">Nothing is deleted. Switch it back on and everything is there as it was.</p>
          </div>
        ),
        confirmLabel: `Switch off ${feature.name}`,
        cancelLabel: "Keep it on",
        tone: "danger",
      });

      if (yes) {
        apply(feature, false);
      }

      return;
    }

    apply(feature, true);
  };

  const canChange = Boolean(data?.canChange);

  return (
    <div className="features-page">
      <PageHeader
        icon="sliders"
        eyebrow="Settings"
        title="Features"
        description="Switch on the parts of the restaurant you use. A feature switched off disappears from the menu, the POS, the dashboard and reports, and nobody can use it. Nothing is deleted: switch it back on and everything is there as it was."
      />

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      <FormatCard canChange={Boolean(data?.canChange)} onChanged={(message, skipped) => afterChange(skipped.length ? `${message}: ${skipped.map((x) => x.reason).join(" ")}` : message)} />

      {!data && !error && <Loading />}

      {data && (
        <>
          <div className="features-summary">
            <span>
              <strong>{onCount}</strong> of {data.features.length} features on
            </span>
            {!canChange && (
              <span className="muted small">
                <Icon name="lock" size={14} /> Only the owner can switch features on or off.
              </span>
            )}
          </div>

          <SettingsLayout
            sections={[
              ...groups.map((group) => ({ id: `features-${group.title.toLowerCase().replace(/[^a-z]+/g, "-")}`, label: group.title })),
              { id: "features-core", label: "Always on" },
            ]}
          >
          {groups.map((group) => (
            <SectionCard
              key={group.title}
              id={`features-${group.title.toLowerCase().replace(/[^a-z]+/g, "-")}`}
              title={group.title}
              description={GROUP_NOTES[group.title]}
            >
              <div className="features-list">
                {group.features.map((feature) => {
                  const missing = feature.requires.filter((code) => !byCode.get(code)?.enabled);
                  const neededBy = feature.requiredBy.filter((code) => byCode.get(code)?.enabled);
                  // Outside the plan a feature works as switched off, and cannot be switched on.
                  const outside = feature.inPlan === false;
                  const locked = feature.enabled ? neededBy.length > 0 : missing.length > 0 || outside;
                  const hint = feature.enabled
                    ? neededBy.length > 0 && `${neededBy.map(nameOf).join(" and ")} ${neededBy.length === 1 ? "needs" : "need"} it: switch ${neededBy.length === 1 ? "that" : "those"} off first.`
                    : outside ? "Not in your plan."
                    : missing.length > 0 && `Needs ${missing.map(nameOf).join(" and ")}: switch ${missing.length === 1 ? "that" : "those"} on first.`;
                  const badge = moduleBadge({ code: feature.code, kind: "optional", inPlan: !outside }, { plan: planScope?.plan, view: ownerPlan, isOwner: Boolean(planScope?.isOwner) });

                  return (
                    <div key={feature.code} className={`feature-card ${feature.enabled ? "is-on" : "is-off"}`} data-feature={feature.code}>
                      <span className="feature-card-icon" aria-hidden="true">
                        <Icon name={ICONS[feature.code] || "layers"} size={20} />
                      </span>
                      <div className="feature-card-text">
                        <strong>{feature.name}</strong>
                        <PlanBadge badge={badge} addTo={planScope?.isOwner && planScope.planPath ? `${planScope.planPath}?add=${feature.code}` : null} />
                        <p>{feature.description}</p>
                        {(feature.requires.length > 0 || neededBy.length > 0) && (
                          <div className="feature-card-needs">
                            {feature.requires.map((code) => (
                              <span key={code} className={`feature-chip ${byCode.get(code)?.enabled ? "" : "is-missing"}`}>
                                Needs {nameOf(code)}
                              </span>
                            ))}
                            {neededBy.map((code) => (
                              <span key={code} className="feature-chip">
                                <Icon name="lock" size={11} /> {nameOf(code)} needs this
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <label className="feature-switch" title={hint || undefined}>
                        <input
                          type="checkbox"
                          role="switch"
                          checked={feature.enabled}
                          disabled={!canChange || locked || busy === feature.code}
                          onChange={() => toggle(feature)}
                          aria-label={`${feature.name}: ${feature.enabled ? "on" : "off"}`}
                        />
                        <span aria-hidden="true" />
                      </label>
                    </div>
                  );
                })}
              </div>
            </SectionCard>
          ))}

          <SectionCard
            id="features-core"
            icon="check-circle"
            title="Always on"
            description="What every restaurant needs to take orders, bill and account for the day. These cannot be switched off."
          >
            <div className="feature-core-list">
              {CORE.map((name) => (
                <span key={name} className="feature-chip">
                  {name}
                </span>
              ))}
            </div>
          </SectionCard>
          </SettingsLayout>
        </>
      )}

      {asking && (
        <Modal
          title={
            asking.blockers.length
              ? `${asking.feature.name} cannot be switched ${asking.enabled ? "on" : "off"} yet`
              : `Switch off ${asking.feature.name}?`
          }
          onClose={() => setAsking(null)}
          width={480}
        >
          {asking.blockers.length > 0 ? (
            <>
              <p>First:</p>
              <ul className="feature-dialog-list">
                {asking.blockers.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>
              Its menu entries, pages, buttons, dashboard cards and alerts are hidden for everyone, and nobody can use
              it until it is switched back on. Nothing is deleted.
            </p>
          )}
          {asking.warnings.length > 0 && (
            <>
              <p className="muted small">{asking.blockers.length ? "Also good to know:" : "Good to know:"}</p>
              <ul className="feature-dialog-list muted small">
                {asking.warnings.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          )}
          <div className="form-actions">
            <button type="button" className="button button-secondary" onClick={() => setAsking(null)}>
              {asking.blockers.length ? "Close" : "Cancel"}
            </button>
            {asking.blockers.length === 0 && (
              <button
                type="button"
                className="button button-danger"
                disabled={busy === asking.feature.code}
                onClick={() => apply(asking.feature, asking.enabled)}
              >
                {busy === asking.feature.code ? "Working…" : `Switch off ${asking.feature.name}`}
              </button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
