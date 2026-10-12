import { useMemo, useState } from "react";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "../../../../components/Icon";
import SearchPicker from "../../../../components/SearchPicker";
import SectionCard from "../../../../components/SectionCard";
import { ErrorMessage } from "../../../../components/Feedback";
import useConfirm from "../../../../hooks/useConfirm";
import { businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { dateShort } from "../../../../services/format";
import { toast } from "../../../../services/toast";
import FormDialog from "../../core/pages/FormDialog";
import { ActiveBadge, Badge, BusinessHeader, Field, FormError } from "../../core/pages/ui";
import { businessToday, quantity, useOpenBusiness, useOptions, useServerList } from "../../core/pages/hooks";
import { Segmented } from "./shared";

// Trade prices by price group, and schemes (free goods or a discount for a
// period). The server picks the price when an order is taken: the customer's
// own price first, then their group's, then a slab for everyone, then the
// list price; schemes are applied on top.

const TABS = [
  { value: "prices", label: "Group prices" },
  { value: "groups", label: "Price groups" },
  { value: "schemes", label: "Schemes" },
];

const STATES = {
  current: { tone: "success", label: "Current" },
  upcoming: { tone: "info", label: "Upcoming" },
  ended: { tone: "neutral", label: "Ended" },
  off: { tone: "neutral", label: "Switched off" },
};

const GROUPS = "price-groups?active=true";
const ITEMS = "catalog?active=true&kind=goods";

function StateBadge({ state }) {
  const s = STATES[state] || { tone: "neutral", label: state };
  return <Badge status={state} tone={s.tone} label={s.label} />;
}

// A refusal FormDialog shows like the server's own sentence.
const refuse = (message) => Object.assign(new Error(message), { response: { data: { message } } });

// "per case (12 pcs)" choices for an item: its stock unit, then its pack sizes.
function perChoices(item) {
  if (!item) return [];
  return [
    { value: "", label: `Per ${item.unit}` },
    ...(item.pack_sizes || []).map((p) => ({ value: p.unit_code, label: `Per ${p.unit_code} (${quantity(p.quantity_in_base, item.unit)})` })),
  ];
}

const perWord = (row) => row.unit_code || row.unit || "";

export default function PriceGroupsPage() {
  const biz = useOpenBusiness();
  const [tab, setTab] = useState("prices");
  const edit = biz.can("wholesale.edit");
  return (
    <div className="stack">
      <BusinessHeader icon="tag" title="Price groups & schemes"
        description="Each trade customer can belong to one price group (set it on the customer). A customer's own price (Price lists) comes first, then their group's price, then a slab for everyone, then the list price. Schemes give free goods or a discount for a period; the server applies them when an order is taken." />
      <Segmented label="Show" value={tab} options={TABS} onChange={setTab} />
      {tab === "prices" && <GroupPrices edit={edit} />}
      {tab === "groups" && <PriceGroups edit={edit} />}
      {tab === "schemes" && <Schemes edit={edit} />}
    </div>
  );
}

// --- Group prices -----------------------------------------------------------

const PRICE_STATES = [
  { value: "current", label: "Current" },
  { value: "upcoming", label: "Upcoming" },
  { value: "ended", label: "Ended" },
  { value: "all", label: "All" },
];

function GroupPrices({ edit }) {
  const biz = useOpenBusiness();
  const confirm = useConfirm();
  const [state, setState] = useState("current");
  const [group, setGroup] = useState("");
  const params = { ...(state !== "all" ? { state } : {}), ...(group ? { group } : {}) };
  const list = useServerList("group-prices", { gridId: "wholesale-group-prices", params });
  const { reload } = list;
  const { options, error } = useOptions([GROUPS, ITEMS]);
  const groups = useMemo(() => options?.[GROUPS] || [], [options]);
  const items = useMemo(() => options?.[ITEMS] || [], [options]);
  const [editing, setEditing] = useState(null);
  const [revising, setRevising] = useState(false);

  const columns = useMemo(() => {
    async function end(p) {
      const upcoming = p.state === "upcoming";
      if (!(await confirm({
        title: upcoming ? "Withdraw this price?" : "End this price today?",
        message: upcoming
          ? `${p.group_name} will not get ${biz.exact(p.unit_price)} for ${p.label}. The price before it carries on.`
          : `${p.group_name} stops getting ${biz.exact(p.unit_price)} for ${p.label}. Orders then take the next price that applies.`,
        confirmLabel: upcoming ? "Withdraw" : "End price",
      }))) return;
      try {
        const result = await businessWrite(biz.id, `group-prices/${p.id}/end`, {});
        toast.success(result?.withdrawn ? "Upcoming price withdrawn" : "Price ended");
        reload();
      } catch (err) {
        toast.error(getErrorMessage(err));
      }
    }
    return [
      { key: "group", header: "Group", value: (p) => p.group_name, mobile: "subtitle", pin: true },
      { key: "item", header: "Item", value: (p) => p.label, mobile: "title",
        render: (p) => <span className="bz-two-line"><strong>{p.label}</strong>{p.sku_code && <small className="muted">{p.sku_code}</small>}</span> },
      { key: "per", header: "Per", value: perWord },
      { key: "min", header: "From qty", type: "number", value: (p) => Number(p.minimum_quantity) },
      { key: "price", header: "Price", type: "money", exact: true, value: (p) => Number(p.unit_price), mobile: "show" },
      { key: "list", header: "List price", type: "money", exact: true, value: (p) => Number(p.list_price), defaultHidden: true },
      { key: "from", header: "Valid from", type: "date", value: (p) => p.valid_from, render: (p) => dateShort(p.valid_from), mobile: "show" },
      { key: "to", header: "Valid to", type: "date", value: (p) => p.valid_to || "", render: (p) => (p.valid_to ? dateShort(p.valid_to) : <span className="muted">open</span>) },
      { key: "state", header: "State", type: "status", value: (p) => p.state, render: (p) => <StateBadge state={p.state} />, mobile: "show" },
      { key: "by", header: "Set by", value: (p) => p.created_by_name || "", defaultHidden: true },
      edit && { key: "actions", header: "", label: "Actions", type: "actions", render: (p) => (
        <div className="row-actions">
          {p.state !== "ended" && <button type="button" className="chip-button" onClick={() => setEditing(p)}>Change price</button>}
          {(p.state === "current" || p.state === "upcoming") && <button type="button" className="chip-button" onClick={() => end(p)}>End</button>}
        </div>
      ) },
    ].filter(Boolean);
  }, [edit, biz, confirm, reload]);

  const ready = groups.length > 0 && items.length > 0;
  return (
    <>
      <ErrorMessage message={list.error || error} />
      <SectionCard flush icon="tag" title="Group prices"
        actions={edit && (
          <>
            <button type="button" className="button button-sm button-secondary" disabled={!ready} onClick={() => setRevising(true)}>Revise prices</button>
            <button type="button" className="button button-sm" disabled={!ready} title={groups.length ? undefined : "Add a price group first"} onClick={() => setEditing({})}><Icon name="plus" size={15} /> Set a price</button>
          </>
        )}>
        <DataGrid {...list.gridProps} caption="Group prices" columns={columns} currency={biz.symbol} rowNoun={["price", "prices"]}
          toolbar={(
            <>
              <Field label="Price group">
                <select value={group} onChange={(e) => setGroup(e.target.value)}>
                  <option value="">All groups</option>
                  {groups.map((g) => <option key={g.id} value={String(g.id)}>{g.name}</option>)}
                </select>
              </Field>
              <Segmented label="Prices" value={state} options={PRICE_STATES} onChange={setState} />
            </>
          )}
          exportName={biz.can("wholesale.export") ? `${biz.business.code}-group-prices` : undefined}
          rowClassName={(p) => (p.state === "ended" ? "dg-tone-muted" : "")}
          empty="No group prices here" emptyHint="Add a price group, then set a price for it." emptyIcon="tag" />
      </SectionCard>
      {editing && (
        <PriceDialog record={editing} groups={groups} items={items} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); list.reload(); }} />
      )}
      {revising && (
        <ReviseDialog groups={groups} items={items} onClose={() => setRevising(false)}
          onSaved={() => { setRevising(false); list.reload(); }} />
      )}
    </>
  );
}

function PriceDialog({ record, groups, items, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const changing = Boolean(record.id);
  const [form, setForm] = useState(() => ({
    groupId: String(record.group_id || (groups.length === 1 ? groups[0].id : "")),
    unitCode: record.unit_code || "",
    minimumQuantity: record.minimum_quantity ? String(Number(record.minimum_quantity)) : "1",
    unitPrice: "",
    validFrom: businessToday(biz.business.timezone),
    validTo: "",
  }));
  const [item, setItem] = useState(() => items.find((i) => String(i.id) === String(record.sku_id)) || null);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const choices = perChoices(item);
  const submit = () => {
    if (!item) return Promise.reject(refuse("Choose the item."));
    return businessWrite(biz.id, "group-prices", {
      groupId: form.groupId, skuId: item.id, unitCode: form.unitCode, minimumQuantity: form.minimumQuantity || 1,
      unitPrice: form.unitPrice, validFrom: form.validFrom || undefined, validTo: form.validTo || undefined,
    });
  };
  return (
    <FormDialog title={changing ? `Change price · ${record.label}` : "Set a price"} icon="tag" width={600}
      description="Starting a new price for the same line ends the old one the day before."
      submitLabel="Save price" successMessage="Price saved" onSubmit={submit} onClose={onClose} onSaved={onSaved}>
      <Field label="Price group" wide>
        <select required value={form.groupId} onChange={set("groupId")}>
          <option value="">Choose a group</option>
          {groups.map((g) => <option key={g.id} value={String(g.id)}>{g.name}</option>)}
        </select>
      </Field>
      <div className="field-wide">
        <SearchPicker label="Item" required value={item} options={items}
          onChange={(next) => { setItem(next); setForm((f) => ({ ...f, unitCode: "" })); }}
          getKey={(i) => i.id} getLabel={(i) => i.label}
          getDescription={(i) => [i.code, `List price ${biz.exact(i.price)} per ${i.unit}`].filter(Boolean).join(" · ")}
          getKeywords={(i) => i.code || ""} placeholder="Item name or code" />
      </div>
      <Field label="Per">
        <select value={form.unitCode} onChange={set("unitCode")} disabled={!item}>
          {(choices.length ? choices : [{ value: "", label: "Choose the item first" }]).map((c) => <option key={c.value || "base"} value={c.value}>{c.label}</option>)}
        </select>
      </Field>
      <Field label="From quantity" hint="The price applies when at least this many are ordered">
        <input type="number" min="0.001" step="any" required value={form.minimumQuantity} onChange={set("minimumQuantity")} />
      </Field>
      <Field label={`Price (${biz.symbol})`} hint={changing ? `Now ${biz.exact(record.unit_price)}` : undefined}>
        <input type="number" min="0" step="0.01" required value={form.unitPrice} onChange={set("unitPrice")} />
      </Field>
      <Field label="Valid from">
        <input type="date" required value={form.validFrom} onChange={set("validFrom")} />
      </Field>
      <Field label="Valid to (optional)" hint="Leave empty to keep it open">
        <input type="date" min={form.validFrom || undefined} value={form.validTo} onChange={set("validTo")} />
      </Field>
    </FormDialog>
  );
}

function ReviseDialog({ groups, items, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState(() => ({ groupId: "", percent: "", validFrom: businessToday(biz.business.timezone) }));
  const [some, setSome] = useState(false);
  const [chosen, setChosen] = useState(() => new Set());
  const [find, setFind] = useState("");
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const words = find.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = items.filter((i) => words.every((w) => `${i.label} ${i.code || ""}`.toLowerCase().includes(w)));
  const toggle = (id) => setChosen((all) => {
    const next = new Set(all);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const submit = () => {
    if (!Number(form.percent)) return Promise.reject(refuse("Enter the change in percent, like 5 or -3."));
    if (some && !chosen.size) return Promise.reject(refuse("Tick at least one item, or choose all items."));
    return businessWrite(biz.id, "group-prices/revise", {
      ...(form.groupId ? { groupId: form.groupId } : {}),
      ...(some ? { skuIds: [...chosen] } : {}),
      percent: form.percent, validFrom: form.validFrom,
    });
  };
  return (
    <FormDialog title="Revise prices" icon="percent" width={620}
      description="Raises or lowers the current group prices by a percentage. Each one gets a new price from the date you pick; the old price ends the day before."
      submitLabel="Revise prices" onSubmit={submit} onClose={onClose} onSaved={onSaved}
      successMessage={(r) => `${r.revised} ${r.revised === 1 ? "price" : "prices"} revised from ${dateShort(r.from)}`}>
      <Field label="Price group">
        <select value={form.groupId} onChange={set("groupId")}>
          <option value="">All groups</option>
          {groups.map((g) => <option key={g.id} value={String(g.id)}>{g.name}</option>)}
        </select>
      </Field>
      <Field label="Change (%)" hint="5 raises by 5%; -3 lowers by 3%">
        <input type="number" step="0.01" required value={form.percent} onChange={set("percent")} />
      </Field>
      <Field label="New prices from">
        <input type="date" required value={form.validFrom} onChange={set("validFrom")} />
      </Field>
      <Field label="Items">
        <select value={some ? "some" : "all"} onChange={(e) => setSome(e.target.value === "some")}>
          <option value="all">All items</option>
          <option value="some">Only the items I tick</option>
        </select>
      </Field>
      {some && (
        <div className="field-wide stack">
          <Field label={`Tick the items (${chosen.size} ticked)`} wide>
            <input type="search" placeholder="Find an item" value={find} onChange={(e) => setFind(e.target.value)} />
          </Field>
          <div role="group" aria-label="Items to revise" style={{ maxHeight: 240, overflowY: "auto", border: "1px solid var(--border, #ddd)", borderRadius: "var(--radius-md)", padding: "var(--space-2)" }}>
            {shown.map((i) => (
              <label key={i.id} className="checkbox bz-check">
                <input type="checkbox" checked={chosen.has(i.id)} onChange={() => toggle(i.id)} /> {i.label}{i.code ? <small className="muted"> · {i.code}</small> : null}
              </label>
            ))}
            {!shown.length && <p className="muted">No item matches.</p>}
          </div>
        </div>
      )}
    </FormDialog>
  );
}

// --- Price groups -----------------------------------------------------------

function PriceGroups({ edit }) {
  const list = useServerList("price-groups", { gridId: "wholesale-price-groups" });
  const [editing, setEditing] = useState(null);
  const columns = useMemo(() => [
    { key: "name", header: "Price group", value: (g) => g.name, mobile: "title", pin: true },
    { key: "notes", header: "Notes", value: (g) => g.notes || "", mobile: "subtitle" },
    { key: "customers", header: "Customers", type: "number", value: (g) => Number(g.customer_count), mobile: "show" },
    { key: "prices", header: "Prices", type: "number", value: (g) => Number(g.price_count), mobile: "show" },
    { key: "active", header: "Status", type: "status", value: (g) => (g.active ? "active" : "inactive"), render: (g) => <ActiveBadge active={g.active} /> },
    edit && { key: "actions", header: "", label: "Actions", type: "actions", render: (g) => <button type="button" className="chip-button" onClick={() => setEditing(g)}>Edit</button> },
  ].filter(Boolean), [edit]);
  return (
    <>
      <ErrorMessage message={list.error} />
      <SectionCard flush icon="users" title="Price groups"
        actions={edit && <button type="button" className="button button-sm" onClick={() => setEditing({})}><Icon name="plus" size={15} /> Add price group</button>}>
        <DataGrid {...list.gridProps} caption="Price groups" columns={columns} rowNoun={["group", "groups"]} rowClassName={(g) => (!g.active ? "dg-tone-muted" : "")}
          empty="No price groups yet" emptyHint="For example: Retailers, Super stockists, Institutions." emptyIcon="users" />
      </SectionCard>
      {editing && <GroupDialog record={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); }} />}
    </>
  );
}

function GroupDialog({ record, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const editing = Boolean(record.id);
  const [form, setForm] = useState(() => ({ name: record.name || "", notes: record.notes || "", active: record.active ?? true }));
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const submit = () => (editing
    ? businessWrite(biz.id, `price-groups/${record.id}`, { name: form.name, notes: form.notes, active: form.active }, "patch")
    : businessWrite(biz.id, "price-groups", { name: form.name, ...(form.notes ? { notes: form.notes } : {}) }));
  return (
    <FormDialog title={editing ? `Edit ${record.name}` : "Add a price group"} icon="users" width={520}
      successMessage={(g) => `${g?.name || form.name} saved`} onSubmit={submit} onClose={onClose} onSaved={onSaved}>
      <FormError message="" />
      <Field label="Name" wide>
        <input required maxLength={100} value={form.name} onChange={set("name")} />
      </Field>
      <Field label="Notes (optional)" wide>
        <textarea rows={2} maxLength={500} value={form.notes} onChange={set("notes")} />
      </Field>
      {editing && <label className="checkbox bz-check"><input type="checkbox" checked={form.active} onChange={set("active")} /> Active</label>}
    </FormDialog>
  );
}

// --- Schemes ----------------------------------------------------------------

const SCHEME_STATES = [
  { value: "current", label: "Current" },
  { value: "upcoming", label: "Upcoming" },
  { value: "ended", label: "Ended" },
  { value: "off", label: "Switched off" },
  { value: "all", label: "All" },
];

const num = (v) => Number(v || 0);
function offerText(s) {
  const per = s.unit_code || s.unit || "";
  const parts = [`Buy ${quantity(s.buy_quantity, per)}`];
  // Round 2: the free goods may be another item, counted in its own pack.
  if (num(s.free_quantity) > 0) {
    parts[0] += s.free_sku_id && s.free_label
      ? `, get ${quantity(s.free_quantity, s.free_unit_code || s.free_stock_unit || "")} of ${s.free_label} free`
      : `, get ${quantity(s.free_quantity)} free`;
  }
  if (num(s.discount_percent) > 0) parts.push(`${Number(s.discount_percent)}% off`);
  if (s.no_slab) parts.push("not with slab prices");
  return parts.join(" · ");
}

function Schemes({ edit }) {
  const biz = useOpenBusiness();
  const confirm = useConfirm();
  const [state, setState] = useState("current");
  const list = useServerList("schemes", { gridId: "wholesale-schemes", params: state !== "all" ? { state } : {} });
  const { reload } = list;
  const { options, error } = useOptions([GROUPS, ITEMS]);
  const groups = useMemo(() => options?.[GROUPS] || [], [options]);
  const items = useMemo(() => options?.[ITEMS] || [], [options]);
  const [adding, setAdding] = useState(false);

  const columns = useMemo(() => {
    const today = businessToday(biz.business.timezone);
    async function change(s, body, done) {
      try {
        await businessWrite(biz.id, `schemes/${s.id}`, body, "patch");
        toast.success(done);
        reload();
      } catch (err) {
        toast.error(getErrorMessage(err));
      }
    }
    async function endToday(s) {
      if (!(await confirm({ title: `End ${s.name} today?`, message: "Orders taken after today no longer get this scheme. Orders already taken keep it.", confirmLabel: "End today" }))) return;
      change(s, { validTo: today }, `${s.name} ends today`);
    }
    return [
      { key: "name", header: "Scheme", value: (s) => s.name, mobile: "title", pin: true },
      { key: "item", header: "Item", value: (s) => s.label, mobile: "subtitle",
        render: (s) => <span className="bz-two-line"><span>{s.label}</span>{s.sku_code && <small className="muted">{s.sku_code}</small>}</span> },
      { key: "offer", header: "Offer", value: offerText, mobile: "show" },
      { key: "for", header: "For", value: (s) => s.group_name || "Everyone" },
      { key: "valid", header: "Valid", type: "date", value: (s) => s.valid_from,
        render: (s) => `${dateShort(s.valid_from)} – ${s.valid_to ? dateShort(s.valid_to) : "open"}`, mobile: "show" },
      { key: "used", header: "Used", type: "number", value: (s) => Number(s.times_used || 0), total: "sum" },
      { key: "state", header: "State", type: "status", value: (s) => s.state, render: (s) => <StateBadge state={s.state} />, mobile: "show" },
      edit && { key: "actions", header: "", label: "Actions", type: "actions", render: (s) => (
        <div className="row-actions">
          <button type="button" className="chip-button" onClick={() => change(s, { active: !s.active }, `${s.name} ${s.active ? "switched off" : "switched on"}`)}>{s.active ? "Switch off" : "Switch on"}</button>
          {s.active && (s.state === "current" || s.state === "upcoming") && (!s.valid_to || s.valid_to > today) && (
            <button type="button" className="chip-button" onClick={() => endToday(s)}>End today</button>
          )}
        </div>
      ) },
    ].filter(Boolean);
  }, [edit, biz, confirm, reload]);

  return (
    <>
      <ErrorMessage message={list.error || error} />
      <SectionCard flush icon="gift" title="Schemes"
        actions={edit && <button type="button" className="button button-sm" disabled={!items.length} onClick={() => setAdding(true)}><Icon name="plus" size={15} /> Add a scheme</button>}>
        <DataGrid {...list.gridProps} caption="Schemes" columns={columns} rowNoun={["scheme", "schemes"]}
          toolbar={<Segmented label="Schemes" value={state} options={SCHEME_STATES} onChange={setState} />}
          exportName={biz.can("wholesale.export") ? `${biz.business.code}-schemes` : undefined}
          rowClassName={(s) => (s.state === "ended" || s.state === "off" ? "dg-tone-muted" : "")}
          empty="No schemes here" emptyHint="For example: buy 10 cases, get 1 free, for this month." emptyIcon="gift" />
      </SectionCard>
      {adding && <SchemeDialog groups={groups} items={items} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); list.reload(); }} />}
    </>
  );
}

function SchemeDialog({ groups, items, onClose, onSaved }) {
  const biz = useOpenBusiness();
  const [form, setForm] = useState(() => ({
    name: "", unitCode: "", buyQuantity: "", freeQuantity: "", discountPercent: "", groupId: "",
    validFrom: businessToday(biz.business.timezone), validTo: "", freeUnitCode: "", noSlab: false,
  }));
  const [item, setItem] = useState(null);
  // Round 2: "buy 5 cases of A, get 1 of B" — the free goods may be another item.
  const [freeItem, setFreeItem] = useState(null);
  const set = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));
  const choices = perChoices(item);
  const freeChoices = perChoices(freeItem);
  const per = form.unitCode || item?.unit || "";
  const freePer = freeItem && freeItem.id !== item?.id ? form.freeUnitCode || freeItem.unit : per;
  const submit = () => {
    if (!item) return Promise.reject(refuse("Choose the item."));
    if (!(num(form.freeQuantity) > 0) && !(num(form.discountPercent) > 0)) return Promise.reject(refuse("Give free goods, a discount, or both."));
    return businessWrite(biz.id, "schemes", {
      name: form.name, skuId: item.id, unitCode: form.unitCode, buyQuantity: form.buyQuantity,
      ...(num(form.freeQuantity) > 0 ? { freeQuantity: form.freeQuantity } : {}),
      ...(num(form.discountPercent) > 0 ? { discountPercent: form.discountPercent } : {}),
      ...(form.groupId ? { groupId: form.groupId } : {}),
      ...(freeItem && freeItem.id !== item.id ? { freeSkuId: freeItem.id, ...(form.freeUnitCode ? { freeUnitCode: form.freeUnitCode } : {}) } : {}),
      noSlab: form.noSlab,
      validFrom: form.validFrom || undefined, validTo: form.validTo || undefined,
    });
  };
  return (
    <FormDialog title="Add a scheme" icon="gift" width={620} submitLabel="Save scheme"
      description="Free goods or a discount on an item for a period. Orders taken in that period get it by themselves."
      successMessage={(s) => `${s?.name || form.name} saved`} onSubmit={submit} onClose={onClose} onSaved={onSaved}>
      <Field label="Scheme name" wide>
        <input required maxLength={150} placeholder="Diwali 10+1" value={form.name} onChange={set("name")} />
      </Field>
      <div className="field-wide">
        <SearchPicker label="Item" required value={item} options={items}
          onChange={(next) => { setItem(next); setForm((f) => ({ ...f, unitCode: "" })); }}
          getKey={(i) => i.id} getLabel={(i) => i.label} getDescription={(i) => i.code || ""}
          getKeywords={(i) => i.code || ""} placeholder="Item name or code" />
      </div>
      <Field label="Counted in">
        <select value={form.unitCode} onChange={set("unitCode")} disabled={!item}>
          {(choices.length ? choices : [{ value: "", label: "Choose the item first" }]).map((c) => <option key={c.value || "base"} value={c.value}>{c.label.replace(/^Per /, "")}</option>)}
        </select>
      </Field>
      <Field label={`Buy at least${per ? ` (${per})` : ""}`}>
        <input type="number" min="0.001" step="any" required value={form.buyQuantity} onChange={set("buyQuantity")} />
      </Field>
      <div className="field-wide">
        <SearchPicker label="Free item (optional)" hint="Leave empty for the same item free. Pick another for “buy 5 cases of A, get 1 of B”."
          value={freeItem} options={items} onChange={(next) => { setFreeItem(next); setForm((f) => ({ ...f, freeUnitCode: "" })); }}
          getKey={(i) => i.id} getLabel={(i) => i.label} getDescription={(i) => i.code || ""} getKeywords={(i) => i.code || ""} placeholder="Same item" />
      </div>
      {freeItem && freeItem.id !== item?.id && (
        <Field label="Free goods counted in">
          <select value={form.freeUnitCode} onChange={set("freeUnitCode")}>
            {freeChoices.map((c) => <option key={c.value || "base"} value={c.value}>{c.label.replace(/^Per /, "")}</option>)}
          </select>
        </Field>
      )}
      <Field label={`Free (optional)${freePer ? ` (${freePer})` : ""}`}>
        <input type="number" min="0" step="any" value={form.freeQuantity} onChange={set("freeQuantity")} />
      </Field>
      <Field label="Discount % (optional)">
        <input type="number" min="0" max="100" step="0.01" value={form.discountPercent} onChange={set("discountPercent")} />
      </Field>
      <Field label="For">
        <select value={form.groupId} onChange={set("groupId")}>
          <option value="">Everyone</option>
          {groups.map((g) => <option key={g.id} value={String(g.id)}>{g.name}</option>)}
        </select>
      </Field>
      <Field label="Valid from">
        <input type="date" required value={form.validFrom} onChange={set("validFrom")} />
      </Field>
      <Field label="Valid to (optional)" hint="Leave empty to keep it running">
        <input type="date" min={form.validFrom || undefined} value={form.validTo} onChange={set("validTo")} />
      </Field>
      <label className="checkbox bz-check field-wide">
        <input type="checkbox" checked={form.noSlab} onChange={(e) => setForm((f) => ({ ...f, noSlab: e.target.checked }))} />
        Don't combine with slab prices — when this scheme applies, the line is priced without quantity slabs (customer price, group price or list price)
      </label>
    </FormDialog>
  );
}
