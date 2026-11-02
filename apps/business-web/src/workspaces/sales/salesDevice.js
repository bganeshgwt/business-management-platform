// Who has used the salesperson app on this device, and in which business.
// With no network the app opens for a person who opened it here before, at
// the business they used it in last (services/offline/offlineScreens.js): it
// works from what it kept on the device, which only they had read. A small
// note in the browser's storage, by person; nothing in it is private.

const KEY = "bmp_sales_device";

const storageOf = (storage) => {
  if (storage !== undefined) return storage;
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

const read = (storage) => {
  try {
    const value = JSON.parse(storageOf(storage)?.getItem(KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
};

// The business this person last used the app in on this device, or null.
export const salesBusinessOnDevice = (userId, storage) => {
  if (!userId) return null;
  const id = read(storage)[String(userId)];
  return /^\d{1,18}$/.test(String(id)) ? Number(id) : null;
};

export const rememberSalesBusiness = (userId, businessId, storage) => {
  if (!userId || !/^\d{1,18}$/.test(String(businessId))) return;
  try {
    const all = read(storage);
    all[String(userId)] = Number(businessId);
    storageOf(storage)?.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage blocked: the app opens online as usual.
  }
};
