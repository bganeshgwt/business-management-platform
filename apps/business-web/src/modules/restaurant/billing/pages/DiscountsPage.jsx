import { useCallback, useEffect, useState } from "react";
import PageHeader from "../../../../components/PageHeader";
import Modal from "../../../../components/Modal";
import ConfirmDialog from "../../../../components/ConfirmDialog";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import ActionMenu from "../../../../components/ActionMenu";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import { ErrorMessage, SuccessMessage } from "../../../../components/Feedback";
import {
  createDiscount,
  deleteDiscount,
  listDiscounts,
  updateDiscount,
} from "../services/discount.service";
import { getSettings } from "../../setup/services/restaurant.service";
import { getErrorMessage } from "../../../../services/api";
import { money } from "@bmp/shared/format";
import { today } from "@bmp/shared/dates";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import GivenAtTill from "../../business-day/pages/GivenAtTill";
import OfferRules from "./OfferRules";
import { EMPTY_RULES, rulesText } from "./offerRulesText";
import LoyaltyProgramme from "./LoyaltyProgramme";
import FeatureOff from "../../../../components/FeatureOff";
import { MoneyTabs, Status } from "../../business-day/pages/moneyUi";
import { dateText } from "../../business-day/pages/moneyText";
import "../../../../styles/billing.css";

const EMPTY = {
  code: "",
  name: "",
  description: "",
  discountType: "percentage",
  value: "",
  maxDiscountAmount: "",
  minOrderAmount: 0,
  validFrom: "",
  validTo: "",
  usageLimit: "",
  appliesTo: "all",
  status: "active",
  ...EMPTY_RULES,
};

const APPLIES_TO_LABELS = {
  all: "All orders",
  dine_in: "Dine-in",
  takeaway: "Takeaway",
  delivery: "Delivery",
  online: "Online",
};

// Where an offer stands today, from its dates and switch — so a code that ran
// out last month does not sit in the list looking live.
const standing = (discount, now) => {
  if (discount.status !== "active") {
    return { tone: "inactive", label: "Off" };
  }

  if (discount.validTo && discount.validTo < now) {
    return { tone: "neutral", label: "Ended" };
  }

  if (discount.validFrom && discount.validFrom > now) {
    return { tone: "info", label: "Starts later" };
  }

  if (discount.usageLimit && discount.usedCount >= discount.usageLimit) {
    return { tone: "warning", label: "Used up" };
  }

  return { tone: "active", label: "Live" };
};

export default function DiscountsPage() {
  const { hasPermission, hasFeature } = useAuth();
  // Coupon codes and offers are the Coupons & offers feature, the points
  // programme is Loyalty points (Settings -> Features). What was given at the
  // till is core: a manager's discount always works.
  const couponsOn = hasFeature("coupons");
  const loyaltyOn = hasFeature("guest_loyalty");
  const canManage = hasPermission("discounts.manage") && couponsOn;
  // What was given away at the till is money, so it is for sales.view.
  const canSeeGiven = hasPermission("sales.view");
  // The points guests hold are a promise in rupees: sales.view as well.
  const canSeeLoyalty = canSeeGiven && loyaltyOn;
  const canSetLoyalty = hasPermission("restaurant.settings.manage");
  const [tab, setTab] = useQueryFilter("tab", couponsOn ? "offers" : "given");
  const showLoyalty = canSeeLoyalty && tab === "loyalty";
  const showGiven = canSeeGiven && (tab === "given" || (!couponsOn && !showLoyalty));
  const activeTab = showGiven ? "given" : showLoyalty ? "loyalty" : "offers";

  const [discounts, setDiscounts] = useState([]);
  const [currency, setCurrency] = useState("₹");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);

  const load = useCallback(
    () =>
      (couponsOn ? listDiscounts() : Promise.resolve([]))
        .then(setDiscounts)
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    [couponsOn]
  );

  useEffect(() => {
    load();
    getSettings()
      .then((settings) => setCurrency(settings.currencySymbol))
      .catch(() => undefined);
  }, [load]);

  const change = (field) => (event) => setForm({ ...form, [field]: event.target.value });

  const save = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    // Empty text boxes mean "not set", which the API expects as null.
    const buyGet = form.offerType === "buy_get";
    const payload = {
      name: form.name,
      description: form.description || null,
      discountType: buyGet ? "percentage" : form.discountType,
      value: buyGet ? Number(form.getDiscountPercent) : Number(form.value),
      maxDiscountAmount:
        (buyGet || form.discountType === "percentage") && form.maxDiscountAmount
          ? Number(form.maxDiscountAmount)
          : null,
      // The rules.
      offerType: form.offerType,
      productIds: form.productIds,
      categoryIds: form.categoryIds,
      weekdays: form.weekdays,
      timeFrom: form.timeFrom || null,
      timeTo: form.timeTo || null,
      oncePerGuest: form.oncePerGuest,
      buyQuantity: buyGet ? Number(form.buyQuantity) : null,
      getQuantity: buyGet ? Number(form.getQuantity) : null,
      getDiscountPercent: buyGet ? Number(form.getDiscountPercent) : null,
      minOrderAmount: Number(form.minOrderAmount || 0),
      validFrom: form.validFrom || null,
      validTo: form.validTo || null,
      usageLimit: form.usageLimit ? Number(form.usageLimit) : null,
      appliesTo: form.appliesTo,
      status: form.status,
    };

    try {
      if (editing.id) {
        await updateDiscount(editing.id, payload);
        setSuccess("Offer updated");
      } else {
        await createDiscount({ ...payload, code: form.code });
        setSuccess("Offer created");
      }

      setEditing(null);
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    setSaving(true);

    try {
      await deleteDiscount(deleting.id);
      setDeleting(null);
      setSuccess("Offer deleted");
      load();
    } catch (err) {
      setError(getErrorMessage(err));
      setDeleting(null);
    } finally {
      setSaving(false);
    }
  };

  const startAdd = () => {
    setForm(EMPTY);
    setFormError("");
    setEditing({});
  };

  const startEdit = (discount) => {
    setForm({
      code: discount.code,
      name: discount.name,
      description: discount.description || "",
      discountType: discount.discountType,
      value: String(discount.value),
      maxDiscountAmount: discount.maxDiscountAmount ? String(discount.maxDiscountAmount) : "",
      minOrderAmount: discount.minOrderAmount,
      validFrom: discount.validFrom || "",
      validTo: discount.validTo || "",
      usageLimit: discount.usageLimit ? String(discount.usageLimit) : "",
      appliesTo: discount.appliesTo,
      status: discount.status,
      offerType: discount.offerType || "discount",
      productIds: discount.productIds || [],
      categoryIds: discount.categoryIds || [],
      weekdays: discount.weekdays || [],
      timeFrom: discount.timeFrom || "",
      timeTo: discount.timeTo || "",
      oncePerGuest: Boolean(discount.oncePerGuest),
      buyQuantity: String(discount.buyQuantity || 2),
      getQuantity: String(discount.getQuantity || 1),
      getDiscountPercent: String(discount.getDiscountPercent || 100),
    });
    setFormError("");
    setEditing(discount);
  };

  const describeValue = (discount) =>
    discount.offerType === "buy_get"
      ? `Buy ${discount.buyQuantity} get ${discount.getQuantity}${Number(discount.getDiscountPercent) >= 100 ? " free" : ` ${discount.getDiscountPercent}% off`}`
      : discount.discountType === "percentage"
      ? `${discount.value}%${discount.maxDiscountAmount ? ` (max ${currency}${discount.maxDiscountAmount})` : ""}`
      : `${money(discount.value, currency)}`;

  const now = today();
  const withStanding = discounts.map((discount) => ({ ...discount, standing: standing(discount, now) }));
  const live = withStanding.filter((discount) => discount.standing.label === "Live").length;
  const uses = discounts.reduce((sum, discount) => sum + Number(discount.usedCount || 0), 0);
  const endingSoon = withStanding.filter((discount) => {
    if (discount.standing.label !== "Live" || !discount.validTo) {
      return false;
    }

    const days = (Date.parse(discount.validTo) - Date.parse(now)) / 86400000;
    return days >= 0 && days <= 7;
  }).length;

  const offerColumns = [
    {
      key: "code",
      header: "Code",
      value: (discount) => discount.code,
      mobile: "title",
      pin: true,
      width: 240,
      render: (discount) => (
        <span className="offer-code">
          <span className="offer-code-chip mono">{discount.code}</span>
          <span className="offer-code-name">
            {discount.name}
            {discount.description && <span className="small muted">{discount.description}</span>}
          </span>
        </span>
      ),
      csv: (discount) => `${discount.code} — ${discount.name}`,
    },
    {
      key: "discount",
      header: "Discount",
      value: (discount) => describeValue(discount),
      mobile: "show",
      render: (discount) => (
        <span className="offer-value nowrap">
          <Icon name={discount.discountType === "percentage" ? "percent" : "rupee"} size={14} />
          {describeValue(discount)}
        </span>
      ),
    },
    {
      key: "rules",
      header: "Rules",
      value: (discount) => rulesText(discount),
      mobile: "show",
      render: (discount) => {
        const text = rulesText(discount);
        return text ? <span className="small">{text}</span> : <span className="muted small">Whole bill, any time</span>;
      },
    },
    {
      key: "given",
      header: "Given so far",
      type: "money",
      exact: true,
      value: (discount) => Number(discount.discountGiven || 0),
      total: "sum",
      mobile: "show",
      render: (discount) => (
        <span className="nowrap">
          {money(discount.discountGiven || 0, currency)}
          <span className="muted small"> · {discount.billCount || 0} bill{discount.billCount === 1 ? "" : "s"}</span>
        </span>
      ),
    },
    {
      key: "minOrder",
      header: "Min order",
      type: "money",
      width: 110,
      value: (discount) => Number(discount.minOrderAmount || 0),
      mobile: "show",
      render: (discount) =>
        Number(discount.minOrderAmount) > 0 ? money(discount.minOrderAmount, currency) : <span className="muted">None</span>,
    },
    {
      key: "valid",
      header: "Valid",
      value: (discount) => discount.validTo || discount.validFrom || "",
      mobile: "show",
      render: (discount) => (
        <span className="small nowrap">
          {discount.validFrom ? dateText(discount.validFrom) : "Always"}
          {discount.validTo ? ` → ${dateText(discount.validTo)}` : ""}
        </span>
      ),
      csv: (discount) => `${discount.validFrom || "always"} to ${discount.validTo || "no end"}`,
    },
    {
      key: "appliesTo",
      header: "Applies to",
      width: 120,
      value: (discount) => APPLIES_TO_LABELS[discount.appliesTo] || discount.appliesTo,
      filter: "select",
      mobile: "hide",
    },
    {
      key: "used",
      header: "Used",
      type: "number",
      width: 80,
      value: (discount) => Number(discount.usedCount || 0),
      mobile: "hide",
      render: (discount) => (
        <span className="nowrap">
          {discount.usedCount}
          {discount.usageLimit ? <span className="muted"> / {discount.usageLimit}</span> : ""}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      type: "status",
      value: (discount) => discount.standing.label,
      filter: "select",
      mobile: "subtitle",
      render: (discount) => <Status tone={discount.standing.tone}>{discount.standing.label}</Status>,
    },
    ...(canManage
      ? [
          {
            key: "actions",
            header: "",
            label: "Actions",
            type: "actions",
            render: (discount) => (
              <span className="expense-row-actions">
                <button type="button" className="link-button" onClick={() => startEdit(discount)}>
                  Edit
                </button>
                <ActionMenu
                  label={`More actions for ${discount.code}`}
                  items={[{ label: "Delete", icon: "trash", danger: true, onClick: () => setDeleting(discount) }]}
                />
              </span>
            ),
          },
        ]
      : []),
  ];

  const offers = (
    <>
      {discounts.length > 0 && (
        <div className="stat-grid">
          <StatTile
            icon="tag"
            tone="primary"
            label="Live offers"
            value={String(live)}
            of={` of ${discounts.length}`}
            note="Can be applied at billing today"
          />
          <StatTile icon="receipt" tone="success" label="Times used" value={String(uses)} note="Bills that carried a code" />
          <StatTile
            icon="calendar"
            tone={endingSoon > 0 ? "warning" : "neutral"}
            label="Ending this week"
            value={String(endingSoon)}
            note={endingSoon > 0 ? "Extend them or let them end" : "Nothing runs out in 7 days"}
          />
        </div>
      )}

      <SectionCard
        icon="tag"
        title="Coupon codes"
        description="The cashier types a code at billing; the till checks its dates, minimum order and limit before taking it off."
        flush
      >
        <DataGrid
          id="offers"
          caption="Coupon codes"
          columns={offerColumns}
          rows={withStanding}
          rowKey={(discount) => discount.id}
          loading={loading}
          empty="No offers yet."
          emptyIcon="tag"
          emptyHint="Add a coupon code the till can apply, with a limit and dates."
          emptyAction={
            canManage && (
              <button type="button" className="button button-secondary" onClick={startAdd}>
                <Icon name="plus" size={16} /> Add offer
              </button>
            )
          }
          rowClassName={(discount) => (discount.standing.label === "Live" ? "" : "dg-tone-muted")}
          exportName="offers"
        />
      </SectionCard>
    </>
  );

  return (
    <div className="stack">
      <PageHeader
        icon="tag"
        title="Discounts & offers"
        description="Coupon codes used at billing, the loyalty points programme, and every discount and no-charge bill given at the till"
        action={
          canManage &&
          activeTab === "offers" && (
            <button type="button" className="button" onClick={startAdd}>
              <Icon name="plus" size={16} /> Add offer
            </button>
          )
        }
      />

      {canSeeGiven && (
        <MoneyTabs
          label="Show"
          active={activeTab}
          onChange={setTab}
          tabs={[
            ...(couponsOn ? [{ key: "offers", label: "Offers", icon: "tag", count: loading ? undefined : discounts.length }] : []),
            ...(loyaltyOn ? [{ key: "loyalty", label: "Loyalty points", icon: "star" }] : []),
            { key: "given", label: "Given at the till", icon: "percent" },
          ]}
        />
      )}

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      {showGiven ? (
        <GivenAtTill currency={currency} />
      ) : showLoyalty ? (
        <LoyaltyProgramme currency={currency} canEdit={canSetLoyalty} />
      ) : couponsOn ? (
        offers
      ) : (
        <FeatureOff code="coupons" />
      )}

      {editing && (
        <Modal
          title={editing.id ? "Edit offer" : "Add offer"}
          icon="tag"
          description={
            editing.id
              ? "Everything but the code can change."
              : "A code the cashier types at billing to take money off."
          }
          onClose={() => setEditing(null)}
          width={640}
        >
          <form className="form-grid" onSubmit={save}>
            <ErrorMessage message={formError} />

            <p className="section-heading field-wide">The code</p>

            <label className="field">
              <span>Coupon code *</span>
              <input
                className="mono"
                value={form.code}
                onChange={change("code")}
                required
                disabled={Boolean(editing.id)}
                placeholder="WELCOME10"
                maxLength={30}
              />
              <small className="muted">
                {editing.id ? "Fixed: customers may already have it" : "What the guest gives the cashier"}
              </small>
            </label>

            <label className="field">
              <span>Offer name *</span>
              <input value={form.name} onChange={change("name")} required maxLength={150} placeholder="Welcome offer" />
              <small className="muted">Shown to staff, not printed</small>
            </label>

            <label className="field field-wide">
              <span>Description</span>
              <input
                value={form.description}
                onChange={change("description")}
                placeholder="10% off the first visit, up to ₹200"
              />
            </label>

            <OfferRules value={form} onChange={setForm} />

            {form.offerType !== "buy_get" && <p className="section-heading field-wide">How much off</p>}

            {form.offerType !== "buy_get" && (
            <label className="field">
              <span>Discount type *</span>
              <select value={form.discountType} onChange={change("discountType")}>
                <option value="percentage">Percentage off</option>
                <option value="amount">Fixed amount off</option>
              </select>
            </label>
            )}

            {form.offerType !== "buy_get" && (
            <label className="field">
              <span>{form.discountType === "percentage" ? "Percent *" : `Amount (${currency}) *`}</span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                max={form.discountType === "percentage" ? 100 : undefined}
                value={form.value}
                onChange={change("value")}
                required
              />
            </label>
            )}

            {(form.discountType === "percentage" || form.offerType === "buy_get") && (
              <label className="field">
                <span>Maximum discount ({currency})</span>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={form.maxDiscountAmount}
                  onChange={change("maxDiscountAmount")}
                  placeholder="No cap"
                />
                <small className="muted">The most it takes off one bill</small>
              </label>
            )}

            <label className="field">
              <span>Minimum order ({currency})</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.minOrderAmount}
                onChange={change("minOrderAmount")}
              />
              <small className="muted">0 means any bill</small>
            </label>

            <p className="section-heading field-wide">When and where</p>

            <label className="field">
              <span>Valid from</span>
              <input type="date" value={form.validFrom} onChange={change("validFrom")} />
              <small className="muted">Empty means it works straight away</small>
            </label>

            <label className="field">
              <span>Valid to</span>
              <input type="date" value={form.validTo} onChange={change("validTo")} />
              <small className="muted">Empty means no end date</small>
            </label>

            <label className="field">
              <span>Usage limit</span>
              <input
                type="number"
                min="1"
                value={form.usageLimit}
                onChange={change("usageLimit")}
                placeholder="Unlimited"
              />
              <small className="muted">Bills in total, across all guests</small>
            </label>

            <label className="field">
              <span>Applies to</span>
              <select value={form.appliesTo} onChange={change("appliesTo")}>
                {Object.entries(APPLIES_TO_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Status</span>
              <select value={form.status} onChange={change("status")}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
              <small className="muted">Inactive codes are refused at the till</small>
            </label>

            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete offer"
          message={`Delete "${deleting.code}"? Offers already used cannot be deleted; set them to inactive instead.`}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
          busy={saving}
        />
      )}
    </div>
  );
}
