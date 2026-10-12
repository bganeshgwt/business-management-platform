import { useEffect, useMemo, useState } from "react";
import SearchPicker from "./SearchPicker";
import { outletStorage } from "../services/api";
import { listOutlets } from "../services/outlet.service";
import useAuth from "../hooks/useAuth";

// Which outlet the user is working in. Orders, bills and stock movements are
// recorded against it.
//
// A user tied to one outlet has nothing to choose, a user who may not see
// outlets has nothing to ask for, and a restaurant with no outlets has nothing
// to show — in each case this renders nothing and asks the server nothing.
//
// A chain can have hundreds of outlets, so it is a SearchPicker (type a few
// letters of the name or code, arrows and Enter) rather than a long <select>.
export default function OutletSwitcher({ className = "" }) {
  const { user, hasPermission } = useAuth();
  const [outlets, setOutlets] = useState([]);
  const [chosen, setChosen] = useState(() => outletStorage.get() || "");

  const pinned = Boolean(user.outletId);
  // Captains, kitchen and cashiers do not hold outlets.view: asking would only
  // earn a 403 on every page load.
  const allowed = hasPermission("outlets.view");

  useEffect(() => {
    if (pinned || !allowed || !user.restaurantId) {
      return;
    }

    listOutlets()
      .then((rows) => setOutlets(rows.filter((row) => row.status === "active")))
      .catch(() => setOutlets([]));
  }, [pinned, allowed, user.restaurantId]);

  const options = useMemo(
    () => [{ id: "", name: "All outlets", code: "" }, ...outlets.map((outlet) => ({ id: String(outlet.id), name: outlet.name, code: outlet.code || "" }))],
    [outlets]
  );
  const current = options.find((option) => option.id === String(chosen || "")) || options[0];

  // Changing outlet changes what every later request is recorded against, so
  // the page is reloaded rather than left showing a half-switched screen.
  const change = (option) => {
    if (!option || option.id === String(chosen || "")) {
      return;
    }

    setChosen(option.id);
    outletStorage.set(option.id || null);
    window.location.reload();
  };

  if (pinned || !allowed || outlets.length === 0) {
    return null;
  }

  return (
    <div className={`outlet-switcher ${className}`}>
      <SearchPicker
        aria-label="Outlet"
        value={current}
        onChange={change}
        options={options}
        getKey={(option) => option.id}
        getLabel={(option) => option.name}
        getKeywords={(option) => option.code}
        clearable={false}
        placeholder="Find an outlet…"
        emptyText="No outlet has that name"
      />
    </div>
  );
}
