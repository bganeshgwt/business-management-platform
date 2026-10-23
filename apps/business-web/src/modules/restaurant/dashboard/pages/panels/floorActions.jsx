import { useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { markTableReady } from "../../../tables/services/table.service";
import { getBill } from "../../../billing/services/bill.service";
import { markReservationNoShow, seatReservation } from "../../../reservations/services/reservation.service";
import { printCountedBill } from "../../../orders/services/billPrint";
import { settingsQuery } from "../../../setup/services/restaurant.service";
import CancelOrderDialog from "../../../orders/pages/CancelOrderDialog";
import { getErrorMessage } from "../../../../../services/api";
import { toast } from "../../../../../services/toast";
import useConfirm from "../../../../../hooks/useConfirm";
import { useBillDialog } from "./useBillDialog";
import { refreshDashboard } from "./panelData";

// What a manager can do with a table straight from the dashboard, by the
// state the floor plan gives it (GET /tables floorState). Each action is
// offered only to someone whose role allows it, by the same permissions the
// API checks:
//
//   free         Start order                      POS (orders.create)
//   eating       Open order · Bill                POS (orders.create; Bill: billing.manage)
//                Cancel order (left open from an earlier day; orders.manage, PIN rules as ever)
//   bill printed Take payment (payments.manage) · Reprint (PIN for a second copy) · Open order
//   paid         Open order
//   cleaning     Mark ready                       (tables.manage or orders.create)
//   held         Seat booking (reservations.manage + orders.create) · Seat walk-in · No-show
//   out of use   Switch on                        Tables screen (tables.manage)
//
// The first action of each list is the row's own: clicking the row does it.

export function useFloorActions(ctx) {
  const { hasPermission } = ctx;
  const navigate = useNavigate();
  const settings = useQuery(settingsQuery());
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const confirm = useConfirm();
  const [cancelling, setCancelling] = useState(null);
  const bills = useBillDialog();

  const can = {
    order: hasPermission("orders.create"),
    bill: hasPermission("orders.create") && hasPermission("billing.manage"),
    pay: hasPermission("payments.manage"),
    print: hasPermission("orders.view"),
    ready: hasPermission("tables.view") && (hasPermission("tables.manage") || hasPermission("orders.create")),
    seat: hasPermission("reservations.manage") && hasPermission("orders.create"),
    booking: hasPermission("reservations.manage"),
    cancel: hasPermission("orders.manage"),
    setup: hasPermission("tables.manage"),
  };

  const run = async (key, work) => {
    setBusy(key);
    setMessage(null);

    try {
      await work();
    } catch (err) {
      if (!err || !err.approvalCancelled) {
        setMessage({ tone: "error", text: getErrorMessage(err) });
      }
    } finally {
      setBusy(null);
    }
  };

  const ready = (table) =>
    run(`ready-${table.id}`, async () => {
      await markTableReady(table.id);
      toast.success(`Table ${table.tableNo} is ready for the next party.`);
      await refreshDashboard();
    });

  const reprint = (table) =>
    run(`print-${table.id}`, async () => {
      const bill = await getBill(table.live.billId);
      const currency = (settings.data && settings.data.currencySymbol) || "₹";
      await printCountedBill(bill, { settings: settings.data, currency });
      toast.success(`Bill ${bill.billNumber} sent to the printer.`);
    });

  const seat = (table) =>
    run(`seat-${table.id}`, async () => {
      const result = await seatReservation(table.booking.id, {});
      await refreshDashboard();
      const order = result.data && result.data.order;

      if (order && order.id) {
        navigate(`/pos?order=${order.id}`);
      } else {
        toast.success(result.message || "Seated.");
      }
    });

  const noShow = async (table) => {
    const sure = await confirm({
      title: `${table.booking.guestName || "The guest"} did not come?`,
      message: `The booking is marked as a no-show and table ${table.tableNo} is free for walk-ins.`,
      confirmLabel: "Mark no-show",
      cancelLabel: "Keep the booking",
    });

    if (sure) {
      run(`noshow-${table.id}`, async () => {
        await markReservationNoShow(table.booking.id);
        toast.success(`Booking marked as a no-show. Table ${table.tableNo} is free.`);
        await refreshDashboard();
      });
    }
  };

  // The actions for one table, the row's own first.
  const actionsFor = (table) => {
    const live = table.live;
    const state = table.floorState || "free";
    const list = [];
    const add = (allowed, action) => {
      if (allowed) {
        list.push(action);
      }
    };
    const openOrder = live && can.order && {
      key: "open",
      label: "Open order",
      onClick: () => navigate(`/pos?order=${live.orderId}`),
    };

    if (state === "free") {
      add(can.order, { key: "start", label: "Start order", primary: true, onClick: () => navigate(`/pos?table=${table.id}`) });
    } else if (state === "running") {
      if (live.earlierDay && can.bill && !live.joinedTo) {
        list.push({ key: "bill", label: "Bill", primary: true, onClick: () => navigate(`/pos?order=${live.orderId}&bill=1`) });
        add(openOrder, openOrder);
      } else {
        add(openOrder, { ...openOrder, primary: true });
        add(can.bill && !live.joinedTo, { key: "bill", label: "Bill", onClick: () => navigate(`/pos?order=${live.orderId}&bill=1`) });
      }

      add(live.earlierDay && can.cancel && !live.billId && !live.joinedTo, {
          key: "cancel",
          label: "Cancel order",
          danger: true,
          onClick: () =>
            setCancelling({ id: live.orderId, orderNumber: live.orderNumber, tableNo: table.tableNo, earlierDay: true }),
        });
    } else if (state === "printed") {
      add(live.billId, {
          key: "pay",
          label: can.pay ? "Take payment" : "Open bill",
          primary: true,
          onClick: () => bills.open(live.billId),
        });
      add(live.billId && can.print, { key: "print", label: "Reprint", onClick: () => reprint(table) });
      add(openOrder, openOrder);
    } else if (state === "paid") {
      add(openOrder, { ...openOrder, primary: true });
    } else if (state === "cleaning") {
      add(can.ready, { key: "ready", label: "Mark ready", primary: true, onClick: () => ready(table) });
    } else if (state === "reserved") {
      if (table.booking) {
        add(can.seat, { key: "seat", label: "Seat booking", primary: true, onClick: () => seat(table) });
        add(can.booking, { key: "noshow", label: "No-show", onClick: () => noShow(table) });
      }

      add(can.order, { key: "walkin", label: "Seat walk-in", primary: list.length === 0, onClick: () => navigate(`/pos?table=${table.id}`) });
    } else if (state === "out_of_service") {
      add(can.setup, { key: "setup", label: "Switch on", onClick: () => navigate("/tables") });
    }

    return list;
  };

  const dialogs = (
    <>
      {bills.dialog}
      {cancelling &&
        createPortal(
          <CancelOrderDialog
            order={cancelling}
            onClose={() => setCancelling(null)}
            onCancelled={(updated, slipNote) => {
              setCancelling(null);
              toast.success(`${updated ? updated.orderNumber : "The order"} was cancelled.${slipNote ? ` ${slipNote}` : ""}`);
              refreshDashboard();
            }}
          />,
          document.body
        )}
    </>
  );

  return {
    actionsFor,
    busy,
    message: message || (bills.error ? { tone: "error", text: bills.error } : null),
    clearMessage: () => {
      setMessage(null);
      bills.clearError();
    },
    dialogs,
  };
}
