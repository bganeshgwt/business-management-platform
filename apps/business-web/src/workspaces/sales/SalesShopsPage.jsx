import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { EmptyState, ErrorMessage } from "../../components/Feedback";
import { businessRead } from "../../services/business.service";
import { getErrorMessage } from "../../services/api";
import { useSales } from "./salesContext";
import { DAY_NAMES, shopsInOrder } from "./salesRules";
import { ShopCard } from "./salesParts";
import { money } from "./salesFormat";

// Shops: today's beat in visit order, every shop on the salesperson's beats
// (and those they added), a search of their own shops that works offline, and
// a search of every customer of the business for a visit off the beat
// (online). "Add a new shop" for a shop not yet a customer.
const VIEWS = [
  { value: "today", label: "Today's beat" },
  { value: "mine", label: "All my shops" },
  { value: "find", label: "Find any shop" },
];

export default function SalesShopsPage() {
  const sales = useSales();
  const navigate = useNavigate();
  const [view, setView] = useState(sales.planned.length ? "today" : "mine");
  const [query, setQuery] = useState("");
  const base = `/sales/${sales.businessId}`;
  const keep = sales.watching ? `?salesperson=${sales.watching}` : "";
  const words = query.trim().toLowerCase();
  const digits = query.replace(/\D/g, "");
  const matches = (shop) => !words || [shop.name, shop.address, shop.gstin, shop.contact_person].some((t) => String(t || "").toLowerCase().includes(words))
    || (digits.length >= 4 && String(shop.phone || "").replace(/\D/g, "").includes(digits));
  const visitOf = (shop) => sales.visits.find((v) => shop.refs.includes(v.shopRef));

  // Every shop of theirs: beat by beat in visit order, then the rest by name.
  const allMine = useMemo(() => {
    const onBeats = shopsInOrder(sales.shops, sales.pack?.beats || []);
    const rest = sales.shops.filter((s) => !onBeats.includes(s)).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return [...onBeats, ...rest];
  }, [sales.shops, sales.pack]);
  const list = (view === "today" ? sales.planned : allMine).filter(matches);
  const beatOf = (shop) => (sales.pack?.beats || []).find((b) => Number(b.id) === Number(shop.beat_id));

  return (
    <div className="sl-page">
      <div className="sl-page-head">
        <h1 className="sl-title">Shops</h1>
        {sales.actions && <Link className="button button-sm" to={`${base}/shops/new`}><Icon name="plus" size={15} /> Add a new shop</Link>}
      </div>
      <div className="segmented sl-segmented" role="radiogroup" aria-label="Show">
        {VIEWS.map((v) => (
          <button key={v.value} type="button" role="radio" aria-checked={view === v.value} className={`segment ${view === v.value ? "is-active" : ""}`} onClick={() => setView(v.value)}>{v.label}</button>
        ))}
      </div>
      {view === "find" ? (
        <FindAnyShop sales={sales} onOpen={(shopId) => navigate(`${base}/shops/c${shopId}${keep}`)} />
      ) : (
        <>
          <label className="sl-search">
            <Icon name="search" size={17} />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, mobile, address or GSTIN" aria-label="Search your shops" />
          </label>
          {list.length ? (
            <ul className="sl-list">
              {list.map((shop, i) => {
                const beat = beatOf(shop);
                const showBeat = view === "mine" && beat && (i === 0 || beatOf(list[i - 1])?.id !== beat.id);
                return (
                  <li key={shop.ref}>
                    {showBeat && <h2 className="sl-list-head">{beat.name}{beat.visit_day ? ` · ${DAY_NAMES[beat.visit_day - 1]}` : " · any day"}</h2>}
                    <ShopCard shop={shop} to={`${base}/shops/${shop.ref}${keep}`} position={view === "today" ? i + 1 : null} visit={visitOf(shop)} />
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState icon="store" message={words ? `No shop of yours matches "${query.trim()}"` : view === "today" ? "No shops planned for today" : "No shops on your beats yet"}
              hint={words ? "Find any shop searches every customer of the business (with the network)." : "The office puts shops on your beats under Routes & salespeople."} />
          )}
        </>
      )}
    </div>
  );
}

// Every customer of the business, for a visit off the beat: with the network only.
function FindAnyShop({ sales, onOpen }) {
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState({ query: "", rows: null });
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(null);
  const text = query.trim();
  // The answer shown is the one for what is typed now.
  const found = answer.query === text && text.length >= 2 ? answer.rows : null;
  useEffect(() => {
    if (text.length < 2 || !sales.online) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      businessRead(sales.businessId, "sales/customers", { q: text }, controller.signal)
        .then((rows) => { setAnswer({ query: text, rows }); setError(""); })
        .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, sales.online, sales.businessId]);
  const open = async (row) => {
    setOpening(row.id);
    try {
      // The shop's card and its own prices, kept on the phone for the visit.
      const card = await businessRead(sales.businessId, `sales/customers/${row.id}`);
      if (sales.actions) await sales.actions.keepShop(card);
      onOpen(row.id);
    } catch (err) {
      setError(getErrorMessage(err));
      setOpening(null);
    }
  };
  if (!sales.online) {
    return <EmptyState icon="alert" message="Finding any shop needs the network" hint="Your own shops are under Today's beat and All my shops, and work offline." />;
  }
  return (
    <>
      <label className="sl-search">
        <Icon name="search" size={17} />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Any customer: name, mobile, GSTIN or beat" aria-label="Find any shop" autoFocus />
      </label>
      <ErrorMessage message={error} />
      {found && (found.length ? (
        <ul className="sl-list">
          {found.map((row) => (
            <li key={row.id}>
              <button type="button" className="sl-shop" onClick={() => open(row)} disabled={opening === row.id}>
                <span className="sl-shop-mark" aria-hidden="true"><Icon name="store" size={15} /></span>
                <span className="sl-shop-body">
                  <span className="sl-shop-name">{row.name}</span>
                  <span className="sl-shop-meta">
                    {[row.beat_name ? `${row.beat_name}${row.salesperson_name ? ` (${row.salesperson_name})` : ""}` : "Not on a beat", row.address].filter(Boolean).join(" · ")}
                  </span>
                  {Number(row.balance) > 0 && <span className="sl-chips"><span className="sl-chip is-neutral">Owes {money(row.balance)}</span></span>}
                </span>
                <Icon name={opening === row.id ? "refresh" : "external"} size={15} className="sl-shop-go" />
              </button>
            </li>
          ))}
        </ul>
      ) : <EmptyState icon="search" message={`No customer matches "${query.trim()}"`} hint="A shop that is not a customer yet: Add a new shop." />)}
    </>
  );
}
