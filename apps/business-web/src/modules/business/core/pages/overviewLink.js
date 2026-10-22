// A link from the Overview that opens its screen over the Overview, in a wide
// panel (?open=section, plus that screen's own settings such as new=1),
// instead of leaving the Overview (BusinessAdminRoutes › OverviewSheet).
export function overviewLink(to) {
  const [section, query = ""] = String(to).split("?");
  const params = new URLSearchParams(query);
  return `?${new URLSearchParams([["open", section], ...params.entries()])}`;
}
