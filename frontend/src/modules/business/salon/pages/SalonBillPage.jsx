import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import ContentTabs from "../../../../components/ContentTabs";
import Modal from "../../../../components/Modal";
import { ErrorMessage } from "../../../../components/Feedback";
import useConfirm from "../../../../hooks/useConfirm";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { businessPath } from "../../../../services/businessNav";
import { dateShort } from "../../../../services/format";
import { toast } from "../../../../services/toast";
import { DocumentDetail } from "../../core/pages/DocumentsPage";
import { BusinessHeader, Field, FormError } from "../../core/pages/ui";
import { newKey, useDirtyGuard, useOpenBusiness, useOptions } from "../../core/pages/hooks";
import { printReceipt } from "../../retail/pages/retail";
import ClientPanel from "./ClientPanel";
import { ClientPicker } from "./salonParts";
import { timeOfDay, whatsappLink } from "./salon";
import { usePaymentMethods } from "../../core/pages/paymentMethods";
import "../styles/salon-pro.css";

// The salon counter: services and products on one bill, each service with
// the stylist who did it (for commission). Type or tap a service to add it;
// a client's package pays for its sessions; their membership discount comes
// off by itself; a deposit or other advance is taken off what is left to pay.
// Pay by up to three ways (UPI and the rest in cash — one bill, not a split
// bill), add a tip for the stylist, and a small discount with a reason where
// the role allows it. Every figure is the server's quote, worked out exactly
// as posting will.
const lineOf = (sku, extra = {}) => ({ key: newKey(), skuId: String(sku.id), quantity: "1", staffId: "", clientPlanId: "", appointmentId: "", ...extra });
const emptyPayment = (method = "upi") => ({ key: newKey(), method, amount: "", reference: "" });

export default function SalonBillPage() {
  const biz = useOpenBusiness();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const { options, error: optionsError } = useOptions(["catalog?active=true", "contacts?kind=customer&active=true", "salon/staff?kind=staff&active=true",
    ...(biz.has("packages") ? ["salon/plans?active=true"] : [])]);
  const locations = biz.locations.filter((l) => l.active);
  const [locationId, setLocationId] = useState(String(locations[0]?.id || ""));
  const [extraClients, setExtraClients] = useState([]);
  const [contact, setContact] = useState(undefined);
  const [summary, setSummary] = useState(null);
  const [lines, setLines] = useState([]);
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState("");
  const [useAdvance, setUseAdvance] = useState(true);
  const [payments, setPayments] = useState(() => [emptyPayment()]);
  // Each payment's `method` is one of the business's own methods (paymentMethods.js).
  const methods = usePaymentMethods();
  const [tip, setTip] = useState({ open: false, staffId: "", amount: "", method: "cash" });
  const [discount, setDiscount] = useState({ open: false, mode: "amount", value: "", reason: "" });
  const [notes, setNotes] = useState("");
  const [requestKey, setRequestKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [posted, setPosted] = useState(null);
  const [docId, setDocId] = useState(null);
  const [card, setCard] = useState(null);
  // Which list the "Add to the bill" card shows.
  const [addTab, setAddTab] = useState("services");
  const pendingAppointment = useRef(params.get("appointment"));
  const dirty = lines.length > 0 && !posted;
  useDirtyGuard(dirty);

  const items = useMemo(() => (options?.["catalog?active=true"] || []).filter((s) => !String(s.code).startsWith("SALON-FEE")), [options]);
  const plans = useMemo(() => options?.["salon/plans?active=true"] || [], [options]);
  const planOf = (skuId) => plans.find((p) => String(p.sku_id) === String(skuId));
  const staff = options?.["salon/staff?kind=staff&active=true"] || [];
  const clients = useMemo(() => [...extraClients, ...(options?.["contacts?kind=customer&active=true"] || [])], [extraClients, options]);
  // The client named in the address (from the calendar's "Bill now"), until someone picks another.
  const client = contact !== undefined ? contact : (params.get("contact") && clients.find((c) => String(c.id) === params.get("contact"))) || null;
  const contactId = client ? String(client.id) : "";
  const skuOf = (line) => items.find((s) => String(s.id) === String(line.skuId));
  // Two kinds of line: services (with packages and memberships), done by a
  // stylist; products sold over the counter. Items kept for use in services
  // only (back-bar colour, developer) are never offered for sale.
  const serviceItems = useMemo(() => items.filter((s) => s.kind === "service"), [items]);
  const productItems = useMemo(() => items.filter((s) => s.kind === "goods" && !s.internal_use), [items]);
  // Products by shelf group (Hair care, Skin care, …), in stock first.
  const productGroups = useMemo(() => {
    const map = new Map();
    for (const s of productItems) { const g = s.category || "Other products"; if (!map.has(g)) map.set(g, []); map.get(g).push(s); }
    return [...map.entries()].sort(([a], [b]) => (a === "Other products") - (b === "Other products") || a.localeCompare(b))
      .map(([name, list]) => ({ name, list: list.sort((x, y) => (Number(y.stock) > 0) - (Number(x.stock) > 0) || x.label.localeCompare(y.label)) }));
  }, [productItems]);
  const [productGroup, setProductGroup] = useState("");
  const shownProducts = productGroups.find((g) => g.name === productGroup) || productGroups[0];
  // Services by category, as the salon's menu card reads (Hair, Skin, …);
  // packages and memberships each have their own group at the end.
  const groupOf = (s) => { const plan = planOf(s.id); return plan ? (plan.kind === "membership" ? "Memberships" : "Packages") : s.category || "Other services"; };
  const serviceGroups = useMemo(() => {
    const map = new Map();
    for (const s of serviceItems) { const g = groupOf(s); if (!map.has(g)) map.set(g, []); map.get(g).push(s); }
    const last = ["Other services", "Packages", "Memberships"];
    return [...map.entries()].sort(([a], [b]) => (last.indexOf(a) - last.indexOf(b)) || a.localeCompare(b))
      .map(([name, list]) => ({ name, list: list.sort((x, y) => x.label.localeCompare(y.label)) }));
  }, [serviceItems, plans]); // eslint-disable-line react-hooks/exhaustive-deps
  const [serviceGroup, setServiceGroup] = useState("");
  const shownGroup = serviceGroups.find((g) => g.name === serviceGroup) || serviceGroups[0];

  const packagesFor = (line, held = summary) => (held?.packages || []).filter((p) => p.services.some((s) => String(s.sku_id) === String(line.skuId) && Number(s.sessions) > Number(s.used)));
  // A service the client has in a package is paid from it unless "charge it" is chosen.
  const packageFor = (line, held = summary) => String(packagesFor(line, held)[0]?.id || "");
  const preferred = summary?.profile?.preferred_resource_id ? String(summary.profile.preferred_resource_id) : "";

  // The client's memberships, packages, advance, unbilled bookings and card.
  useEffect(() => {
    if (!contactId) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, `salon/clients/${contactId}`, {}, controller.signal)
      .then((result) => {
        setSummary(result);
        const wanted = pendingAppointment.current && result.upcoming.find((a) => String(a.id) === String(pendingAppointment.current));
        if (wanted) {
          pendingAppointment.current = null;
          setLines([lineOf({ id: wanted.sku_id }, { staffId: String(wanted.resource_id), appointmentId: String(wanted.id), clientPlanId: packageFor({ skuId: wanted.sku_id }, result) })]);
          setParams((p) => new URLSearchParams(p.get("open") ? { open: p.get("open") } : {}), { replace: true });
        }
      })
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [biz.id, contactId, setParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickClient = (next) => {
    setContact(next);
    setSummary(null);
    setLines((all) => all.map((l) => ({ ...l, clientPlanId: "", appointmentId: "" })));
  };

  // The bookings on this bill are the ones on its lines: one booking, one line.
  const appointmentIds = [...new Set(lines.filter((l) => l.appointmentId).map((l) => String(l.appointmentId)))];
  const filled = lines.filter((l) => l.skuId && Number(l.quantity) > 0);
  const canDiscount = biz.can("sales.discount");
  const discountBody = canDiscount && discount.open && Number(discount.value) > 0 && discount.reason.trim()
    ? { discount: { [discount.mode]: discount.value, reason: discount.reason.trim() } } : {};
  const body = {
    locationId, contactId: contactId || null, useAdvance, appointmentIds, ...discountBody,
    lines: filled.map((l) => ({ skuId: l.skuId, quantity: l.quantity, ...(l.staffId ? { staffId: l.staffId } : {}), ...(l.clientPlanId ? { clientPlanId: l.clientPlanId } : {}),
      ...(l.appointmentId ? { appointmentId: l.appointmentId } : {}) })),
  };
  const bodyKey = JSON.stringify(body);
  useEffect(() => {
    if (!body.lines.length || !locationId) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      businessWrite(biz.id, "salon/quote", JSON.parse(bodyKey))
        .then((result) => { if (!controller.signal.aborted) { setQuote(result); setQuoteError(""); } })
        .catch((err) => { if (!controller.signal.aborted) setQuoteError(getErrorMessage(err)); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [biz.id, bodyKey, body.lines.length, locationId]);
  const shownQuote = body.lines.length ? quote : null;

  const setLine = (key, name, value) => setLines((all) => all.map((l) => (l.key === key ? { ...l, [name]: value } : l)));
  // Add a service, product, package or membership. Selling a plan the client
  // already holds asks first.
  const addItem = async (sku) => {
    if (!sku) return;
    const plan = planOf(sku.id);
    if (plan && summary) {
      const same = plan.kind === "membership" ? summary.memberships : summary.packages.filter((p) => String(p.plan_id) === String(plan.id));
      if (same.length && !(await confirm({
        title: `${client.name} already has ${plan.kind === "membership" ? "a membership" : "this package"}`, tone: "primary", confirmLabel: "Sell it anyway", cancelLabel: "Don't add",
        message: `${same[0].name} is valid till ${dateShort(same[0].ends_on)}.${plan.kind === "membership" ? " Only the best membership discount applies on a bill." : ""}`,
      }))) return;
    }
    const service = sku.kind === "service" && !plan;
    setLines((all) => [...all, lineOf(sku, { staffId: service ? preferred : "", clientPlanId: service ? packageFor({ skuId: sku.id }) : "" })]);
  };
  const addAppointment = (a) => {
    setLines((all) => (all.some((l) => String(l.appointmentId) === String(a.id)) ? all
      : [...all, lineOf({ id: a.sku_id }, { staffId: String(a.resource_id), appointmentId: String(a.id), clientPlanId: packageFor({ skuId: a.sku_id }) })]));
  };
  const toPay = shownQuote ? Number(shownQuote.toPay) : 0;
  const paymentAmount = (p, index) => (p.amount === "" && index === 0 ? Math.max(0, toPay - payments.slice(1).reduce((s, x) => s + Number(x.amount || 0), 0)) : Number(p.amount || 0));
  const paying = payments.reduce((s, p, i) => s + paymentAmount(p, i), 0);
  const tipAmount = tip.open && tip.staffId ? Number(tip.amount || 0) : 0;
  const walkInShort = !contactId && paying + 0.004 < toPay;
  const over = paying > toPay + 0.004;

  const post = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await businessWrite(biz.id, "salon/bills", {
        ...body, appointmentIds, notes: notes || null, requestKey,
        payments: payments.map((p, i) => ({ amount: paymentAmount(p, i).toFixed(2), ...methods.body(p.method), reference: p.reference || null })).filter((p) => Number(p.amount) > 0),
        // A tip is recorded by its kind (the stylist's tips are counted by cash, UPI…).
        ...(tipAmount > 0 ? { tips: [{ staffId: tip.staffId, amount: tipAmount.toFixed(2), method: methods.kindOf(tip.method) }] } : {}),
      });
      const firstService = filled.find((l) => skuOf(l)?.kind === "service" && !planOf(l.skuId));
      setPosted({ ...result, paid: paying, total: shownQuote?.total, savings: shownQuote?.savings, tip: tipAmount, client, next: firstService ? { sku: firstService.skuId, staff: firstService.staffId } : null });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const reset = () => {
    setPosted(null); setLines([]); setContact(null); setSummary(null); setQuote(null);
    setPayments([emptyPayment()]); setTip({ open: false, staffId: "", amount: "", method: "cash" }); setDiscount({ open: false, mode: "amount", value: "", reason: "" });
    setNotes(""); setRequestKey(newKey()); setUseAdvance(true);
  };

  const isProduct = (l) => skuOf(l)?.kind === "goods";
  const serviceLines = lines.filter((l) => !isProduct(l));
  const productLines = lines.filter(isProduct);
  const columns = [
    { key: "item", header: "Service or product", minWidth: 220, value: (l) => skuOf(l)?.label || "",
      render: (l) => {
        const sku = skuOf(l);
        const plan = planOf(l.skuId);
        return (
          <div className="sw-item">
            <strong>{sku?.label || "…"}</strong>
            <small className="muted">{plan ? (plan.kind === "membership" ? "Membership" : "Package") : sku?.kind === "service" ? "Service" : "Product"}{sku ? ` · ${biz.exact(sku.price)}` : ""}{l.appointmentId ? " · booked" : ""}</small>
          </div>
        );
      } },
    { key: "quantity", header: "Qty", type: "number", value: (l) => Number(l.quantity) || 0, width: 92, minWidth: 84,
      render: (l, ctx) => <input aria-label={ctx.label} type="number" min="1" step="1" value={l.quantity} onChange={(e) => setLine(l.key, "quantity", e.target.value)} /> },
    { key: "staff", header: "Stylist", width: 150, value: (l) => staff.find((s) => String(s.id) === l.staffId)?.name || "",
      render: (l, ctx) => (
        <select aria-label={ctx.label} value={l.staffId} onChange={(e) => setLine(l.key, "staffId", e.target.value)}>
          <option value="">{skuOf(l)?.kind === "service" && !planOf(l.skuId) ? "Choose…" : "—"}</option>
          {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      ) },
    // Shown only when this client has a package to pay from.
    biz.has("packages") && (summary?.packages || []).length > 0 && { key: "package", header: "Package", width: 170, value: (l) => l.clientPlanId,
      render: (l, ctx) => {
        const choices = packagesFor(l);
        if (!choices.length) return <span className="muted">—</span>;
        return (
          <select aria-label={ctx.label} value={l.clientPlanId} onChange={(e) => setLine(l.key, "clientPlanId", e.target.value)}>
            <option value="">No — charge it</option>
            {choices.map((p) => {
              const s = p.services.find((x) => String(x.sku_id) === String(l.skuId));
              return <option key={p.id} value={p.id}>{p.name} ({Number(s.sessions) - Number(s.used)} left)</option>;
            })}
          </select>
        );
      } },
    { key: "amount", header: "Price", type: "money", exact: true, width: 104, value: (l) => Number(quoteLine(shownQuote, filled, l)?.amount || 0) },
    { key: "less", header: "Less", type: "money", exact: true, width: 96, value: (l) => Number(quoteLine(shownQuote, filled, l)?.discount || 0),
      render: (l) => {
        const q = quoteLine(shownQuote, filled, l);
        if (!q || !Number(q.discount)) return <span className="muted">—</span>;
        return <span title={q.offers.map((o) => o.label).join(", ")}>−{biz.exact(q.discount)}</span>;
      } },
    { key: "remove", header: "", label: "Remove", type: "actions", width: 56, minWidth: 56,
      render: (l) => (
        <button type="button" className="icon-button danger" aria-label="Remove this line" title="Remove this line"
          onClick={() => setLines((all) => all.filter((x) => x.key !== l.key))}><Icon name="trash" size={16} /></button>
      ) },
  ].filter(Boolean);
  // A service line: the service, who did it (needed for commission), a
  // package to pay from, the price. Its quantity is one a line.
  const serviceColumns = columns.filter((c) => c.key !== "quantity").map((c) => (c.key === "item" ? { ...c, header: "Service" } : c.key === "staff" ? { ...c, header: "Done by" } : c));
  // A product line: the product with its stock, how many, who sold it (optional), the price.
  const productColumns = columns.filter((c) => c.key !== "package").map((c) => {
    if (c.key === "item") return { ...c, header: "Product", render: (l) => {
      const sku = skuOf(l);
      return <div className="sw-item"><strong>{sku?.label || "…"}</strong><small className="muted">{sku ? `${biz.exact(sku.price)} each · ${Number(sku.stock)} in stock` : ""}</small></div>;
    } };
    if (c.key === "staff") return { ...c, header: "Sold by", render: (l, ctx) => (
      <select aria-label={ctx.label} value={l.staffId} onChange={(e) => setLine(l.key, "staffId", e.target.value)}>
        <option value="">Nobody</option>
        {staff.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
    ) };
    return c;
  });
  // What each part comes to before discounts (the server's quote).
  const partTotal = (products) => filled.reduce((sum, l) => sum + (isProduct(l) === products ? Number(quoteLine(shownQuote, filled, l)?.amount || 0) : 0), 0);
  // One more of a product already on the bill adds to its quantity.
  const addProduct = (sku) => {
    if (!sku) return;
    const same = lines.find((l) => String(l.skuId) === String(sku.id));
    if (same) setLine(same.key, "quantity", String(Number(same.quantity || 0) + 1));
    else addItem(sku);
  };

  return (
    <div className="stack">
      <BusinessHeader icon="receipt" title="New bill" description="Client, services done, products bought, then payment." />
      <ErrorMessage message={error || optionsError} />
      <div className="sw-bill">
        <div className="sw-stack">
          {/* The client in one line: who it is (walk-in if empty), where, and their card. */}
          <section className="card sw-client-bar" aria-label="Client">
            <div className="sw-client-row">
              <span className="sw-client-icon" aria-hidden="true"><Icon name="user" size={18} /></span>
              <strong className="sw-client-title">Client</strong>
              <div className="sw-client-pick">
                <ClientPicker value={client} onChange={pickClient} clients={clients} onCreated={(c) => setExtraClients((all) => [c, ...all])} walkIn hideLabel
                  label="Client (walk-in if left empty)" />
              </div>
              {locations.length > 1 && (
                <select aria-label="Location" className="sw-client-location" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              )}
              {client && <button type="button" className="button button-secondary button-sm" onClick={() => setCard(client.id)}><Icon name="user" size={14} /> Client card</button>}
            </div>
            {contactId && summary && <ClientCard biz={biz} summary={summary} billed={appointmentIds} onAdd={addAppointment} />}
          </section>
          {/* Adding stays in one place (tabs), the bill grows below it: a long
              list of services never pushes the products out of reach. */}
          <SectionCard flush icon="plus" title="Add to the bill" className="sw-add">
            <ContentTabs label="What to add" value={addTab} onChange={setAddTab}
              options={[{ value: "services", label: "Services" }, { value: "products", label: `Products for sale${productItems.length ? ` (${productItems.length})` : ""}` }]}>
              {addTab === "services" ? (
                <div className="sw-add-panel">
                  <SearchPicker aria-label="Add a service" options={serviceItems} clearOnSelect onChange={addItem} disabled={!options}
                    getKey={(s) => s.id} getLabel={(s) => s.label}
                    getDescription={(s) => `${planOf(s.id) ? (planOf(s.id).kind === "membership" ? "Membership" : "Package") : "Service"} · ${biz.exact(s.price)}`}
                    getKeywords={(s) => `${s.code || ""} ${s.category || ""}`}
                    placeholder="Search a service, package or membership" />
                  {serviceGroups.length > 0 && (
                    <>
                      <div className="sw-cats" role="group" aria-label="Service categories">
                        {serviceGroups.map((g) => (
                          <button key={g.name} type="button" className={`sw-cat ${shownGroup?.name === g.name ? "is-active" : ""}`} aria-pressed={shownGroup?.name === g.name}
                            onClick={() => setServiceGroup(g.name)}>{g.name} <small>{g.list.length}</small></button>
                        ))}
                      </div>
                      <div className="sw-tiles" aria-label={`${shownGroup.name} services`}>
                        {shownGroup.list.map((s) => {
                          const count = serviceLines.filter((l) => String(l.skuId) === String(s.id)).length;
                          return (
                            <button key={s.id} type="button" className={`sw-tile ${count ? "is-on" : ""}`} onClick={() => addItem(s)} title={`Add ${s.label}`}>
                              <span className="sw-tile-name">{s.label}</span>
                              <span className="sw-tile-price">{biz.amount(s.price)}{count ? <small> · {count} on bill</small> : null}</span>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="sw-add-panel">
                  <SearchPicker aria-label="Add a product" options={productItems} clearOnSelect onChange={addProduct} disabled={!options}
                    getKey={(s) => s.id} getLabel={(s) => s.label}
                    getDescription={(s) => `${biz.exact(s.price)} · ${Number(s.stock) > 0 ? `${Number(s.stock)} in stock` : "out of stock"}`}
                    getKeywords={(s) => `${s.code || ""} ${s.barcode || ""} ${s.category || ""} ${s.brand || ""}`} isDisabled={(s) => Number(s.stock) <= 0}
                    placeholder="Search a product, or scan its barcode" />
                  {productGroups.length > 0 ? (
                    <>
                      <div className="sw-cats" role="group" aria-label="Product groups">
                        {productGroups.map((g) => (
                          <button key={g.name} type="button" className={`sw-cat ${shownProducts?.name === g.name ? "is-active" : ""}`} aria-pressed={shownProducts?.name === g.name}
                            onClick={() => setProductGroup(g.name)}>{g.name} <small>{g.list.length}</small></button>
                        ))}
                      </div>
                      <div className="sw-tiles" aria-label={`${shownProducts.name} products`}>
                        {shownProducts.list.map((s) => {
                          const on = productLines.find((l) => String(l.skuId) === String(s.id));
                          const stock = Number(s.stock);
                          const out = stock <= 0;
                          return (
                            <button key={s.id} type="button" className={`sw-tile is-product ${on ? "is-on" : ""} ${out ? "is-out" : ""}`} disabled={out}
                              onClick={() => addProduct(s)} title={out ? `${s.label}: out of stock` : `Add ${s.label}`}>
                              <span className="sw-tile-name">{s.label}</span>
                              <span className="sw-tile-price">{biz.amount(s.price)}</span>
                              <span className={`sw-tile-stock ${out ? "is-out" : stock <= 3 ? "is-low" : ""}`}>
                                {out ? "Out of stock" : `${stock} in stock`}{on ? ` · ${Number(on.quantity)} on bill` : ""}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  ) : <p className="sw-note">No products for sale yet. Add them in Services & products as goods kept in stock.</p>}
                </div>
              )}
            </ContentTabs>
          </SectionCard>
          <SectionCard flush icon="list" title={`On this bill${lines.length ? ` · ${lines.length} ${lines.length === 1 ? "line" : "lines"}` : ""}`} className="sw-lines">
            {!lines.length ? (
              <p className="sw-note sw-pad">Nothing yet. Add the services done (a booking from the calendar comes in by itself, with its stylist), then any products bought.</p>
            ) : (
              <>
                {serviceLines.length > 0 && (
                  <div className="sw-group is-services">
                    <div className="sw-group-head">
                      <span><Icon name="sparkles" size={15} /> Services <small className="muted">· {serviceLines.length}</small></span>
                      <strong>{biz.exact(partTotal(false))}</strong>
                    </div>
                    <DataGrid variant="editor" caption="Services on the bill" rows={serviceLines} rowKey={(l) => l.key} columns={serviceColumns} currency={biz.symbol} />
                  </div>
                )}
                {productLines.length > 0 && (
                  <div className="sw-group is-products">
                    <div className="sw-group-head">
                      <span><Icon name="tag" size={15} /> Products <small className="muted">· {productLines.length}</small></span>
                      <strong>{biz.exact(partTotal(true))}</strong>
                    </div>
                    <DataGrid variant="editor" caption="Products on the bill" rows={productLines} rowKey={(l) => l.key} columns={productColumns} currency={biz.symbol} />
                  </div>
                )}
              </>
            )}
          </SectionCard>
        </div>
        <div className="sw-bill-side">
          <SectionCard icon="receipt" title="Total">
            <FormError message={quoteError} />
            {!shownQuote ? <p className="sw-note">Add a service or a product to see the bill.</p> : (
              <dl className="sw-sum">
                {serviceLines.length > 0 && productLines.length > 0 && <>
                  <div><dt>Services ({serviceLines.length})</dt><dd>{biz.exact(partTotal(false))}</dd></div>
                  <div><dt>Products ({productLines.length})</dt><dd>{biz.exact(partTotal(true))}</dd></div>
                </>}
                <div><dt>Before discounts</dt><dd>{biz.exact(shownQuote.lines.reduce((s, l) => s + Number(l.amount), 0))}</dd></div>
                {Number(shownQuote.savings) > 0 && <div className="is-saving"><dt>Discounts & membership</dt><dd>−{biz.exact(shownQuote.savings)}</dd></div>}
                <div><dt>{shownQuote.taxMode === "inclusive" ? "GST included" : "GST"}</dt><dd>{biz.exact(shownQuote.tax)}</dd></div>
                {Number(shownQuote.roundOff) !== 0 && <div><dt>Round-off</dt><dd>{biz.exact(shownQuote.roundOff)}</dd></div>}
                <div className="is-total"><dt>Total</dt><dd>{biz.exact(shownQuote.total)}</dd></div>
                {Number(shownQuote.advance) > 0 && (
                  <div>
                    <dt><label className="bz-check"><input type="checkbox" checked={useAdvance} onChange={(e) => setUseAdvance(e.target.checked)} /> Use deposit / advance</label></dt>
                    <dd>−{biz.exact(useAdvance ? shownQuote.advanceUsable : 0)}</dd>
                  </div>
                )}
                <div className="is-total"><dt>To pay</dt><dd>{biz.exact(shownQuote.toPay)}</dd></div>
              </dl>
            )}
            {canDiscount && (discount.open ? (
              <div className="form-grid" style={{ marginTop: "0.75rem" }}>
                <Field label="Discount">
                  <span className="sw-row" style={{ flexWrap: "nowrap" }}>
                    <input type="number" min="0" step="0.01" value={discount.value} onChange={(e) => setDiscount((d) => ({ ...d, value: e.target.value }))} aria-label="Discount" />
                    <select aria-label="Discount as" value={discount.mode} onChange={(e) => setDiscount((d) => ({ ...d, mode: e.target.value }))} style={{ width: "5rem" }}>
                      <option value="amount">{biz.symbol}</option><option value="percent">%</option>
                    </select>
                  </span>
                </Field>
                <Field label="Why"><input maxLength={120} value={discount.reason} onChange={(e) => setDiscount((d) => ({ ...d, reason: e.target.value }))} placeholder="Regular client" /></Field>
                {Number(discount.value) > 0 && !discount.reason.trim() && <p className="sw-warn field-wide">Say why, and the discount comes off.</p>}
              </div>
            ) : <button type="button" className="link-button" style={{ marginTop: "0.5rem" }} onClick={() => setDiscount((d) => ({ ...d, open: true }))}>+ Discount</button>)}
          </SectionCard>
          <SectionCard icon="wallet" title="Payment">
            <div className="sw-stack">
              {payments.map((p, i) => (
                <div key={p.key} className="sw-pay-row">
                  <Field label={i === 0 ? "Paid by" : "And by"}>
                    <select value={methods.resolve(p.method)} onChange={(e) => setPayments((all) => all.map((x) => (x.key === p.key ? { ...x, method: e.target.value } : x)))}>
                      {methods.options().map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
                    </select>
                  </Field>
                  <Field label={`Amount (${biz.symbol})`}>
                    <input type="number" min="0" step="0.01" value={p.amount === "" && i === 0 ? (shownQuote ? paymentAmount(p, 0).toFixed(2) : "") : p.amount}
                      onChange={(e) => setPayments((all) => all.map((x) => (x.key === p.key ? { ...x, amount: e.target.value } : x)))} />
                  </Field>
                  {i > 0 ? <button type="button" className="icon-button danger" aria-label="Remove this payment" onClick={() => setPayments((all) => all.filter((x) => x.key !== p.key))}><Icon name="x" size={16} /></button> : <span />}
                  {methods.kindOf(p.method) !== "cash" && <Field label={methods.kindOf(p.method) === "cheque" ? "Cheque number" : "Reference"} wide><input maxLength={100} value={p.reference} onChange={(e) => setPayments((all) => all.map((x) => (x.key === p.key ? { ...x, reference: e.target.value } : x)))} placeholder="UPI / card slip number" /></Field>}
                </div>
              ))}
              {payments.length < 3 && shownQuote && toPay > 0 && (
                <button type="button" className="link-button" onClick={() => setPayments((all) => [...all.map((x, i) => (i === 0 && x.amount === "" ? { ...x, amount: paymentAmount(x, 0).toFixed(2) } : x)), emptyPayment("cash")])}>+ Another way (UPI and the rest in cash)</button>
              )}
              {payments.length > 1 && <p className={`sw-pay-total ${over || (walkInShort && paying > 0) ? "sw-warn" : ""}`}><span>Paying now</span><strong>{biz.exact(paying)} of {biz.exact(toPay)}</strong></p>}
              {tip.open ? (
                <div className="sw-pay-row is-tip">
                  <Field label="Tip for">
                    <select value={tip.staffId} onChange={(e) => setTip((t) => ({ ...t, staffId: e.target.value }))}>
                      <option value="">Choose…</option>
                      {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </Field>
                  <Field label={`Tip (${biz.symbol})`}><input type="number" min="0" step="1" value={tip.amount} onChange={(e) => setTip((t) => ({ ...t, amount: e.target.value }))} /></Field>
                  <select aria-label="Tip paid by" className="sw-tip-method" value={methods.resolve(tip.method)} onChange={(e) => setTip((t) => ({ ...t, method: e.target.value }))}>
                    {methods.options().map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
                  </select>
                </div>
              ) : biz.can("sales.edit") && <button type="button" className="link-button" onClick={() => setTip((t) => ({ ...t, open: true, staffId: lines.find((l) => l.staffId)?.staffId || "" }))}>+ Tip for the stylist</button>}
              <Field label="Notes" wide><input maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
              {!contactId && toPay > 0 && <small className="muted">A walk-in pays the whole bill now.</small>}
              <button type="button" className="button sw-take" style={{ width: "100%" }} onClick={post}
                disabled={busy || !shownQuote || Boolean(quoteError) || !biz.can("sales.create") || walkInShort || over}>
                {busy ? "Saving…" : shownQuote ? (
                  <>
                    {toPay > 0 ? `Take ${biz.exact(paying)}` : "Save bill"}{tipAmount > 0 ? ` + ${biz.exact(tipAmount)} tip` : ""}
                    <small>Total {biz.exact(shownQuote.total)}{paying + 0.004 < toPay ? ` · ${biz.exact(toPay - paying)} left owed` : ""}</small>
                  </>
                ) : "Save bill"}
              </button>
            </div>
          </SectionCard>
        </div>
      </div>
      <ClientPanel contactId={card} onClose={() => setCard(null)}
        onBook={(c) => navigate(`${businessPath(biz.id, "salon-calendar")}?book=1&contact=${c.contact.id}${c.profile?.preferred_resource_id ? `&staff=${c.profile.preferred_resource_id}` : ""}`)} />
      {/* The saved bill opens over the page (as at Quick bill); closing it starts the next bill. */}
      {posted && <BillDone biz={biz} posted={posted} onNext={reset} onOpen={() => setDocId(posted.document.id)} docId={docId} onCloseDoc={() => setDocId(null)}
        onBookNext={() => navigate(`${businessPath(biz.id, "salon-calendar")}?book=1&contact=${posted.client?.id || ""}${posted.next ? `&sku=${posted.next.sku}&staff=${posted.next.staff}` : ""}`)} />}
    </div>
  );
}

// After the bill, in a pop-up over the page: print, send on WhatsApp, book
// the next visit, or start the next bill (Enter, or closing it).
function BillDone({ biz, posted, onNext, onOpen, docId, onCloseDoc, onBookNext }) {
  const doc = posted.document;
  const phone = posted.client?.phone;
  const print = async () => {
    try {
      printReceipt(await businessRead(biz.id, `documents/${doc.id}`), biz);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  };
  const text = `Thank you for visiting ${biz.business.name}! Bill ${doc.document_no}: ${biz.exact(doc.total)}${Number(posted.savings) > 0 ? ` (you saved ${biz.exact(posted.savings)})` : ""}. See you again soon.`;
  useEffect(() => {
    const onKey = (event) => {
      // A focused button answers Enter itself.
      if (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(event.target?.tagName || "") || docId) return;
      if (event.key === "Enter") onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNext, docId]);
  return (
    <>
      <Modal title={`Bill ${doc.document_no} saved`} icon="check" width={640} onClose={onNext}>
        <dl className="sw-facts">
          <div><dt>Total</dt><dd>{biz.exact(doc.total)}</dd></div>
          <div><dt>From the advance</dt><dd>{biz.exact(posted.advanceApplied)}</dd></div>
          <div><dt>Paid now</dt><dd>{biz.exact(posted.paid)}</dd></div>
          {posted.tip > 0 && <div><dt>Tip for the stylist</dt><dd>{biz.exact(posted.tip)}</dd></div>}
          {Number(posted.savings) > 0 && <div><dt>Client saved</dt><dd>{biz.exact(posted.savings)}</dd></div>}
        </dl>
        <div className="sw-row" style={{ marginTop: "1rem" }}>
          <button type="button" className="button" data-autofocus onClick={onNext}><Icon name="plus" size={15} /> Next bill <kbd>Enter</kbd></button>
          {biz.can("sales.print") && <button type="button" className="button button-secondary" onClick={print}><Icon name="print" size={15} /> Print</button>}
          {phone && <a className="button button-secondary" href={whatsappLink(phone, text)} target="_blank" rel="noreferrer"><Icon name="message" size={15} /> WhatsApp bill</a>}
          {posted.client && biz.can("appointments.create") && <button type="button" className="button button-secondary" onClick={onBookNext}><Icon name="calendar" size={15} /> Book next visit</button>}
          <button type="button" className="button button-secondary" onClick={onOpen}>Open the bill</button>
        </div>
      </Modal>
      {docId && <DocumentDetail documentId={docId} onClose={onCloseDoc} onChanged={() => {}} />}
    </>
  );
}

// The quote's line for an on-screen line (quotes list only filled lines, in order).
function quoteLine(quote, filled, line) {
  if (!quote) return null;
  const index = filled.findIndex((l) => l.key === line.key);
  return index >= 0 ? quote.lines[index] : null;
}

function ClientCard({ biz, summary, billed, onAdd }) {
  const tz = biz.business.timezone;
  // A booking already on this bill is not offered again.
  const waiting = summary.upcoming.filter((a) => !a.bill_document_id && !billed.includes(String(a.id)));
  // A booking on a later day is billed (and so marked done) on its own day.
  const dayOf = (value) => new Date(value).toLocaleDateString("en-CA", { timeZone: tz });
  const [now] = useState(() => Date.now());
  const laterDay = (value) => dayOf(value) > dayOf(now);
  const stats = summary.stats || {};
  return (
    <div className="sw-stack" style={{ marginTop: "0.75rem" }}>
      <div className="sw-chips">
        {summary.profile?.allergies && <span className="sw-chip is-danger"><Icon name="alert-circle" size={13} /> Allergy: {summary.profile.allergies}</span>}
        {summary.memberships.map((m) => <span key={m.id} className="sw-chip is-primary"><Icon name="star" size={13} /> {m.name}: {Number(m.service_discount_percent)}% services, {Number(m.product_discount_percent)}% products · till {dateShort(m.ends_on)}</span>)}
        {summary.packages.map((p) => <span key={p.id} className="sw-chip is-success"><Icon name="gift" size={13} /> {p.name}: {p.sessions_total - p.sessions_used} of {p.sessions_total} left · till {dateShort(p.ends_on)}</span>)}
        {Number(summary.advance) > 0 && <span className="sw-chip"><Icon name="wallet" size={13} /> Deposit / advance {biz.exact(summary.advance)}</span>}
        {Number(summary.held) > 0 && <span className="sw-chip" title="Kept for bookings still to come; used when that booking is on the bill"><Icon name="clock" size={13} /> Held for coming bookings {biz.exact(summary.held)}</span>}
        {stats.visits > 0 && <span className="sw-chip"><Icon name="history" size={13} /> {stats.visits} visit{stats.visits === 1 ? "" : "s"}{stats.usual_stylist ? ` · usually ${stats.usual_stylist}` : ""}</span>}
        {stats.no_shows > 0 && <span className="sw-chip is-warning"><Icon name="alert" size={13} /> {stats.no_shows} no-show{stats.no_shows === 1 ? "" : "s"}</span>}
        {!summary.memberships.length && !summary.packages.length && !Number(summary.advance) && !stats.visits && <span className="sw-note">First visit. No membership, package or advance.</span>}
      </div>
      {summary.notes?.find((n) => n.kind === "formula") && (
        <p className="sw-note"><strong>Last formula:</strong> {summary.notes.find((n) => n.kind === "formula").body} ({dateShort(summary.notes.find((n) => n.kind === "formula").created_at)})</p>
      )}
      {waiting.length > 0 && (
        <ul className="sw-list" aria-label="Bookings to bill">
          {waiting.map((a) => (
            <li key={a.id}>
              <span>{dateShort(a.starts_at)}, {timeOfDay(a.starts_at, tz)} · {a.service_name} with {a.resource_name}{a.status === "completed" ? " (done)" : ""}</span>
              {laterDay(a.starts_at)
                ? <span className="muted small" title="A booking is billed on its day">Bill on the day</span>
                : <button type="button" className="chip-button" onClick={() => onAdd(a)}>Add to bill</button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

