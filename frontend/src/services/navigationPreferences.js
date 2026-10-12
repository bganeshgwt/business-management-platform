export const QUICK_ACCESS_LIMIT = 5;

// A shared till can serve several restaurants/users. Preferences belong to
// the signed-in person on this browser, not to whoever last used the till.
export const quickAccessKey = (user) => `rmp_quick_access_v1:${user.restaurantId ?? "global"}:${user.id}`;

export const allowedQuickPaths = (paths, links) => {
  const allowed = new Set(links.map(link => link.to));
  return [...new Set(Array.isArray(paths) ? paths : [])]
    .filter(path => typeof path === "string" && allowed.has(path))
    .slice(0, QUICK_ACCESS_LIMIT);
};

export const readQuickAccess = (key) => {
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    return saved?.version === 1 && Array.isArray(saved.paths) ? saved.paths : [];
  } catch {
    return [];
  }
};

export const writeQuickAccess = (key, paths) => {
  // Let the caller show a useful error when browser storage is unavailable.
  localStorage.setItem(key, JSON.stringify({ version: 1, paths }));
};
