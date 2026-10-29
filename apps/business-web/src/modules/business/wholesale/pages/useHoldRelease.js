import { useEffect, useState } from "react";
import { businessRead } from "../../../../services/business.service";

// The release being filled in, the managers who may give it (asked for once
// a hold is met), and the request's part: { release: { reason, approverId?, pin? } }.
export function useHoldRelease(biz, hold) {
  const [release, setRelease] = useState({ reason: "", approverId: "", pin: "" });
  const [releasers, setReleasers] = useState(null);
  useEffect(() => {
    if (!hold || biz.can("receivables.approve") || releasers) return;
    businessRead(biz.id, "hold-releasers").then(setReleasers).catch(() => setReleasers([]));
  }, [biz, hold, releasers]);
  const body = () => (hold ? { release: { reason: release.reason, ...(release.approverId ? { approverId: release.approverId, pin: release.pin } : {}) } } : {});
  return { release, setRelease, releasers, body };
}
