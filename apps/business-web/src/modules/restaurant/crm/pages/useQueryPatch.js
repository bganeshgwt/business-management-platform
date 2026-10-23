import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

// Changes several filters in the address bar in one step.
//
// A filter change also sends the list back to its first page, which is two
// keys: ?status=inactive and ?from=0. Two useQueryFilter setters called one
// after the other both start from the same address (react-router does not
// queue them the way React queues state), so the second wiped out the first
// and a click on "Inactive" did nothing. Here every key is written at once.
//
//   const patch = useQueryPatch(DEFAULTS);   // DEFAULTS: a module constant
//   patch({ status: "inactive", from: 0 });
//
// A value equal to its default, empty, null or false is taken out of the
// address rather than left as "?from=0"; true is written as "true".
export default function useQueryPatch(defaults) {
  const [, setParams] = useSearchParams();

  return useCallback(
    (changes) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);

          for (const [key, value] of Object.entries(changes)) {
            const text = value === null || value === undefined || value === false ? "" : value === true ? "true" : String(value);
            const fallback = defaults && defaults[key] !== undefined ? String(defaults[key]) : "";

            if (text === "" || text === fallback) {
              next.delete(key);
            } else {
              next.set(key, text);
            }
          }

          return next;
        },
        { replace: true }
      );
    },
    [setParams, defaults]
  );
}
