import { useCallback, useEffect, useState } from "react";
import useLiveRefresh from "../../../../hooks/useLiveRefresh";
import { businessRead, businessWrite } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { toast } from "../../../../services/toast";
import { useOpenBusiness } from "../../core/pages/hooks";

// The token queue's data and actions, shared by Business Admin's Token queue
// (TokenQueuePage.jsx) and the clinic workspace's desk (workspaces/clinic).

export const TOKEN_WORDS = { waiting: ["warning", "Waiting"], called: ["info", "Called"], in_consultation: ["success", "With the doctor"], done: ["neutral", "Done"],
  skipped: ["neutral", "Skipped"], cancelled: ["neutral", "Cancelled"] };

// The day's queue at the branch in view. It moves at the desk and in the
// cabins: a token given or called anywhere shows within a second (live
// updates), and the queue also reads itself every minute as a safety net.
// offset: the server's clock less this device's, for the waiting clocks.
export function useQueue(bizId) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(bizId, "clinic/queue", undefined, controller.signal).then((d) => {
      setData(d); setError("");
      if (d.server_time) setOffset(Date.parse(d.server_time) - Date.now() || 0);
    }).catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err)); });
    return () => controller.abort();
  }, [bizId, version]);
  const live = useLiveRefresh({ business: bizId }, ["token", "visit"], reload);
  return { data, error, reload, live, offset };
}

// What the desk and the doctors do with the queue: call, start, skip or cancel
// a token, and call a doctor's next patient. A consultation started from a
// token opens with onStarted(visitId).
export function useTokenActions(reload, onStarted) {
  const biz = useOpenBusiness();
  const act = async (token, action) => {
    try {
      const done = await businessWrite(biz.id, `clinic/tokens/${token.id}`, { action });
      if (action === "start" && done.visit_id) { onStarted(done.visit_id); return; }
      reload();
    } catch (err) { toast.error(getErrorMessage(err)); }
  };
  const next = async (doctor) => {
    try {
      const r = await businessWrite(biz.id, "clinic/tokens/next", { resourceId: doctor.resource_id || undefined });
      toast[r.called ? "success" : "info"](r.called ? `Token ${r.called.token_no}: ${r.called.patient_name}` : r.message);
      reload();
    } catch (err) { toast.error(getErrorMessage(err)); }
  };
  return { act, next };
}
