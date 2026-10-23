import { useMemo } from "react";
import SearchPicker from "./SearchPicker";
import useBusiness from "../hooks/useBusiness";
import { businessLocationStorage } from "../services/api";

// Which location (branch) of the open business the person is working in —
// the Business Admin twin of the restaurant's outlet picker.
//
// A person tied to one location has nothing to choose: their branch is shown
// and the server answers every request for it. Anyone else may pick a branch
// (or "All locations"); it is sent with every request of this business, and
// the server uses it wherever a request names no location, so lists, reports,
// the Overview and the counter all open on that branch. A business with one
// location shows nothing.
export default function BusinessLocationSwitcher({ className = "" }) {
  const { businessId, context } = useBusiness();
  const all = useMemo(() => (context?.allLocations || []).filter((l) => l.active), [context]);
  const pinned = context?.member?.location_id || null;
  const chosen = context?.currentLocationId ? String(context.currentLocationId) : "";

  const options = useMemo(
    () => [{ id: "", name: "All locations", code: "" }, ...all.map((l) => ({ id: String(l.id), name: l.name, code: l.code || "" }))],
    [all]
  );

  if (!businessId || !context || String(context.business?.id) !== String(businessId)) {
    return null;
  }
  if (pinned) {
    return (
      <span className={`outlet-switcher bz-location-pinned ${className}`} title="You work at this location only">
        {context.member.location_name}
      </span>
    );
  }
  if (all.length < 2) {
    return null;
  }

  const current = options.find((option) => option.id === chosen) || options[0];
  // Every later request is answered for the new branch, so the page reloads
  // rather than showing a half-switched screen (as the outlet picker does).
  const change = (option) => {
    if (!option || option.id === chosen) {
      return;
    }
    businessLocationStorage.set(businessId, option.id || null);
    window.location.reload();
  };

  return (
    <div className={`outlet-switcher ${className}`}>
      <SearchPicker
        aria-label="Location"
        value={current}
        onChange={change}
        options={options}
        getKey={(option) => option.id}
        getLabel={(option) => option.name}
        getKeywords={(option) => option.code}
        clearable={false}
        placeholder="Find a location…"
        emptyText="No location has that name"
      />
    </div>
  );
}
