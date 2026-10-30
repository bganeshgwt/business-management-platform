import { useEffect, useRef } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import useAuth from "../../../hooks/useAuth";
import useBusiness from "../../../hooks/useBusiness";
import { getCurrentUser } from "../../../services/auth.service";
import { toast } from "../../../services/toast";
import { banner, endedNotice } from "../planWords";
import { usePlanScope } from "../usePlan";
import "../plan.css";

// The plan's banner at the top of every screen of a business (the app's frame
// and a clinic's workspace): the trial's days left, the end coming, grace, a
// payment being checked, or the end (read-only). Every member sees it; the
// owner gets the link to Your plan, staff neither link nor price
// (planWords.banner). On the billing screens, and in a workspace of its own
// (`working`: the clinic's and the lab's), only the urgent ones show.
//
// A write refused because the plan has ended (402 plan_ended, which
// services/api.js announces as "plan:ended") reads the plan again, so the
// banner says so, and says once on the page what to do: the owner renews,
// staff ask the owner. The screen shows the server's own sentence as it shows
// any refusal; a refusal inside a dialog is left to the dialog and the banner.

// The billing screens: the restaurant's POS and kitchen display, a shop's checkout counters.
const TILL_PATHS = ["/pos", "/kitchen"];
const TILL_SECTIONS = /^\/business-admin\/\d+\/(counter|rx-sale|salon-bill|jewellery-bill)\/?$/;
const ICONS = { info: "info", warn: "alert", danger: "lock" };
const NOTICE_ID = "plan-ended";

export default function PlanBanner({ working = false }) {
  const scope = usePlanScope();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const { reloadContext } = useBusiness();
  const latest = useRef(null);

  useEffect(() => {
    latest.current = { scope, pathname, navigate, refreshUser, reloadContext };
  });

  useEffect(() => {
    let shownOn = null;
    let readAt = 0;
    const onEnded = () => {
      const now = latest.current;
      if (!now) {
        return;
      }

      // The plan's state again, at most every few seconds.
      if (Date.now() - readAt > 3000) {
        readAt = Date.now();
        if (now.scope?.apiBusinessId) {
          now.reloadContext();
        } else if (now.scope) {
          getCurrentUser().then(now.refreshUser).catch(() => {});
        }
      }

      // Once on a page. A dialog says the refusal itself, and a notice would sit
      // over its buttons: the banner says the rest.
      if (shownOn === now.pathname || document.querySelector('[role="dialog"][aria-modal="true"]')) {
        return;
      }

      shownOn = now.pathname;
      const planPath = now.scope?.isOwner ? now.scope.planPath : null;
      const words = endedNotice({ isOwner: Boolean(planPath) });
      toast.warning(words.text, {
        id: NOTICE_ID,
        duration: 12000,
        action: words.actionLabel ? { label: words.actionLabel, onClick: () => now.navigate(planPath) } : undefined,
      });
    };

    window.addEventListener("plan:ended", onEnded);
    return () => window.removeEventListener("plan:ended", onEnded);
  }, []);

  if (!scope) {
    return null;
  }

  // Your plan itself says it all.
  if (scope.planPath && pathname === scope.planPath) {
    return null;
  }

  const shown = banner(scope.plan, { isOwner: scope.isOwner, today: scope.today, planPath: scope.planPath });

  if (!shown || (!shown.urgent && (working || TILL_PATHS.includes(pathname) || TILL_SECTIONS.test(pathname)))) {
    return null;
  }

  return (
    <div className={`plan-banner is-${shown.tone}`} role="status" data-plan-state={scope.plan.state}>
      <Icon name={ICONS[shown.tone] || "info"} size={18} className="plan-banner-icon" />
      <p className="plan-banner-text">{shown.text}</p>
      {shown.action && (
        <Link className="button button-secondary button-sm plan-banner-action" to={shown.action.to}>
          {shown.action.label}
        </Link>
      )}
    </div>
  );
}
