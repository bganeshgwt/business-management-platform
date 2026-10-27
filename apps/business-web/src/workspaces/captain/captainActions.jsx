import { useEffect, useState } from "react";
import { getErrorMessage } from "../../services/api";
import { toast } from "../../services/toast";
import {
  acceptTableRequest,
  acknowledgeTableRequest,
  completeTableRequest,
  rejectTableRequest,
} from "../../modules/restaurant/orders/services/tableRequest.service";
import { setTicketStatus } from "../../modules/restaurant/kitchen/services/kitchen.service";
import { RejectDialog } from "../../modules/restaurant/orders/pages/TableRequestsPage";

// What the captain app does about what is waiting at a table, through the
// calls Table requests and the kitchen display make: answering a guest's call
// (On my way, Done), accepting or rejecting a QR order, and serving food from
// the pass. Each says what happened, keeps a refusal beside its card, and has
// the floor read again.

// The time on the server's clock, moving every `every` ms: the waiting clocks.
export function useServerNow(offset, every = 1000) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), every);

    return () => clearInterval(tick);
  }, [every]);

  return now + offset;
}

const without = (map, key) => {
  const next = { ...map };
  delete next[key];
  return next;
};

export function useRequestActions(floor) {
  const [busy, setBusy] = useState({});
  const [errors, setErrors] = useState({});
  const [rejecting, setRejecting] = useState(null);
  const [rejectError, setRejectError] = useState("");

  const run = async (request, kind, call) => {
    setBusy((current) => ({ ...current, [request.id]: kind }));
    setErrors((current) => without(current, request.id));

    try {
      const response = await call();
      toast.success(response.message);
    } catch (err) {
      setErrors((current) => ({ ...current, [request.id]: getErrorMessage(err) }));
    } finally {
      setBusy((current) => without(current, request.id));
      // An accepted order opens or adds to the table's order.
      await Promise.all(kind === "accept" ? [floor.reload.requests(), floor.reload.tables(), floor.reload.orders()] : [floor.reload.requests()]);
    }
  };

  const reject = async (reason) => {
    const request = rejecting;
    setRejectError("");
    setBusy((current) => ({ ...current, [request.id]: "reject" }));

    try {
      const response = await rejectTableRequest(request.id, reason);
      toast.success(response.message);
      setErrors((current) => without(current, request.id));
      setRejecting(null);
    } catch (err) {
      setRejectError(getErrorMessage(err));
    } finally {
      setBusy((current) => without(current, request.id));
      await floor.reload.requests();
    }
  };

  return {
    busy,
    errors,
    accept: (request) => run(request, "accept", () => acceptTableRequest(request.id)),
    acknowledge: (request) => run(request, "acknowledge", () => acknowledgeTableRequest(request.id)),
    done: (request) => run(request, "done", () => completeTableRequest(request.id)),
    openReject: (request) => {
      setRejectError("");
      setRejecting(request);
    },
    rejectDialog: rejecting && (
      <RejectDialog
        key={rejecting.id}
        request={rejecting}
        failure={errors[rejecting.id]}
        busy={busy[rejecting.id] === "reject"}
        error={rejectError}
        onReject={reject}
        onClose={() => setRejecting(null)}
      />
    ),
  };
}

export function useServe(floor) {
  const [busy, setBusy] = useState({});
  const [errors, setErrors] = useState({});

  const serve = async (ticket) => {
    setBusy((current) => ({ ...current, [ticket.id]: true }));
    setErrors((current) => without(current, ticket.id));

    try {
      const response = await setTicketStatus(ticket.id, "served");
      toast.success(`${response.message}${ticket.tableNo ? ` · table ${ticket.tableNo}` : ""}`);
    } catch (err) {
      setErrors((current) => ({ ...current, [ticket.id]: getErrorMessage(err) }));
    } finally {
      setBusy((current) => without(current, ticket.id));
      await Promise.all([floor.reload.pass(), floor.reload.orders()]);
    }
  };

  return { busy, errors, serve };
}
