import api from "../../../../services/api";
import { keepStorage, store } from "../../../../services/offline/idb";
import { TILLS_KEY } from "../../../../services/offline/offlineScreens";

// This device as an offline till (docs/ARCHITECTURE.md › How an offline bill
// is posted). The device's record, not a person's, so signing out keeps it:
//   { businessId, deviceId, code, name, locationId, locationName, token,
//     registeredAt, clockOffset, lastContactAt, numbers: { [year]: last } }
// `token` is the till's secret, sent with everything it sends; `numbers` the
// last number it took in each financial year's series; `lastContactAt` when
// it last reached the server (how long it has been offline is from then);
// `clockOffset` the difference between the server's clock and the device's.
// A mirror without the secret (localStorage) tells the offline boot which
// counter opens on this device (services/offline/offlineScreens.js).

const tills = () => store("tills");
const keyOf = (businessId) => `till:${businessId}`;

async function refreshMirror() {
  const rows = (await tills().all()).filter((row) => String(row.key).startsWith("till:"));
  try {
    localStorage.setItem(TILLS_KEY, JSON.stringify(rows.map((row) => ({ businessId: row.businessId, code: row.code, name: row.name }))));
  } catch {
    // Storage blocked: the counter still opens online.
  }
}

export const readTill = async (businessId) => (await tills().get(keyOf(businessId))) || null;

export async function saveTill(record) {
  const kept = await tills().put({ ...record, key: keyOf(record.businessId) });
  if (kept) keepStorage();
  await refreshMirror();
  return kept;
}

export async function forgetTill(businessId) {
  await tills().delete(keyOf(businessId));
  await refreshMirror();
}

// The moment on the till: the device's clock set by the server's.
export const tillNow = (till) => Date.now() + Number(till?.clockOffset || 0);

// The next number of the till's series for a financial year, taken once
// across every tab of this browser (Web Locks): { year, seq }. Kept before
// the bill is printed, so a number is never handed out twice.
export async function takeNumber(businessId, year) {
  const work = async () => {
    const till = await readTill(businessId);
    if (!till) throw new Error("This computer is no longer set up as an offline till.");
    const seq = Number(till.numbers?.[year] || 0) + 1;
    const kept = await tills().put({ ...till, numbers: { ...(till.numbers || {}), [year]: seq }, key: keyOf(businessId) });
    if (!kept) throw new Error("This browser did not keep the bill's number (storage is full or switched off). Bill online, or free some space.");
    return { year, seq };
  };
  return typeof navigator !== "undefined" && navigator.locks?.request ? navigator.locks.request(`bmp-till-${businessId}`, work) : work();
}

// --- The server --------------------------------------------------------------------------

const headers = (token) => ({ "X-Till-Token": token });
const data = (response) => response.data.data;

export const registerTill = (businessId, body) => api.post(`/businesses/${businessId}/till/devices`, body).then(data);
export const fetchSnapshot = (businessId, token, params) =>
  api.get(`/businesses/${businessId}/till/snapshot`, { params, headers: headers(token), background: true }).then(data);
export const sendHeartbeat = (businessId, token, body) =>
  api.post(`/businesses/${businessId}/till/heartbeat`, body, { headers: headers(token), background: true }).then(data);
export const tillHeaders = headers;
