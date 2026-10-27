import { EmptyState, ErrorMessage, Loading } from "../../components/Feedback";
import { CallCard, OrderCard } from "../../modules/restaurant/orders/pages/TableRequestsPage";
import { countsOf, orderLink, waitingList } from "./captainFloor.js";
import { useFloor } from "./floorContext";
import { useRequestActions, useServerNow } from "./captainActions";
import MineSwitch from "./MineSwitch";

const OPEN_ORDER = ["pending", "processing"];

// Guests at the captain's tables, from the QR code on each: their calls (a
// waiter, water, the bill, something else), answered with On my way (the
// guest sees someone is coming) and closed with Done; and their own orders,
// accepted (to the kitchen and the bill) or rejected with a reason they read.
// The longest waiting first, with the inbox's own cards and clocks. Orders
// from the online ordering page have no table: the counter takes those.
export default function CaptainCallsPage() {
  const floor = useFloor();
  const serverNow = useServerNow(floor.offset, 1000);
  const requests = useRequestActions(floor);

  if (!floor.can.calls) {
    return (
      <section className="cpt-page" aria-labelledby="cpt-title">
        <div className="cpt-page-head">
          <h1 id="cpt-title">Calls</h1>
        </div>
        <EmptyState
          icon="bell"
          message="Guests' calls come from the QR codes on the tables"
          hint="QR ordering is switched off here, or your role cannot see orders."
        />
      </section>
    );
  }

  const calls = waitingList(floor.shown, floor.waiting, "calls");
  const orders = waitingList(floor.shown, floor.waiting, "orders");
  const elsewhere = countsOf(floor.tables || [], floor.waiting).calls - (calls.length + orders.length);
  const online = floor.requests.filter((request) => request.type === "order" && !request.tableId && OPEN_ORDER.includes(request.status)).length;
  const card = (request) => ({
    key: request.id,
    request,
    now: serverNow,
    busy: requests.busy[request.id],
    error: requests.errors[request.id],
    canOpenPos: floor.can.accept,
    myUserId: floor.user.id,
    orderLink,
  });

  return (
    <section className="cpt-page" aria-labelledby="cpt-title">
      <div className="cpt-page-head">
        <h1 id="cpt-title">Calls</h1>
        <MineSwitch />
      </div>

      <ErrorMessage message={floor.errors.calls} />

      {!floor.loaded ? (
        <Loading label="Reading the calls…" />
      ) : (
        <>
          {orders.length > 0 && (
            <section className="stack cpt-part" aria-labelledby="cpt-orders-title">
              <h2 id="cpt-orders-title">Orders from the QR code</h2>
              {orders.map(({ entry }) => {
                const { key, ...props } = card(entry);

                return (
                  <OrderCard
                    key={key}
                    {...props}
                    canAct={floor.can.accept}
                    currency={floor.currency}
                    workingOutlet={floor.workingOutlet}
                    onAccept={requests.accept}
                    onReject={requests.openReject}
                  />
                );
              })}
            </section>
          )}

          <section className="stack cpt-part" aria-labelledby="cpt-calls-title">
            <h2 id="cpt-calls-title">Calls from the tables</h2>
            {calls.length === 0 ? (
              <EmptyState
                icon="bell"
                message="Nobody is calling"
                hint="A guest's call for a waiter, the bill or water lands here, with a buzz and a chime when alerts are on."
              />
            ) : (
              calls.map(({ entry }) => {
                const { key, ...props } = card(entry);

                return <CallCard key={key} {...props} onAcknowledge={requests.acknowledge} onDone={requests.done} />;
              })
            )}
          </section>

          {floor.onlyMine && elsewhere > 0 && (
            <p className="muted small cpt-elsewhere">
              {elsewhere === 1 ? "One more is waiting" : `${elsewhere} more are waiting`} at other tables.{" "}
              <button type="button" className="link-button" onClick={() => floor.chooseMine(false)}>
                Show all tables
              </button>
            </p>
          )}
          {online > 0 && (
            <p className="muted small cpt-elsewhere">
              {online === 1 ? "An online order waits" : `${online} online orders wait`} for the counter, under Orders → Table requests.
            </p>
          )}
        </>
      )}

      {requests.rejectDialog}
    </section>
  );
}
