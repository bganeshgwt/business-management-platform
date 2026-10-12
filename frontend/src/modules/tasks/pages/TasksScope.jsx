import { useCallback, useEffect, useMemo, useState } from "react";
import useBusiness from "../../../hooks/useBusiness";
import { getErrorMessage } from "../../../services/api";
import { tasksApi, tasksBase } from "../services/tasks.service";
import { TasksContext } from "./useTasks";

// One set of task screens for both worlds. Inside a restaurant the API is
// /tasks and the screens live at /tasks/…; inside any other business it is
// /businesses/<id>/tasks and /business-admin/<id>/tasks/…. Everything a
// screen needs about "here" comes from this provider: the API, what this
// person may do, the people, roles and places to pick from, the categories.

export function TasksProvider({ children }) {
  const business = useBusiness();
  const businessId = business.inBusinessAdmin ? business.businessId : null;
  const api = useMemo(() => tasksApi(tasksBase(businessId)), [businessId]);
  const root = businessId ? `/business-admin/${businessId}/tasks` : "/tasks";
  const [ctx, setCtx] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    api.context()
      .then((value) => { if (live) { setCtx(value); setError(""); } })
      .catch((err) => { if (live) setError(getErrorMessage(err)); });
    return () => { live = false; };
  }, [api, version]);

  const reload = useCallback(() => setVersion((n) => n + 1), []);

  const value = useMemo(() => {
    const permissions = new Set(ctx?.permissions || []);
    const categories = ctx?.categories || [];
    const directory = ctx?.directory || { peopleCount: 0, roles: [], places: [], shifts: [], placeWord: "Location" };
    return {
      api, ctx, error, reload, root,
      ready: Boolean(ctx),
      world: ctx?.world || (businessId ? "business" : "restaurant"),
      businessId,
      link: (path = "") => `${root}${path ? `/${path.replace(/^\//, "")}` : ""}`,
      can: (code) => permissions.has(code),
      has: (module) => Boolean(ctx?.modules?.[module]),
      userId: ctx?.userId,
      // People are searched (PeoplePicker / searchPeople), not loaded here.
      peopleCount: directory.peopleCount || 0,
      searchPeople: (q, { signal, kind } = {}) => api.people({ q: q || undefined, kind, limit: 30 }, signal).then((r) => r.rows),
      roles: directory.roles,
      places: directory.places,
      shifts: directory.shifts || [],
      placeWord: directory.placeWord,
      outletScope: directory.outletScope,
      categories,
      categoryName: (code) => categories.find((c) => c.code === code)?.name || code,
      categoryIcon: (code) => categories.find((c) => c.code === code)?.icon || "list",
    };
  }, [api, ctx, error, reload, root, businessId]);

  return <TasksContext.Provider value={value}>{children}</TasksContext.Provider>;
}
