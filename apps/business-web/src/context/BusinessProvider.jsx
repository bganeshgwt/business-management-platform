import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { matchPath, useLocation, useNavigate } from "react-router-dom";
import { BusinessContext } from "./business-context";
import useAuth from "../hooks/useAuth";
import { businessContext, listBusinesses, openBusiness } from "../services/business.service";
import { getErrorMessage } from "../services/api";
import { arrivalLanding, businessPath, isRestaurantStaff } from "../services/businessNav";
import { confirmAction } from "../services/confirm";
import { readContextCopy, readDirectoryCopy, saveContextCopy, saveDirectoryCopy } from "../services/offline/offlineCopies";

// One Business Admin, many businesses. This provider knows:
//   - the businesses the signed-in person is a member of (the switcher's list);
//   - which one is open — taken from the URL (/business-admin/<id>/…), or the
//     signed-in restaurant's own business on the restaurant screens;
//   - for an open business, what it has switched on and what this person's
//     role allows (the server checks both again on every request).
// The choice is remembered on the server per person (last opened), so a
// reload or another device lands in the same business.
//
// A workspace outside Business Admin (the clinic's, the lab's) opens one
// business by itself: it passes that business's id as `businessId`, and as
// `paths(section)` where a screen's links lead there instead (null: to the
// screen in Business Admin, as always).
//
// The list and an opened business's context are kept on this device as they
// are read (services/offline/offlineCopies.js). With no answer from the
// server, the copy stands in, and `offline` says since when (a screen that
// works offline opens from it; docs/ARCHITECTURE.md › Offline boot).

export default function BusinessProvider({ children, businessId: openId = null, paths = null }) {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [directory, setDirectory] = useState(null);
  const [directoryError, setDirectoryError] = useState("");
  const [loaded, setLoaded] = useState(null);
  const [contextError, setContextError] = useState(null);
  // When the copies shown were read: { directory, context }, null while fresh.
  const [copied, setCopied] = useState({ directory: null, context: null });
  const [reloadKey, setReloadKey] = useState(0);
  const dirty = useRef(false);
  const landed = useRef(false);

  const match = matchPath("/business-admin/:businessId/*", pathname);
  const inAdmin = Boolean(match && /^\d+$/.test(match.params.businessId));
  const businessId = openId || (inAdmin ? Number(match.params.businessId) : null);

  // Landing on the home screen goes back to the business this person last
  // opened, when that was not their restaurant: decided once, as their list
  // first arrives and before it is set, so the screen goes from the loading
  // screen straight to the business (layouts/AppLayout.jsx › HomeGate waits for
  // the list on the home screen). Staff with no restaurant role are sent on by
  // HomeGate itself, whenever they reach the home screen.
  // The loader keeps one identity (it runs again only for another person), so
  // it reads the router's navigate and the person's kind from here.
  // `current()` says whether a load still counts: one started for the list's
  // first arrival is dropped once another has started in its place (React
  // starts the provider twice in development; the person changed), so only
  // one decides where the person lands, and none sets the list at the home
  // screen while the move to their business is still on its way.
  const latest = useRef({ navigate, restaurantStaff: isRestaurantStaff(user) });
  useEffect(() => {
    latest.current = { navigate, restaurantStaff: isRestaurantStaff(user) };
  });
  const loadDirectory = useCallback((current = () => true) => listBusinesses()
    .then((result) => {
      if (!current()) return result;
      const target = landed.current ? null : arrivalLanding(result.businesses, latest.current.restaurantStaff, window.location.pathname);
      landed.current = true;
      saveDirectoryCopy(user.id, result);
      const show = () => { setDirectory(result); setDirectoryError(""); setCopied((c) => ({ ...c, directory: null })); };
      if (target) {
        // The router moves to an address in a transition: the list joins it,
        // so the home screen is never drawn with the list before the move.
        startTransition(() => {
          latest.current.navigate(target, { replace: true });
          show();
        });
      } else {
        show();
      }
      return result;
    })
    .catch(async (error) => {
      // No answer: this device's copy of the list, when it has one.
      const copy = error?.response ? null : await readDirectoryCopy(user.id);
      if (copy && current()) {
        landed.current = true;
        setDirectory(copy.value); setDirectoryError(""); setCopied((c) => ({ ...c, directory: copy.savedAt }));
        return copy.value;
      }
      if (current()) { landed.current = true; setDirectoryError(getErrorMessage(error)); }
      return null;
    }), [user.id]);

  useEffect(() => {
    let current = true;
    loadDirectory(() => current);
    return () => { current = false; };
  }, [loadDirectory, user.id]);

  // The open business's modules, permissions and settings.
  useEffect(() => {
    if (!businessId) {
      return undefined;
    }
    const controller = new AbortController();
    businessContext(businessId, controller.signal)
      .then((data) => {
        setLoaded({ id: businessId, key: reloadKey, data }); setContextError(null);
        setCopied((c) => ({ ...c, context: null }));
        saveContextCopy(user.id, businessId, data);
      })
      .catch(async (error) => {
        if (controller.signal.aborted) return;
        // No answer: this device's copy of the business's context, when it has one.
        const copy = error?.response ? null : await readContextCopy(user.id, businessId);
        if (controller.signal.aborted) return;
        if (copy) {
          setLoaded({ id: businessId, key: reloadKey, data: copy.value }); setContextError(null);
          setCopied((c) => ({ ...c, context: copy.savedAt }));
          return;
        }
        setContextError({ id: businessId, message: getErrorMessage(error), status: error?.response?.status });
      });
    return () => controller.abort();
    // A till switched to another person (PIN) reloads what their role allows.
  }, [businessId, reloadKey, user.id]);

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
      restaurantBusiness, inBusinessAdmin: inAdmin && !openId,
      has: (module) => modules.has(module),
      // A permission counts only when its module is on, exactly as the server decides.
      can: (permission) => permissions.has(permission) && modules.has(permission.split(".")[0]),
      reloadDirectory: () => loadDirectory(),
      reloadContext: () => setReloadKey((n) => n + 1),
      switchTo, confirmLeave, setDirty,
      path: (section) => (paths && paths(section)) || businessPath(businessId, section),
      // Since when the list or the context shown is this device's copy (no network), else null.
      offline: copied.context || copied.directory || null,
    };
  }, [directory, directoryError, businesses, businessId, current, context, error, restaurantBusiness, inAdmin, openId, paths, loadDirectory, switchTo, confirmLeave, setDirty, copied]);

  return <BusinessContext.Provider value={value}>{children}</BusinessContext.Provider>;
}
