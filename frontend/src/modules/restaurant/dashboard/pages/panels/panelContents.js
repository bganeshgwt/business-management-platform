// Every panel body, in one module the dashboard loads only when a panel is
// first opened, so the dashboard itself stays as quick to load as before.
export { OwedBillsPanel, TodayBillsPanel } from "./BillPanels";
export { FloorPanel, RunningOrdersPanel } from "./FloorPanels";
export { DeliveriesPanel, KitchenPanel, RequestsPanel } from "./ServicePanels";
export { ReservationsPanel, StaffPanel } from "./PeoplePanels";
export { ComplaintsPanel, ExpensesPanel, LowStockPanel, PurchaseOrdersPanel, StockPanel } from "./OfficePanels";
export { AlertsPanel, BirthdaysPanel, GuestsPanel, LogbookPanel } from "./InsightPanels";
