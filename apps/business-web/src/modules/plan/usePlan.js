import { useEffect, useState } from "react";
import useAuth from "../../hooks/useAuth";
import useBusiness from "../../hooks/useBusiness";
import { businessPath } from "../../services/businessNav";
import { getPlan } from "./services/plan.service";
import { todayIn } from "./planWords";

// The time zone this browser keeps, for a restaurant's dates (its profile
// carries none).
const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return null;
  }
};

// Whose plan a screen shows, or null: the open business's (Business Admin, a
// clinic's workspace), from its context, or else the signed-in restaurant's,
// from the profile. Neither carries a price.
//   plan          { state, accessEndsOn, trialEndsOn, graceEndsOn, daysLeft }
//   isOwner       the business's Owner role; a restaurant's owner (restaurant.settings.manage)
//   planPath      where Your plan opens for this person, or null (staff; a
//                 restaurant's business seen from Business Admin by anyone but
//                 that restaurant's own owner)
//   apiBusinessId the business for /businesses/:id/plan; null for the restaurant's /plan
//   today         "YYYY-MM-DD" on the business's clock
export function usePlanScope() {
  const { user, hasPermission } = useAuth();
  const { businessId, context } = useBusiness();

  if (businessId) {
    if (!context || String(context.business.id) !== String(businessId)) {
      return null;
    }

    const business = context.business;
    const isOwner = Boolean(context.role?.full_access);
    const restaurant = business.business_type === "restaurant";
    const ownRestaurant = restaurant && Boolean(user?.restaurantId) && Number(business.legacy_restaurant_id) === Number(user.restaurantId)
      && hasPermission("restaurant.settings.manage");
    return {
      plan: context.plan || null,
      isOwner,
      planPath: restaurant ? (ownRestaurant ? "/plan" : null) : isOwner ? businessPath(business.id, "plan") : null,
      apiBusinessId: business.id,
      today: todayIn(business.timezone),
    };
  }

  if (!user?.restaurantId) {
    return null;
  }

  const isOwner = hasPermission("restaurant.settings.manage");
  return { plan: user.plan || null, isOwner, planPath: isOwner ? "/plan" : null, apiBusinessId: null, today: todayIn(browserZone()) };
}

// Your plan's answer, for the owner's plan badges (the choice and its
// prices); null for anyone else, and while it loads. `version` reads it again.
export function useOwnerPlan(scope, version = 0) {
  const [loaded, setLoaded] = useState(null);
  const wanted = Boolean(scope?.isOwner && scope.plan && !["unmanaged", "off"].includes(scope.plan.state));
  const key = scope ? `${scope.apiBusinessId ?? "restaurant"}:${version}` : null;

  useEffect(() => {
    if (!wanted) {
      return undefined;
    }

    const controller = new AbortController();
    getPlan(scope.apiBusinessId, controller.signal)
      .then((view) => setLoaded({ key, view }))
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoaded({ key, view: null });
        }
      });
    return () => controller.abort();
  }, [wanted, key, scope?.apiBusinessId]);

  return wanted && loaded?.key === key ? loaded.view : null;
}
