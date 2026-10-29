import { useState } from "react";
import { ErrorMessage, Loading } from "../../components/Feedback";
import useAuth from "../../hooks/useAuth";
import TableGrid from "../../modules/restaurant/orders/pages/TableGrid";
import { useFloorActions } from "../../modules/restaurant/dashboard/pages/panels/floorActions";
import { marksOf, ORDER_SCREEN } from "./captainFloor.js";
import { useFloor } from "./floorContext";
import { useBillAsk, useRequestActions, useServe, useServerNow } from "./captainActions";
import MineSwitch from "./MineSwitch";
import TableSheet from "./TableSheet";
import "../../modules/restaurant/orders/styles/orders.css";
import "../../modules/restaurant/orders/styles/pos.css";

// The captain app's first screen: the tables, as the POS draws them, each
// saying at a glance what is happening there and what is waiting: a guest
// calling or asking for the bill, a QR order to accept, food at the pass, the
// order with the kitchen; with the guests seated, how long they have been
// there and, for someone who may see takings, the running total. A tap opens
// the table (TableSheet).
export default function CaptainTablesPage() {
  const floor = useFloor();
  const { hasPermission } = useAuth();
  const [openId, setOpenId] = useState(null);
  const table = openId ? (floor.tables || []).find((row) => String(row.id) === String(openId)) || null : null;
  // The sheet's waiting clocks move by the second; the tiles by the minute.
  const serverNow = useServerNow(floor.offset, table ? 1000 : 15000);
  const actions = useFloorActions(
    { hasPermission },
    { orderPath: ORDER_SCREEN, onChanged: () => Promise.all([floor.reload.tables(), floor.reload.orders()]) }
  );
  const requests = useRequestActions(floor);
  const serving = useServe(floor);
  const billAsk = useBillAsk(floor);

  const close = () => {
    setOpenId(null);
    actions.clearMessage();
  };

  return (
    <section className="cpt-page" aria-labelledby="cpt-title">
      <div className="cpt-page-head">
        <h1 id="cpt-title">{floor.onlyMine ? "My tables" : "Tables"}</h1>
        <MineSwitch />
      </div>

      <ErrorMessage message={floor.errors.tables} />

      {floor.tables ? (
        <TableGrid
          tables={floor.shown}
          joinedBy={null}
          now={serverNow}
          currency={floor.currency}
          choose={(row) => setOpenId(row.id)}
          reasonOff={(row, info) => (info.state === "off" ? "Out of service" : null)}
          compact
          marks={(row) => marksOf(row, floor.waiting.get(String(row.id)), { now: serverNow, passMinutes: floor.pass.passMinutes })}
          money={floor.can.money}
          className="cpt-tables"
        />
      ) : (
        !floor.errors.tables && <Loading label="Reading the tables…" />
      )}

      {table && (
        <TableSheet
          table={table}
          waiting={floor.waiting.get(String(table.id))}
          floor={floor}
          actions={actions}
          requests={requests}
          serving={serving}
          billAsk={billAsk}
          now={serverNow}
          canBill={hasPermission("billing.manage")}
          onClose={close}
        />
      )}
      {actions.dialogs}
      {requests.rejectDialog}
    </section>
  );
}
