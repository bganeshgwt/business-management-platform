import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import useAuth from "../../hooks/useAuth";
import useOnline from "../../hooks/useOnline";
import useOutbox from "../../hooks/useOutbox";
import useLiveRefresh from "../../hooks/useLiveRefresh";
import { businessRead } from "../../services/business.service";
import { getErrorMessage } from "../../services/api";
import { outbox, onSent } from "../../services/offline/outboxStore";
import { readSnapshot, saveSnapshot } from "../../services/offline/snapshots";
import { useOpenBusiness, newKey, businessToday } from "../../modules/business/core/pages/hooks";
import { journalStore, keepRecent, serverKeys, statusOf, visitsOfDay } from "./salesJournal";
import { beatsFor, isoWeekday, shopRefOf, shopSince, shopsInOrder } from "./salesRules";
import { pricingIndex } from "./salesPricing";
import { rememberSalesBusiness } from "./salesDevice";

// The salesperson app's day, read once by its layout and shared by its
// screens (salesContext.js):
//
//   - what the phone keeps to work with no network: the day's pack (beats,
//     shops in visit order with what each owes and its hold, the catalogue
//     with this salesperson's prices and the schemes; GET /sales/pack) and
//     the office's copy of the day (GET /sales/day), each saved on the device
//     with when it was read, and read again when the network is back and they
//     are old or of another day;
//   - the journal of what this phone did (salesJournal.js), each write put in
//     the outbox (services/offline) to go in order with its request key: the
//     day's start and end, a check-in, an order, a collection, a check-out, a
//     new shop. A write about a new shop not yet sent waits for it (the
//     outbox's `after`) and takes its id from the answer (`resultRef`);
//   - live: a change at the office (an order arrived, a refused one let
//     through) reads the day again.
//
// The office (salesperson_app.view) may open any salesperson's day
// (?salesperson=<id>): read only, never kept on the device.

const PACK_FRESH_MS = 15 * 60000;
// The salesperson app's own rows (days, visits, refused orders), and the
// orders and receipts the shared core announces.
const AREAS = ["field_sales", "sales_order", "collection"];

export default function useSalesDay() {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const { online } = useOnline();
  const box = useOutbox();
  const [params] = useSearchParams();
  const businessId = biz.id;
  const watching = /^\d{1,18}$/.test(params.get("salesperson") || "") ? Number(params.get("salesperson")) : null;
  const today = businessToday(biz.business.timezone);
  const weekday = isoWeekday(today);
  const store = useMemo(() => journalStore(user.id, businessId), [user.id, businessId]);
  const packKey = `sales-pack:${businessId}`;
  const dayKey = `sales-day:${businessId}`;
  const queue = `sales:${businessId}`;

  const [me, setMe] = useState(null);
  const [pack, setPack] = useState(null);
  const [day, setDay] = useState(null);
  const [entries, setEntries] = useState([]);
  const [local, setLocal] = useState(false);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const busy = useRef(false);

  // What the phone kept, first: it opens with no network.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [kept, keptDay, journal] = await Promise.all([readSnapshot(packKey, user.id), readSnapshot(dayKey, user.id), store.load()]);
      if (!alive) return;
      if (!watching && kept) {
        setPack({ ...kept.data, savedAt: kept.savedAt });
        if (kept.data.me) setMe(kept.data.me);
      }
      if (!watching && keptDay) setDay({ ...keptDay.data, readAt: keptDay.savedAt });
      setEntries(journal);
      setLocal(true);
    })();
    return () => {
      alive = false;
    };
  }, [packKey, dayKey, user.id, store, watching]);

  const reloadEntries = useCallback(async () => setEntries(await store.load()), [store]);

  // The office's copy of the day.
  const readDay = useCallback(async () => {
    const answer = await businessRead(businessId, "sales/day", watching ? { salesperson: watching } : undefined);
    setDay({ ...answer, readAt: Date.now() });
    if (!watching) saveSnapshot(dayKey, user.id, answer);
    return answer;
  }, [businessId, watching, dayKey, user.id]);

  // Who this is, the day's pack and the office's copy of the day.
  const refresh = useCallback(async ({ force = false } = {}) => {
    if (busy.current) return;
    busy.current = true;
    setRefreshing(true);
    try {
      const who = await businessRead(businessId, "sales/me");
      setMe(who);
      setError("");
      if (!watching && !who.salesperson) return;
      rememberSalesBusiness(user.id, businessId);
      const kept = watching ? null : await readSnapshot(packKey, user.id);
      const stale = !kept || force || kept.data.today !== who.today || Date.now() - kept.savedAt > PACK_FRESH_MS
        || Number(kept.data.salesperson?.id) !== Number(who.salesperson?.id);
      if (watching || stale) {
        const fresh = await businessRead(businessId, "sales/pack", watching ? { salesperson: watching } : undefined);
        if (watching) setPack({ ...fresh, savedAt: Date.now() });
        else {
          const extra = kept?.data?.extra || [];
          await saveSnapshot(packKey, user.id, { ...fresh, me: who, extra });
          setPack({ ...fresh, me: who, extra, savedAt: Date.now() });
        }
      }
      await readDay();
    } catch (err) {
      // No answer: the phone's copies stand in. A refusal is said.
      if (err?.response) setError(getErrorMessage(err));
    } finally {
      busy.current = false;
      setRefreshing(false);
    }
  }, [businessId, watching, packKey, user.id, readDay]);

  // Read again as the network comes (and as the app opens online).
  useEffect(() => {
    if (!online) return undefined;
    const soon = setTimeout(() => refresh(), 0);
    return () => clearTimeout(soon);
  }, [online, refresh]);

  // Only for a day there is to read: their own, or the one the office opened.
  const live = useLiveRefresh({ business: businessId }, AREAS, () => readDay().catch(() => {}), { enabled: online && Boolean(watching || me?.salesperson) });

  // An item of this app's sent: keep the office's answer (a number, a total).
  useEffect(() => onSent(async (item) => {
    if (item.queue !== queue) return;
    await store.update((list) => list.map((e) => (e.outboxId === item.id ? { ...e, result: item.result?.data ?? null, sentAt: Date.now() } : e)));
    reloadEntries();
  }), [queue, store, reloadEntries]);

  // Whenever the waiting list changes (another tab sent something), the journal is read again.
  const waitingCount = box.counts.total;
  useEffect(() => {
    const soon = setTimeout(() => reloadEntries(), 0);
    return () => clearTimeout(soon);
  }, [waitingCount, reloadEntries]);

  // A week of the journal is kept; what still waits to go stays however old.
  useEffect(() => {
    if (!local) return;
    const waiting = new Set(box.items.map((i) => i.id));
    store.update((list) => keepRecent(list, today, waiting)).then(setEntries).catch(() => {});
  }, [local, today]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- What the screens show ---------------------------------------------------------------
  const items = useMemo(() => new Map(box.items.map((item) => [item.id, item])), [box.items]);
  const known = useMemo(() => serverKeys(day), [day]);
  const status = useCallback((entry) => statusOf(entry, items, known, day?.readAt || 0), [items, known, day]);
  const mine = useMemo(() => (watching ? [] : entries), [watching, entries]);
  const todays = useMemo(() => mine.filter((e) => e.date === today), [mine, today]);

  // Shops: the pack's, those looked up off the beat, and those added on this phone not yet in the pack.
  const shops = useMemo(() => {
    const list = [...(pack?.shops || [])];
    for (const extra of pack?.extra || []) if (!list.some((s) => s.id === extra.shop.id)) list.push({ ...extra.shop, offList: true });
    for (const entry of mine.filter((e) => e.kind === "shop")) {
      const server = entry.result?.id || null;
      if (list.some((s) => s.field_key === entry.id || (server && s.id === server))) continue;
      list.push({ id: server, newShopKey: entry.id, name: entry.data.name, phone: entry.data.phone || null, address: entry.data.address, gstin: entry.data.gstin || null,
        contact_person: entry.data.contactPerson || null, beat_id: entry.data.beatId || null, visit_order: null, approval: "pending", balance: "0", overdue: "0",
        pending_orders: "0", open_orders: 0, cash_today: "0", credit_limit: null, hold: { held: false }, open_bills: [], last_order: null, bills_consent: Boolean(entry.data.consents?.bills_digital),
        place: entry.data.place || null, local: true });
    }
    return list.map((s) => ({ ...s, ref: shopRefOf(s.id ? s : { newShopKey: s.newShopKey }), refs: [s.id ? `c${s.id}` : null, s.field_key ? `n${s.field_key}` : null, s.newShopKey ? `n${s.newShopKey}` : null].filter(Boolean) }));
  }, [pack, mine]);

  const shopByRef = useCallback((ref) => shops.find((s) => s.refs.includes(ref)) || null, [shops]);
  const beats = useMemo(() => beatsFor(pack, weekday), [pack, weekday]);
  const planned = useMemo(() => shopsInOrder(shops, beats.today), [shops, beats]);
  const visits = useMemo(() => visitsOfDay(mine, day, today), [mine, day, today]);
  const index = useMemo(() => pricingIndex(pack, (pack?.extra || []).map((x) => x)), [pack]);

  // What the phone did for a shop that the pack's figures do not hold yet:
  // still on its way (waiting or sending, not refused), or sent after the pack
  // was read. `cash` is today's cash only (the ₹2,00,000 rule is per day).
  const sinceFor = useCallback((shop) => {
    const savedAt = pack?.savedAt || 0;
    const counted = mine.filter((e) => {
      const item = items.get(e.outboxId);
      return item ? item.state !== "attention" : Boolean(e.sentAt && e.sentAt > savedAt);
    });
    const total = { collected: 0, cash: 0, ordered: 0, orders: 0 };
    for (const ref of shop.refs) {
      const part = shopSince(counted, ref);
      const cash = shopSince(counted.filter((e) => e.date === today), ref).cash;
      total.collected += part.collected;
      total.ordered += part.ordered;
      total.orders += part.orders;
      total.cash += cash;
    }
    return total;
  }, [pack, mine, items, today]);

  // The day as the phone knows it: started (on this phone or the office's copy) and ended.
  const startEntry = todays.find((e) => e.kind === "start");
  const endEntry = todays.find((e) => e.kind === "end");
  const serverDayRow = day?.date === today ? day.day : null;
  const started = Boolean(startEntry || serverDayRow);
  const ended = Boolean(endEntry || serverDayRow?.ended_at);
  const startedAt = startEntry?.at || serverDayRow?.started_at || null;
  const endedAt = endEntry?.at || serverDayRow?.ended_at || null;

  // --- Writes ---------------------------------------------------------------------------------
  // Each goes to the journal first (so nothing is lost), then to the outbox.
  const pendingOf = (entry) => (entry && items.has(entry.outboxId) ? items.get(entry.outboxId) : null);
  const shopEntryOf = (ref) => (ref?.startsWith("n") ? mine.find((e) => e.kind === "shop" && `n${e.id}` === ref) : null);

  const record = useCallback(async ({ kind, url, body, label, shopRef = null, visitKey = null, data = {}, after = null, resultRef = null }) => {
    const outboxId = newKey();
    const entry = { id: body.requestKey, kind, date: today, at: new Date().toISOString(), shopRef, visitKey, outboxId, data, offline: !online };
    await store.update((list) => [...list, entry]);
    try {
      await outbox.add({ id: outboxId, queue, kind: `sales_${kind}`, label, method: "POST", url: `/businesses/${businessId}/${url}`, body, requestKey: body.requestKey, after, resultRef });
    } catch (err) {
      await store.update((list) => list.filter((e) => e.id !== entry.id));
      throw err;
    }
    await reloadEntries();
    return entry;
  }, [today, online, store, queue, businessId, reloadEntries]);

  // A write about a shop: by its id, or a new shop by its request key (waiting for it while it waits).
  const shopTarget = useCallback((shop) => {
    if (shop.id) return { body: { contactId: shop.id }, after: null, resultRef: null };
    const shopEntry = shopEntryOf(shop.ref);
    const waiting = pendingOf(shopEntry);
    return { body: { newShopKey: shop.newShopKey }, after: waiting ? waiting.id : null, resultRef: waiting ? { from: "data.id", into: "contactId" } : null };
  }, [mine, items]); // eslint-disable-line react-hooks/exhaustive-deps

  const actions = useMemo(() => {
    if (watching || !me?.can_work) return null;
    const name = (shop) => shop.name;
    return {
      startDay: ({ place }) => {
        const body = { requestKey: newKey(), startedAt: new Date().toISOString(), ...(place ? { place } : {}), offline: !online };
        return record({ kind: "start", url: "sales/days/start", body, label: `Day started ${new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}`, data: { place: Boolean(place) } });
      },
      endDay: ({ place, cashInHand, note }) => {
        const body = { requestKey: newKey(), endedAt: new Date().toISOString(), ...(place ? { place } : {}), cashInHand, ...(note ? { note } : {}), offline: !online };
        const waiting = pendingOf(startEntry);
        return record({ kind: "end", url: "sales/days/end", body, after: waiting?.id || null, label: `Day ended ${new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}`,
          data: { cashInHand, place: Boolean(place) } });
      },
      checkIn: (shop, { place, distance, far, farReason, offBeat, offBeatReason, savePlace }) => {
        const target = shopTarget(shop);
        const body = { requestKey: newKey(), ...target.body, checkedInAt: new Date().toISOString(), ...(place ? { place } : {}), ...(far && farReason ? { farReason } : {}),
          ...(offBeat && offBeatReason ? { offBeatReason } : {}), ...(savePlace ? { savePlace: true } : {}), offline: !online };
        return record({ kind: "visit", url: "sales/visits", body, label: `Check-in at ${name(shop)}`, shopRef: shop.ref, after: target.after, resultRef: target.resultRef,
          data: { shopName: shop.name, contactId: shop.id || null, distance, far, farReason: far ? farReason : null, offBeat, offBeatReason: offBeat ? offBeatReason : null, place: Boolean(place) } });
      },
      checkOut: (shop, visit, { outcome, noOrderReason, note, promisedOn, promisedAmount }) => {
        const body = { requestKey: newKey(), checkedOutAt: new Date().toISOString(), outcome, ...(noOrderReason ? { noOrderReason } : {}), ...(note ? { note } : {}),
          ...(promisedOn ? { promisedOn } : {}), ...(promisedAmount ? { promisedAmount } : {}), offline: !online };
        const waiting = pendingOf(visit.entry);
        return record({ kind: "checkout", url: `sales/visits/${visit.key}/check-out`, body, visitKey: visit.key, shopRef: shop.ref, after: waiting?.id || null,
          label: `Check-out at ${name(shop)}${outcome === "no_order" ? " (no order)" : ""}`, data: { outcome, noOrderReason, note, promisedOn, promisedAmount } });
      },
      placeOrder: (shop, visit, { lines, phoneTotal, depotId, notes, summary }) => {
        const target = shopTarget(shop);
        const body = { requestKey: newKey(), ...target.body, ...(visit ? { visitKey: visit.key } : {}), locationId: depotId, lines, phoneTotal, takenAt: new Date().toISOString(),
          ...(notes ? { notes } : {}), offline: !online };
        return record({ kind: "order", url: "sales/orders", body, label: `Order for ${name(shop)} · ₹${Number(phoneTotal).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
          shopRef: shop.ref, visitKey: visit?.key || null, after: target.after, resultRef: target.resultRef, data: { shopName: shop.name, phoneTotal, lines: summary } });
      },
      collect: (shop, visit, { amount, method, reference, chequeDate, bank, allocations, depotId }) => {
        const target = shopTarget(shop);
        const body = { requestKey: newKey(), ...target.body, ...(visit ? { visitKey: visit.key } : {}), locationId: depotId, amount, method, ...(reference ? { reference } : {}),
          ...(method === "cheque" ? { chequeDate, bank } : {}), ...(allocations ? { allocations } : {}), takenAt: new Date().toISOString(), offline: !online };
        const word = method === "cash" ? "Cash" : method === "upi" ? "UPI" : "Cheque";
        return record({ kind: "collection", url: "sales/collections", body, label: `${word} ₹${Number(amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })} from ${name(shop)}`,
          shopRef: shop.ref, visitKey: visit?.key || null, after: target.after, resultRef: target.resultRef,
          data: { shopName: shop.name, amount, method, reference, chequeDate, bank } });
      },
      addShop: (form) => {
        const body = { requestKey: newKey(), ...form, takenAt: new Date().toISOString(), offline: !online };
        return record({ kind: "shop", url: "sales/shops", body, label: `New shop: ${form.name}`, shopRef: `n${body.requestKey}`, data: form });
      },
      retry: (entry) => outbox.retry(entry.outboxId),
      discard: (entry) => outbox.discard(entry.outboxId),
      // A customer looked up off the beat, kept with the pack so it works offline from now on.
      keepShop: async (found) => {
        const kept = await readSnapshot(packKey, user.id);
        if (!kept) return;
        const extra = [...(kept.data.extra || []).filter((x) => x.shop.id !== found.shop.id), found];
        await saveSnapshot(packKey, user.id, { ...kept.data, extra });
        setPack((p) => (p ? { ...p, extra } : p));
      },
    };
  }, [watching, me, online, record, shopTarget, startEntry, items, packKey, user.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const fromCopy = !online && pack ? pack.savedAt : null;
  const loading = !local || (!pack && !error && online && (refreshing || !me));

  return {
    biz, businessId, today, weekday, me, pack, day, entries: mine, todays, shops, shopByRef, beats, planned, visits, index, sinceFor, status,
    started, ended, startedAt, endedAt, actions, watching, online, live, refreshing, error, loading, fromCopy,
    refresh: () => refresh({ force: true }), readDay, settings: pack?.settings || me?.settings || null,
    waiting: box.counts, packIsToday: pack?.today === today,
  };
}
