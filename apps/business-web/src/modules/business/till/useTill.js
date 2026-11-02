import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useAuth from "../../../hooks/useAuth";
import useOnline from "../../../hooks/useOnline";
import useOutbox from "../../../hooks/useOutbox";
import { outbox } from "../../../services/offline/outboxStore";
import { readSnapshot, saveSnapshot, dropSnapshot } from "../../../services/offline/snapshots";
import { getErrorMessage } from "../../../services/api";
import { mergeSnapshot, snapshotQuery } from "./tillSnapshot.js";
import { clockOffset, dayOf, fiscalYearOf, limitState } from "./tillRules.js";
import { billBody, billLabel, heartbeatOf, isTillItem, queueOf, receiptDoc, voidBody, voidLabel, voidable, waitingCopy, numberFor } from "./tillQueue.js";
import { fetchSnapshot, forgetTill, readTill, registerTill, saveTill, sendHeartbeat, takeNumber, tillHeaders, tillNow } from "./tillStore.js";

// The counter as an offline till (Quick bill, docs/ARCHITECTURE.md › How an
// offline bill is posted): this device's till record, the snapshot it keeps,
// its waiting bills and its limits, and what it does:
//   - online: reports to the server every minute (its waiting bills, the last
//     number it took; the answer sets its clock and its limits) and reads its
//     snapshot every five minutes, and on demand;
//   - offline: bills from the snapshot; each bill takes the till's next
//     number, is kept in the outbox (shared: the device's, sent by whoever is
//     signed in) before its receipt prints, and goes when the network is back.
const HEARTBEAT_MS = 60_000;
const SNAPSHOT_MS = 5 * 60_000;
const snapshotKey = (businessId) => `till:${businessId}`;

export default function useTill(biz) {
  const { user } = useAuth();
  const { online } = useOnline();
  const box = useOutbox();
  const businessId = biz.id;
  const [till, setTill] = useState(undefined);
  const [snapshot, setSnapshot] = useState(null);
  const [problem, setProblem] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const tillRef = useRef(null);
  tillRef.current = till;

  // This device's till and its snapshot, as kept.
  useEffect(() => {
    let live = true;
    setTill(undefined);
    setSnapshot(null);
    readTill(businessId).then((record) => {
      if (!live) return;
      setTill(record);
      if (record && user?.id) readSnapshot(snapshotKey(businessId), user.id).then((kept) => live && setSnapshot(kept?.data || null));
    });
    return () => { live = false; };
  }, [businessId, user?.id]);

  // The clock that drives the limits and the snapshot's age on screen.
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const items = useMemo(() => box.items.filter((item) => isTillItem(item, businessId)), [box.items, businessId]);
  const waiting = items.filter((item) => item.state !== "attention").length;
  const attention = items.filter((item) => item.state === "attention").length;

  const remember = useCallback(async (record) => {
    await saveTill(record);
    setTill(record);
    return record;
  }, []);

  // What the server says when this till is retired or unknown: it bills online only from now on.
  const refused = useCallback(async (err) => {
    const reason = err?.response?.data?.data?.reason;
    if (reason === "till_retired" || reason === "till_unknown") {
      setProblem({ reason, message: getErrorMessage(err) });
      return true;
    }
    if (err?.response?.status === 402) setProblem({ reason: "plan_ended", message: getErrorMessage(err) });
    return false;
  }, []);

  const heartbeat = useCallback(async () => {
    const record = tillRef.current;
    if (!record || !user?.id) return;
    const before = Date.now();
    const day = dayOf(tillNow(record), biz.business.timezone);
    const body = { ...heartbeatOf(outbox.snapshot().items, record, { day, startMonth: biz.settings.fiscal_year_start_month || 4 }),
      offlineSince: null, version: import.meta.env?.VITE_BUILD_ID || null };
    try {
      const answer = await sendHeartbeat(businessId, record.token, body);
      const offset = clockOffset(answer.serverTime, before, Date.now());
      // Never take a number the server already has (a till restored from an old copy).
      const numbers = { ...(record.numbers || {}) };
      for (const [year, seq] of Object.entries(answer.received || {})) numbers[year] = Math.max(Number(numbers[year] || 0), Number(seq));
      await remember({ ...record, name: answer.device.name, locationName: answer.device.locationName, clockOffset: offset, lastContactAt: Date.now() + offset,
        settings: answer.settings, numbers });
      setProblem((was) => (was?.reason === "plan_ended" ? null : was));
      // The plan renewed: what it refused goes again.
      for (const item of outbox.snapshot().items.filter((each) => isTillItem(each, businessId) && each.state === "attention" && each.status === 402)) outbox.retry(item.id);
    } catch (err) {
      await refused(err);
    }
  }, [biz.business.timezone, biz.settings.fiscal_year_start_month, businessId, refused, remember, user?.id]);

  const refresh = useCallback(async () => {
    const record = tillRef.current;
    if (!record || !user?.id) return null;
    setSyncing(true);
    try {
      const kept = (await readSnapshot(snapshotKey(businessId), user.id))?.data || null;
      const before = Date.now();
      const answer = await fetchSnapshot(businessId, record.token, snapshotQuery(kept));
      const merged = mergeSnapshot(kept, answer);
      await saveSnapshot(snapshotKey(businessId), user.id, merged);
      setSnapshot(merged);
      await remember({ ...record, clockOffset: clockOffset(answer.serverTime, before, Date.now()), lastContactAt: Date.parse(answer.serverTime), settings: answer.settings });
      setProblem(null);
      return merged;
    } catch (err) {
      await refused(err);
      return null;
    } finally {
      setSyncing(false);
    }
  }, [businessId, refused, remember, user?.id]);

  // Online, with the application on: report every minute, read the snapshot every five.
  const enabled = biz.has("offline_till");
  useEffect(() => {
    if (!till || !online || !enabled) return undefined;
    heartbeat();
    const stale = !snapshot || Date.now() - snapshot.savedAt > SNAPSHOT_MS;
    if (stale) refresh();
    const beat = setInterval(heartbeat, HEARTBEAT_MS);
    const read = setInterval(refresh, SNAPSHOT_MS);
    return () => { clearInterval(beat); clearInterval(read); };
    // snapshot is read only to decide the first refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [till?.token, online, enabled, heartbeat, refresh]);

  // "Set up offline billing on this computer".
  const register = useCallback(async ({ name, locationId }) => {
    const answer = await registerTill(businessId, { name, locationId });
    const record = { businessId, deviceId: answer.device.id, code: answer.device.code, name: answer.device.name, locationId: answer.device.location_id,
      locationName: answer.device.location_name, token: answer.token, registeredAt: answer.device.registered_at, clockOffset: 0, lastContactAt: Date.now(),
      settings: answer.settings, numbers: {} };
    if (!(await saveTill(record))) throw new Error("This browser cannot keep the till on this computer (a private window, or storage switched off). Use a normal window.");
    tillRef.current = record;
    setTill(record);
    setProblem(null);
    return record;
  }, [businessId]);

  // Forgets the till on this device (it was retired), once nothing waits on it.
  const forget = useCallback(async () => {
    if (items.length) throw new Error("Bills still wait on this till: download a copy of them first.");
    await forgetTill(businessId);
    if (user?.id) await dropSnapshot(snapshotKey(businessId), user.id);
    setTill(null);
    setSnapshot(null);
    setProblem(null);
  }, [businessId, items.length, user?.id]);

  const now = till ? tillNow(till) : clock;
  const settings = { ...(snapshot?.settings || {}), ...(till?.settings || {}) };
  const offlineSince = !online && till ? till.lastContactAt || null : null;
  const limit = limitState({ offlineSince, now, waiting: waiting + attention, warnHours: settings.warnHours ?? 12, stopHours: settings.stopHours ?? 72, cap: settings.waitingCap ?? 2000 });

  // A bill made offline: its number taken, kept in the outbox, its receipt ready to print.
  const saveBill = useCallback(async ({ priced, cart, payments, customer, buyer, discountReason }) => {
    const record = tillRef.current;
    if (!record || !snapshot) throw new Error("This computer is not ready to bill offline.");
    const madeAt = new Date(tillNow(record)).toISOString();
    const day = dayOf(madeAt, biz.business.timezone);
    const year = fiscalYearOf(day, snapshot.settings?.fiscalYearStartMonth || 4);
    const { seq } = await takeNumber(businessId, year);
    const number = numberFor(record, year, seq);
    const requestKey = crypto.randomUUID();
    const body = billBody({ priced, cart, payments, number, madeAt, madeBy: user.id, offlineSince: record.lastContactAt ? new Date(record.lastContactAt).toISOString() : null,
      pinRule: Boolean(snapshot.settings?.pinEveryBill), buyer, requestKey, locationId: record.locationId });
    const receipt = receiptDoc({ snapshot, priced, number, madeAt, customer, payments, buyer, discountReason });
    const item = await outbox.add({ queue: queueOf(businessId), kind: "till_bill", label: billLabel(number, priced.total, biz.symbol), method: "POST",
      url: `/businesses/${businessId}/till/bills`, body, requestKey, shared: true, headers: tillHeaders(record.token),
      meta: { businessId, number, year, seq, total: priced.total, madeAt, madeBy: user.id, madeByName: user.name, customer: customer ? { id: customer.id, name: customer.name } : null, receipt } });
    return { item, number, receipt };
  }, [biz.business.timezone, biz.symbol, businessId, snapshot, user]);

  // Voids a waiting bill with a reason: it goes as a void that keeps its number.
  const voidBill = useCallback(async (item, reason) => {
    const check = voidable(item);
    if (!check.ok) throw new Error(check.why);
    const requestKey = crypto.randomUUID();
    const amended = await outbox.amend(item.id, { kind: "till_void", label: voidLabel(item.meta.number), body: voidBody(item.body, reason, requestKey), requestKey,
      meta: { ...item.meta, voided: reason } });
    if (!amended) throw new Error(voidable(null).why);
    return amended;
  }, []);

  const download = useCallback(() => {
    const record = tillRef.current;
    if (!record) return;
    const copy = waitingCopy(outbox.snapshot().items, record);
    const blob = new Blob([JSON.stringify(copy, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `till-${record.code}-waiting-bills-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  const sendNow = useCallback(() => {
    for (const item of outbox.snapshot().items.filter((each) => isTillItem(each, businessId) && each.state === "attention" && each.status === 402)) outbox.retry(item.id);
    return outbox.flush();
  }, [businessId]);

  return {
    loading: till === undefined, till: till || null, snapshot, online, items, waiting, attention, limit, now, settings, problem, syncing,
    ready: Boolean(till && snapshot && !problem?.reason?.startsWith("till_")),
    register, refresh, heartbeat, saveBill, voidBill, download, sendNow, forget,
  };
}
