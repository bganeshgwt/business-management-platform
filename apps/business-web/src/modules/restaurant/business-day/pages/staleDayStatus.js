import { useEffect, useState } from "react";
import { getBusinessDay } from "../services/businessDay.service";
import useAuth from "../../../../hooks/useAuth";

// The GET /business-day answer shared by the stale-day banner and the date
// chip (StaleDay.jsx): one read per screen visit, kept 30 seconds.
let shared = null;
let sharedAt = 0;

const readStatus = () => {
  if (!shared || Date.now() - sharedAt > 30000) {
    sharedAt = Date.now();
    shared = getBusinessDay().catch((error) => {
      shared = null;
      throw error;
    });
  }

  return shared;
};

// Forget the shared read (after a day is closed or opened).
export const forgetBusinessDay = () => {
  shared = null;
};

export const staleWords = (stale) => `${stale.days} ${stale.days === 1 ? "day" : "days"}`;

// given: the status the screen already has (then nothing is fetched).
export function useBusinessDayStatus(given) {
  const { hasPermission } = useAuth();
  const allowed = hasPermission("business_day.view");
  const [fetched, setFetched] = useState(null);

  useEffect(() => {
    if (given !== undefined || !allowed) {
      return undefined;
    }

    let live = true;

    readStatus()
      .then((data) => live && setFetched(data))
      .catch(() => live && setFetched(null));

    return () => {
      live = false;
    };
  }, [given, allowed]);

  return given !== undefined ? given : fetched;
}
