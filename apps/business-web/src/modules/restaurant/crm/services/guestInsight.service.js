import api from "../../../../services/api";

// Guest insights: segments worked out from the guest book, the orders linked
// to each guest and the bills on them. Read-only apart from the export, which
// the server writes to the activity log.

export const getGuestInsights = async () => (await api.get("/guest-insights")).data.data;

export const getGuestSegment = async (key, params = {}) =>
  (await api.get(`/guest-insights/segments/${encodeURIComponent(key)}`, { params })).data.data;

// One guest by id, for a link into the screen. Resolves to the guest, or to
// null when they are not in this restaurant's guest book (any more).
export const findGuest = async (id) => {
  const data = (await api.get("/guest-insights/guests", { params: { id } })).data.data;
  return data.items[0] || null;
};

// format: "csv" for a spreadsheet, "mobiles" for a broadcast list. search:
// what is typed in the list's search box, so the export is what the screen
// shows; leave it out for the whole list.
export const exportGuestSegment = async (key, format, search) =>
  (
    await api.post(`/guest-insights/segments/${encodeURIComponent(key)}/export`, {
      format,
      ...(search ? { search } : {}),
    })
  ).data.data;
