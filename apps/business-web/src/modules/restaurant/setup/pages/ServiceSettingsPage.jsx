import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import PageHeader from "../../../../components/PageHeader";
import SectionCard from "../../../../components/SectionCard";
import ConfirmDialog from "../../../../components/ConfirmDialog";
import Icon from "@bmp/ui/Icon";
import FormField from "../../../../components/FormField";
import SettingsLayout from "../../../../components/SettingsLayout";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import useAuth from "../../../../hooks/useAuth";
import { getErrorMessage } from "../../../../services/api";
import { getServiceSettings, updateServiceSettings } from "../../orders/services/order.service";
import { ADDRESS_WARNINGS, addressProblem, guestOrderUrl } from "../../../../services/qrSheet";
import { listOnlineLinks, onlineOrderUrl, replaceOnlineLink, updateOnlineLink } from "../../online/services/onlineOrder.service";
import { money } from "@bmp/shared/format";
import { getSettings } from "../services/restaurant.service";
import { customerWebOrigin } from "../../../../services/customerWeb";
import "../../../../styles/service.css";
import "../styles/online-settings.css";

// The service desk's switches in one place: token numbers and the pickup
// screen, and the other service features that keep their settings here. Each
// part saves on its own, with the permission of the work it belongs to; the
// server checks it again.

const TOKEN_TYPES = [
  { value: "takeaway", label: "Takeaway / counter" },
  { value: "delivery", label: "Delivery" },
  { value: "online", label: "Online orders" },
];

const POS_TYPES = [
  { value: "dine_in", label: "Dine-in (tables)" },
  { value: "takeaway", label: "Takeaway / counter" },
  { value: "delivery", label: "Delivery" },
];

// The kinds of order the POS takes and the one a new order starts on: a café
// starts on takeaway, a cloud kitchen takes no dine-in (the format sets them).
function PosSection({ settings, canEdit, onSaved }) {
  const [types, setTypes] = useState(settings.posOrderTypes || ["dine_in", "takeaway", "delivery"]);
  const [start, setStart] = useState(settings.defaultOrderType || "dine_in");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const toggle = (value) => setTypes((current) => {
    const next = current.includes(value) ? current.filter((type) => type !== value) : [...current, value];
    if (!next.includes(start) && next.length) setStart(next[0]);
    return next;
  });
  const save = async (event) => {
    event.preventDefault();
    setSaving(true); setError(""); setSaved("");
    try {
      const result = await updateServiceSettings("pos", { posOrderTypes: types, defaultOrderType: start });
      setSaved(result.message);
      onSaved(result.data);
    } catch (err) { setError(getErrorMessage(err)); } finally { setSaving(false); }
  };
  return (
    <SectionCard as="form" onSubmit={save} id="pos" icon="receipt" title="Orders the POS takes"
      description="Which kinds of order the POS offers, and which a new order starts on. A cloud kitchen takes no dine-in; a café's counter starts on takeaway.">
      <ErrorMessage message={error} />
      <SuccessMessage message={saved} />
      <div className="form-grid">
        <fieldset className="field field-wide svc-fieldset" disabled={!canEdit}>
          <legend>The POS takes</legend>
          <div className="svc-choices">
            {POS_TYPES.map((type) => (
              <label key={type.value} className="svc-choice">
                <input type="checkbox" checked={types.includes(type.value)} onChange={() => toggle(type.value)} />
                <span>{type.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field">
          <span>A new order starts on</span>
          <select value={start} onChange={(event) => setStart(event.target.value)} disabled={!canEdit}>
            {POS_TYPES.filter((type) => types.includes(type.value)).map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
          </select>
        </label>
      </div>
      {canEdit && (
        <div className="form-actions">
          <button type="submit" className="button" disabled={saving || types.length === 0}>{saving ? "Saving…" : "Save"}</button>
        </div>
      )}
    </SectionCard>
  );
}

function TokensSection({ settings, canEdit, onSaved }) {
  const [form, setForm] = useState({
    tokensEnabled: settings.tokensEnabled,
    tokenOrderTypes: settings.tokenOrderTypes,
    collectionClearMinutes: String(settings.collectionClearMinutes),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const toggleType = (value) =>
    setForm((current) => ({
      ...current,
      tokenOrderTypes: current.tokenOrderTypes.includes(value)
        ? current.tokenOrderTypes.filter((type) => type !== value)
        : [...current.tokenOrderTypes, value],
    }));

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setSaved("");

    try {
      const result = await updateServiceSettings("tokens", {
        tokensEnabled: form.tokensEnabled,
        tokenOrderTypes: form.tokenOrderTypes,
        collectionClearMinutes: Number(form.collectionClearMinutes),
      });

      setSaved(result.message);
      onSaved(result.data);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      as="form"
      onSubmit={save}
      id="tokens"
      icon="receipt"
      title="Token numbers and the pickup screen"
      description="Parcels get a short number that starts again at 1 every business day, printed large on the KOT. A TV by the counter shows the numbers being made and ready to collect."
      actions={
        <Link to="/collection" className="button button-secondary button-sm">
          Open the pickup screen
        </Link>
      }
    >
      <ErrorMessage message={error} />
      <SuccessMessage message={saved} />
      <div className="form-grid">
        <label className="checkbox field-wide svc-toggle">
          <input
            type="checkbox"
            checked={form.tokensEnabled}
            onChange={(event) => setForm({ ...form, tokensEnabled: event.target.checked })}
            disabled={!canEdit}
          />
          <span>
            <strong>Give parcels a token number</strong>
            <small className="muted">Each outlet counts its own tokens, from 1, every business day.</small>
          </span>
        </label>

        <fieldset className="field field-wide svc-fieldset" disabled={!canEdit || !form.tokensEnabled}>
          <legend>Orders that get a token</legend>
          <div className="svc-choices">
            {TOKEN_TYPES.map((type) => (
              <label key={type.value} className="svc-choice">
                <input
                  type="checkbox"
                  checked={form.tokenOrderTypes.includes(type.value)}
                  onChange={() => toggleType(type.value)}
                />
                <span>{type.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="field">
          <span>A ready token leaves the screen after (minutes)</span>
          <input
            type="number"
            min="1"
            max="120"
            step="1"
            value={form.collectionClearMinutes}
            onChange={(event) => setForm({ ...form, collectionClearMinutes: event.target.value })}
            disabled={!canEdit || !form.tokensEnabled}
          />
          <small className="muted">Or as soon as the counter marks it collected.</small>
        </label>

        <div className="field svc-note">
          <span>For the TV by the counter</span>
          <small className="muted">
            Add a user with the <strong>Collection display</strong> role and sign the TV in with it: it opens straight on
            the pickup screen, shows only token numbers (no prices, names or mobiles) and can open nothing else.
          </small>
        </div>
      </div>

      {canEdit && (
        <div className="form-actions">
          <button type="submit" className="button" disabled={saving}>
            {saving ? "Saving…" : "Save token settings"}
          </button>
        </div>
      )}
    </SectionCard>
  );
}

// The address every table QR code opens. Without it the codes carry the
// guest site's own address (services/customerWeb.js), which on a computer
// running at localhost (or a shop-floor address) no guest's phone can reach.
function GuestAddressSection({ settings, canEdit, onSaved }) {
  const [value, setValue] = useState(settings.guestWebAddress || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const problem = addressProblem(settings.guestWebAddress, customerWebOrigin());

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setSaved("");

    try {
      const result = await updateServiceSettings("guest-web-address", { guestWebAddress: value });

      setValue(result.data.guestWebAddress || "");
      setSaved(result.message);
      onSaved(result.data);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      as="form"
      onSubmit={save}
      id="guest-address"
      icon="qr"
      tone="info"
      title="Guest ordering web address"
      description="The address guests' phones open when they scan a table's QR code. Every printed code is built from it."
      actions={
        <Link to="/tables?print=qr" className="button button-secondary button-sm">
          Print QR codes
        </Link>
      }
    >
      <ErrorMessage message={error} />
      <SuccessMessage message={saved} />
      {problem && <p className={`alert ${problem === "local" ? "alert-danger" : "alert-notice"} svc-warning`}>{ADDRESS_WARNINGS[problem]}</p>}
      <div className="form-grid">
        <FormField
          label="Web address"
          optional
          wide
          hint={`Where the guests' site is reachable from the internet. Leave it empty to use ${customerWebOrigin()}.`}
        >
          <input
            className="mono"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="https://order.myrestaurant.in"
            maxLength={200}
            disabled={!canEdit}
            inputMode="url"
            autoComplete="off"
          />
        </FormField>
        <div className="field field-wide">
          <span>A table's code will open</span>
          <p className="svc-link-row">
            <code>{guestOrderUrl(value.trim() || customerWebOrigin(), "<table code>")}</code>
          </p>
        </div>
      </div>
      {canEdit && (
        <div className="form-actions">
          <button type="submit" className="button" disabled={saving}>
            {saving ? "Saving…" : "Save web address"}
          </button>
        </div>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------- online ordering (SW-A-22)

// The restaurant's own ordering page, one link per selling point: the main
// counter and each outlet. Each link is switched on, given its limits and
// shared on its own, because each place has its own kitchen, day and riders.
const linkForm = (link) => ({
  takeawayEnabled: link.takeawayEnabled,
  deliveryEnabled: link.deliveryEnabled,
  minDeliveryOrder: String(link.minDeliveryOrder),
  pickupMinutes: String(link.pickupMinutes),
  deliveryMinutes: String(link.deliveryMinutes),
  maxOpenPerMobile: String(link.maxOpenPerMobile),
  deliveryArea: link.deliveryArea || "",
  guestNote: link.guestNote || "",
});

const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // An http page (a till on the shop-floor network) has no clipboard API.
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    const done = document.execCommand("copy");
    area.remove();
    return done;
  }
};

function OnlineLinkCard({ link, base, canEdit, channelReady, onChanged }) {
  const [form, setForm] = useState(() => linkForm(link));
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const url = onlineOrderUrl(base, link.token);
  const place = link.outletName || "Main counter";

  const act = async (kind, work) => {
    setBusy(kind);
    setError("");
    setSaved("");

    try {
      const result = await work();
      setSaved(result.message);
      setForm(linkForm(result.data));
      onChanged(result.data);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy("");
    }
  };

  const save = (event) => {
    event.preventDefault();
    act("save", () =>
      updateOnlineLink(link.id, {
        takeawayEnabled: form.takeawayEnabled,
        deliveryEnabled: form.deliveryEnabled,
        minDeliveryOrder: Number(form.minDeliveryOrder || 0),
        pickupMinutes: Number(form.pickupMinutes),
        deliveryMinutes: Number(form.deliveryMinutes),
        maxOpenPerMobile: Number(form.maxOpenPerMobile),
        deliveryArea: form.deliveryArea,
        guestNote: form.guestNote,
      })
    );
  };

  const copy = async () => {
    if (await copyText(url)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const state = !link.enabled ? "off" : link.live ? "on" : "stopped";

  return (
    <form className={`ool-card is-${state}`} onSubmit={save}>
      <header className="ool-head">
        <span className="ool-place-icon" aria-hidden="true">
          <Icon name={link.outletId ? "store" : "home"} size={18} />
        </span>
        <div className="ool-title">
          <strong>{place}</strong>
          <span className="muted small">
            {link.outletId ? "Outlet" : "Your own counter and kitchen"}
            {link.waiting > 0 ? ` · ${link.waiting} waiting` : ""}
            {link.lastDay > 0 ? ` · ${link.lastDay} in the last 24 hours` : ""}
          </span>
        </div>
        <span className={`badge ${state === "on" ? "badge-active" : state === "stopped" ? "badge-warning" : "badge-inactive"}`}>
          {state === "on" ? "Taking orders" : state === "stopped" ? "Channel off" : "Off"}
        </span>
        {canEdit && (
          <button
            type="button"
            className={`button button-sm ${link.enabled ? "button-secondary" : ""}`}
            disabled={Boolean(busy) || (!link.enabled && !channelReady)}
            onClick={() => act("toggle", () => updateOnlineLink(link.id, { enabled: !link.enabled }))}
          >
            {busy === "toggle" ? "Saving…" : link.enabled ? "Switch off" : "Switch on"}
          </button>
        )}
      </header>

      <ErrorMessage message={error} />
      <SuccessMessage message={saved} />

      <div className="ool-link">
        <code className="mono">{url}</code>
        <div className="ool-link-actions">
          <button type="button" className="button button-secondary button-sm" onClick={copy}>
            <Icon name={copied ? "check" : "copy"} size={14} /> {copied ? "Copied" : "Copy link"}
          </button>
          <a className="button button-secondary button-sm" href={url} target="_blank" rel="noreferrer">
            <Icon name="external" size={14} /> Open
          </a>
          {canEdit && (
            <button
              type="button"
              className="button button-secondary button-sm"
              disabled={Boolean(busy)}
              onClick={() => setConfirming(true)}
            >
              <Icon name="refresh" size={14} /> New link
            </button>
          )}
        </div>
      </div>

      <fieldset className="ool-grid" disabled={!canEdit || Boolean(busy)}>
        <div className="field ool-services">
          <span>Guests can order</span>
          <div className="svc-choices">
            <label className="svc-choice">
              <input
                type="checkbox"
                checked={form.takeawayEnabled}
                onChange={(event) => setForm({ ...form, takeawayEnabled: event.target.checked })}
              />
              <span>Takeaway</span>
            </label>
            <label className="svc-choice">
              <input
                type="checkbox"
                checked={form.deliveryEnabled}
                onChange={(event) => setForm({ ...form, deliveryEnabled: event.target.checked })}
              />
              <span>Delivery</span>
            </label>
          </div>
        </div>
        <label className="field">
          <span>Ready to collect in (min)</span>
          <input
            type="number"
            min="5"
            max="180"
            step="1"
            value={form.pickupMinutes}
            onChange={(event) => setForm({ ...form, pickupMinutes: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Delivered in (min)</span>
          <input
            type="number"
            min="10"
            max="240"
            step="1"
            value={form.deliveryMinutes}
            disabled={!form.deliveryEnabled}
            onChange={(event) => setForm({ ...form, deliveryMinutes: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Minimum for delivery</span>
          <input
            type="number"
            min="0"
            step="1"
            value={form.minDeliveryOrder}
            disabled={!form.deliveryEnabled}
            onChange={(event) => setForm({ ...form, minDeliveryOrder: event.target.value })}
          />
          <small className="muted">0 = no minimum</small>
        </label>
        <label className="field">
          <span>Open orders per mobile</span>
          <input
            type="number"
            min="1"
            max="10"
            step="1"
            value={form.maxOpenPerMobile}
            onChange={(event) => setForm({ ...form, maxOpenPerMobile: event.target.value })}
          />
          <small className="muted">Waiting or on the way, at once</small>
        </label>
        <FormField label="Where you deliver" optional className="ool-wide">
          <input
            value={form.deliveryArea}
            maxLength={200}
            disabled={!form.deliveryEnabled}
            placeholder="Within 5 km of Banjara Hills"
            onChange={(event) => setForm({ ...form, deliveryArea: event.target.value })}
          />
        </FormField>
        <FormField label="Note for guests" optional className="ool-wide">
          <input
            value={form.guestNote}
            maxLength={200}
            placeholder="Fresh rotis till 11 pm"
            onChange={(event) => setForm({ ...form, guestNote: event.target.value })}
          />
        </FormField>
      </fieldset>

      {canEdit && (
        <div className="form-actions">
          <button type="submit" className="button button-sm" disabled={Boolean(busy)}>
            {busy === "save" ? "Saving…" : `Save ${place.toLowerCase() === "main counter" ? "main counter" : place}`}
          </button>
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title={`New link for ${place}`}
          message="Every copy of the current link stops working at once — on Google, Instagram, WhatsApp and printed flyers. Guests following an order they already placed are not affected. Make a new link?"
          confirmLabel="Make a new link"
          busy={busy === "new"}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            act("new", () => replaceOnlineLink(link.id));
          }}
        />
      )}
    </form>
  );
}

function OnlineOrderingSection({ base, canEdit }) {
  const [data, setData] = useState(null);
  // The restaurant's own currency symbol, for the delivery charge.
  const [currency, setCurrency] = useState("₹");

  useEffect(() => {
    getSettings()
      .then((settings) => setCurrency(settings.currencySymbol || "₹"))
      .catch(() => undefined);
  }, []);
  const [error, setError] = useState("");

  const load = useCallback(
    () =>
      listOnlineLinks()
        .then((result) => {
          setData(result);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err))),
    []
  );

  useEffect(() => {
    load();
  }, [load]);

  const channel = data ? data.websiteChannel : null;

  return (
    <SectionCard
      id="online-ordering"
      icon="scooter"
      tone="success"
      title="Online ordering page"
      description="Your own page for takeaway and delivery — share the link on Google, Instagram or WhatsApp, with no commission. Orders land in Table requests to accept or reject, tagged with the Website channel."
      actions={
        <Link to="/table-requests" className="button button-secondary button-sm">
          Open the inbox
        </Link>
      }
    >
      <ErrorMessage message={error} />
      {!data && !error && <Loading />}
      {data && (
        <div className="ool-list">
          {channel ? (
            <p className="ool-note">
              <Icon name="truck" size={15} />
              <span>
                Website channel: delivery{" "}
                {channel.charge > 0
                  ? `${money(channel.charge, currency)}${channel.freeAbove ? `, free above ${money(channel.freeAbove, currency)}` : ""}`
                  : "free"}
                . Change it under <Link to="/deliveries?tab=channels">Deliveries → Channels</Link>; packing and online
                prices per dish are under Menu → Products → Prices &amp; outlets.
              </span>
            </p>
          ) : (
            <p className="alert alert-notice">
              The Website sales channel is switched off, so online ordering cannot be switched on. Switch it on under{" "}
              <Link to="/deliveries?tab=channels">Deliveries → Channels</Link>.
            </p>
          )}
          <p className="ool-note">
            <Icon name="wallet" size={15} />
            <span>
              Guests pay when they collect, or cash on delivery. {data.onlinePaymentNote}
            </span>
          </p>
          {data.links.map((link) => (
            <OnlineLinkCard
              key={`${link.id}-${link.token}`}
              link={link}
              base={base}
              canEdit={canEdit}
              channelReady={Boolean(channel)}
              onChanged={(next) =>
                setData((current) => ({
                  ...current,
                  links: current.links.map((one) => (one.id === next.id ? next : one)),
                }))
              }
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

export default function ServiceSettingsPage() {
  const { hasPermission, hasFeature } = useAuth();
  // The online ordering page is its own feature; the guest web address serves
  // the QR and online pages (Settings -> Features).
  const onlineOn = hasFeature("online_ordering");
  const guestPagesOn = onlineOn || hasFeature("qr_ordering");
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getServiceSettings()
      .then(setSettings)
      .catch((err) => setError(getErrorMessage(err)));
  }, []);

  return (
    <div className="stack svc-page">
      <PageHeader
        icon="settings"
        title="Service settings"
        description="How the counter, the floor and the kitchen work: token numbers, the pickup screen, your online ordering page and the address guest pages open."
      />

      <ErrorMessage message={error} />

      {!settings && !error && <Loading />}

      {settings && (
        // Each part saves on its own (its own permission), so the index is
        // shared but there is no single save bar.
        <SettingsLayout
          sections={[
            { id: "pos", label: "Orders the POS takes" },
            { id: "tokens", label: "Token numbers" },
            ...(onlineOn ? [{ id: "online-ordering", label: "Online ordering page" }] : []),
            ...(guestPagesOn ? [{ id: "guest-address", label: "Guest web address" }] : []),
          ]}
        >
        <div className="svc-sections">
          <PosSection
            settings={settings}
            canEdit={hasPermission("orders.manage")}
            onSaved={(next) => setSettings((current) => ({ ...current, ...next }))}
          />
          <TokensSection
            settings={settings}
            canEdit={hasPermission("orders.manage")}
            onSaved={(next) => setSettings((current) => ({ ...current, ...next }))}
          />
          {onlineOn && (
            <OnlineOrderingSection
              base={settings.guestWebAddress || customerWebOrigin()}
              canEdit={hasPermission("orders.manage")}
            />
          )}
          {guestPagesOn && (
            <GuestAddressSection
              settings={settings}
              canEdit={hasPermission("tables.manage")}
              onSaved={(next) => setSettings((current) => ({ ...current, ...next }))}
            />
          )}
        </div>
        </SettingsLayout>
      )}
    </div>
  );
}
