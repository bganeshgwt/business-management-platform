import PageHeader from "../../../../components/PageHeader";
import Icon from "../../../../components/Icon";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import "../styles/deliveries.css";
import RiderCashTab from "./RiderCashTab";
import BoardTab from "./BoardTab";
import ChannelsTab from "./ChannelsTab";
import ReportTab from "./ReportTab";

// ---------------------------------------------------------------- page

export default function DeliveriesPage() {
  const { hasPermission } = useAuth();
  // The channel report is takings (gross, commission, net): it needs the
  // sales figures permission as well as reports, as on the server.
  const canReport = hasPermission("reports.view") && hasPermission("sales.view");
  // Rider cash (SW-A-19): for whoever takes payments.
  const canSettle = hasPermission("payments.manage");
  const [tab, setTab] = useQueryFilter("tab", "board");

  const tabs = [
    { key: "board", label: "Live board", icon: "grid" },
    { key: "channels", label: "Channels", icon: "store" },
    ...(canSettle ? [{ key: "riders", label: "Rider cash", icon: "cash" }] : []),
    ...(canReport ? [{ key: "report", label: "Channel report", icon: "chart" }] : []),
  ];

  const active = tabs.some((item) => item.key === tab) ? tab : "board";

  return (
    <div className="dlv stack">
      <PageHeader
        icon="scooter"
        title="Deliveries"
        description="Every delivery from the pass to the door: your own riders, Swiggy, Zomato, phone and website orders."
        action={
          <div className="segmented dlv-tabs" role="tablist" aria-label="Deliveries views">
            {tabs.map((item) => (
              <button
                type="button"
                key={item.key}
                role="tab"
                aria-selected={active === item.key}
                className={`segment ${active === item.key ? "is-active" : ""}`}
                onClick={() => setTab(item.key)}
              >
                <Icon name={item.icon} size={15} /> {item.label}
              </button>
            ))}
          </div>
        }
      />

      {active === "board" && <BoardTab />}
      {active === "channels" && <ChannelsTab />}
      {active === "riders" && <RiderCashTab />}
      {active === "report" && <ReportTab />}
    </div>
  );
}
