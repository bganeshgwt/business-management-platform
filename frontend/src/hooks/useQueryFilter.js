import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

// A list filter kept in the address bar rather than in component state.
//
// It started as a bug: the dashboard's "2 running orders" tile linked to
// /orders, which opened showing every order ever taken. The tile counted one
// thing and the page it led to showed another.
//
// Putting the filter in the URL fixes that and three other things with it: the
// back button returns to the list as it was, a filtered list can be sent to
// someone, and a reload does not throw the filter away.
//
// Values are strings, because that is what a URL holds. An empty value is
// removed from the address rather than left as "?status=".
export default function useQueryFilter(key, fallback = "") {
  const [params, setParams] = useSearchParams();

  const value = params.get(key) ?? fallback;

  const setValue = useCallback(
    (next) => {
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          const text = next === null || next === undefined ? "" : String(next);

          if (text === "" || text === String(fallback)) {
            updated.delete(key);
          } else {
            updated.set(key, text);
          }

          return updated;
        },
        // Replace rather than push: changing a dropdown should not make the
        // back button walk through every filter the user tried.
        { replace: true }
      );
    },
    [key, fallback, setParams]
  );

  return [value, setValue];
}

// The same thing for a checkbox, which needs a boolean rather than a string.
export function useQueryFlag(key) {
  const [value, setValue] = useQueryFilter(key, "");

  return [value === "true", useCallback((next) => setValue(next ? "true" : ""), [setValue])];
}
