import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { matchPath, useLocation, useNavigate } from "react-router-dom";
import { BusinessContext } from "./business-context";
import useAuth from "../hooks/useAuth";
import { businessContext, listBusinesses, openBusiness } from "../services/business.service";
import { getErrorMessage } from "../services/api";
import { businessPath, isRestaurantStaff, landingBusiness } from "../services/businessNav";
import { confirmAction } from "../services/confirm";

// One Business Admin, many businesses. This provider knows:
//   - the businesses the signed-in person is a member of (the switcher's list);
//   - which one is open — taken from the URL (/business-admin/<id>/…), or the
//     signed-in restaurant's own business on the restaurant screens;
//   - for an open business, what it has switched on and what this person's
//     role allows (the server checks both again on every request).
// The choice is remembered on the server per person (last opened), so a
// reload or another device lands in the same business.

export default function BusinessProvider({ children }) {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [directory, setDirectory] = useState(null);
  const [directoryError, setDirectoryError] = useState("");
  const [loaded, setLoaded] = useState(null);
  const [contextError, setContextError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const dirty = useRef(false);
  const landed = useRef(false);

  const match = matchPath("/business-admin/:businessId/*", pathname);
  const businessId = match && /^\d+$/.test(match.params.businessId) ? Number(match.params.businessId) : null;

  const loadDirectory = useCallback(() => listBusinesses()
    .then((result) => { setDirectory(result); setDirectoryError(""); return result; })
    .catch((error) => { setDirectoryError(getErrorMessage(error)); return null; }), []);

  useEffect(() => {
    loadDirectory();
  }, [loadDirectory, user.id]);

  // The open business's modules, permissions and settings.
  useEffect(() => {
    if (!businessId) {
      return undefined;
    }
    const controller = new AbortController();
    businessContext(businessId, controller.signal)
      .then((data) => { setLoaded({ id: businessId, key: reloadKey, data }); setContextError(null); })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setContextError({ id: businessId, message: getErrorMessage(error), status: error?.response?.status });
        }
      });
    return () => controller.abort();
    // A till switched to another person (PIN) reloads what their role allows.
  }, [businessId, reloadKey, user.id]);

  // Landing on the home screen goes back to the business this person last
  // opened, when that was not their restaurant. Only on arrival, never later.
  // Staff with no restaurant role are sent on by the home screen itself
  // (App.jsx › Home), whenever they reach it.
  const restaurantStaff = isRestaurantStaff(user);
  useEffect(() => {
    if (!directory || landed.current) {
      return;
    }
    landed.current = true;
    if (pathname !== "/" || !restaurantStaff) {
      return;
    }
    const pick = landingBusiness(directory.businesses, true);
    if (pick) {
      navigate(businessPath(pick.id), { replace: true });
    }
  }, [directory, navigate, pathname, restaurantStaff]);

  const businesses = useMemo(() => directory?.businesses || [], [directory]);
  const restaurantBusiness = businesses.find((b) => b.is_signed_in_restaurant) || null;
  const context = loaded && loaded.id === businessId ? loaded.data : null;
  const error = contextError && contextError.id === businessId ? contextError : null;
  const current = businessId ? businesses.find((b) => b.id === businessId) || context?.business || null : restaurantBusiness;

  // Asked in the app's own dialog (not the browser's grey box); resolves
  // true straight away when nothing is unsaved.
  const confirmLeave = useCallback(
    async () =>
      !dirty.current ||
      confirmAction({
        title: "Discard your changes?",
        message: "The form has changes that are not saved. Leave it and lose them?",
        confirmLabel: "Discard changes",
        cancelLabel: "Keep editing",
      }),
    []
  );
  const setDirty = useCallback((value) => { dirty.current = Boolean(value); }, []);

  const switchTo = useCallback(async (business) => {
    if (!(await confirmLeave())) {
      return;
    }
    dirty.current = false;
    // Remembering is a convenience: a failure must not stop the switch.
    openBusiness(business.id)
      .then(() => setDirectory((d) => d && { ...d, businesses: d.businesses.map((b) => (b.id === business.id ? { ...b, last_opened_at: new Date().toISOString() } : b)) }))
      .catch(() => {});
    if (business.business_type === "restaurant" && business.is_signed_in_restaurant) {
      navigate("/");
    } else {
      navigate(businessPath(business.id));
    }
  }, [confirmLeave, navigate]);

  const value = useMemo(() => {
    const permissions = new Set(context?.permissions || []);
    const modules = new Set(context?.modules || []);
    return {
      directory, directoryError, businesses, businessId, current, context, error,
      restaurantBusiness, inBusinessAdmin: Boolean(businessId),
      has: (module) => modules.has(module),
      // A permission counts only when its module is on, exactly as the server decides.
      can: (permission) => permissions.has(permission) && modules.has(permission.split(".")[0]),
      reloadDirectory: loadDirectory,
      reloadContext: () => setReloadKey((n) => n + 1),
      switchTo, confirmLeave, setDirty,
      path: (section) => businessPath(businessId, section),
    };
  }, [directory, directoryError, businesses, businessId, current, context, error, restaurantBusiness, loadDirectory, switchTo, confirmLeave, setDirty]);

  return <BusinessContext.Provider value={value}>{children}</BusinessContext.Provider>;
}
