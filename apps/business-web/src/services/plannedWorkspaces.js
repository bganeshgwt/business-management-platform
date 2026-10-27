// Workspaces the platform will have that are not built yet (see
// docs/ARCHITECTURE.md › Every address). None is listed: every workspace of
// the staff app (the captain app, the clinic workspace, the lab workspace) is
// built and has its address.
//
// A new one gets its address at once: a route in App.jsx,
//   <Route path="<address>" element={<PlannedPage workspace="<key>" />} />,
// and an entry here, so the page says what is coming and what to use until
// then, never "Page not found", and a bookmark or a tablet set up on it keeps
// working when it is built. Then its real screen takes the route and its
// entry here is deleted.
//
// An entry: { title, icon, lead, coming: [lines], today, links: [{ to, label, icon }] }.
// today and links may be functions of { businesses }: the signed-in person's
// businesses, to link into one of them.
export const PLANNED_WORKSPACES = {};
