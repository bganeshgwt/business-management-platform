import api from "../../../services/api";
import { businessRead, businessWrite } from "../../../services/business.service";

// Personal data through either front door of one API (backend
// modules/personal-data): a shop's customers under
// /api/businesses/:id/privacy, a restaurant's guests under /api/privacy. The
// screens take one of these and work the same way. Each is made once per
// business, so it is the same object on every render.

const made = new Map();
const once = (key, make) => {
  if (!made.has(key)) made.set(key, { key, ...calls(make()) });
  return made.get(key);
};

// The calls, given the door's get/post/patch/remove.
function calls(door) {
  const { get, post, patch, remove } = door;
  return {
    kind: door.kind,
    person: door.person,
    // The notice in force (any member), its versions, and a new version.
    notice: (signal) => get("notice", undefined, signal),
    notices: (signal) => get("notices", undefined, signal),
    publish: (body) => post("notices", body),
    // Consents: several people's at once, one person's history, given, withdrawn.
    lookup: (ids, signal) => get("consents", { people: ids.join(",") }, signal),
    personView: (id, signal) => get(`people/${id}`, undefined, signal),
    give: (id, body) => post(`people/${id}/consents`, body),
    withdraw: (consentId, body) => post(`consents/${consentId}/withdraw`, body || {}),
    markChild: (id, body) => post(`people/${id}/child`, body),
    endChild: (childId, body) => post(`children/${childId}/end`, body),
    search: (q, signal) => get("people", { q }, signal),
    everyone: (params, signal) => get("everyone", params, signal),
    // One person's data: seen on screen, or exported as a file.
    data: (id, requestId, signal) => get(`people/${id}/data`, requestId ? { requestId } : undefined, signal),
    exportData: (id, requestId) => get(`people/${id}/export`, requestId ? { requestId } : undefined),
    // The requests register.
    list: (kind, params, signal) => get(kind, params, signal),
    logRequest: (body) => post("requests", body),
    request: (id, signal) => get(`requests/${id}`, undefined, signal),
    linkRequest: (id, personId) => post(`requests/${id}/person`, { personId }),
    closeRequest: (id, body) => post(`requests/${id}/close`, body),
    erase: (id, body) => post(`requests/${id}/erase`, body),
    // The breach register.
    recordBreach: (body) => post("breaches", body),
    breach: (id, signal) => get(`breaches/${id}`, undefined, signal),
    updateBreach: (id, body) => patch(`breaches/${id}`, body),
    addPeople: (id, personIds) => post(`breaches/${id}/people`, { personIds }),
    removePerson: (id, personId) => remove(`breaches/${id}/people/${personId}`),
    recordNotice: (id, body) => post(`breaches/${id}/notices`, body),
    closeBreach: (id) => post(`breaches/${id}/close`, {}),
  };
}

// A shop on the shared core: its customers.
export const shopPrivacy = (businessId) => once(`shop:${businessId}`, () => ({
  kind: "shop",
  person: { one: "customer", many: "customers", One: "Customer" },
  get: (path, params, signal) => businessRead(businessId, `privacy/${path}`, params, signal),
  post: (path, body) => businessWrite(businessId, `privacy/${path}`, body),
  patch: (path, body) => businessWrite(businessId, `privacy/${path}`, body, "patch"),
  remove: (path) => businessWrite(businessId, `privacy/${path}`, undefined, "delete"),
}));

// The signed-in restaurant: its guests.
export const restaurantPrivacy = () => once("restaurant", () => ({
  kind: "restaurant",
  person: { one: "guest", many: "guests", One: "Guest" },
  get: async (path, params, signal) => (await api.get(`/privacy/${path}`, { params, signal })).data.data,
  post: async (path, body) => (await api.post(`/privacy/${path}`, body || {})).data.data,
  patch: async (path, body) => (await api.patch(`/privacy/${path}`, body || {})).data.data,
  remove: async (path) => (await api.delete(`/privacy/${path}`)).data.data,
}));

// The server's reason for a refusal ({ reason, purpose, open }), when it gave one.
export const refusalOf = (error) => error?.response?.data?.data || null;
