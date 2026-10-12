import LogbookFollowUps from "../../logbook/pages/LogbookFollowUps";
import { usePanelClick } from "./panels/panelContext";

// The log book card on the dashboard: its button opens the follow-ups in the
// dashboard's panel (and stays a link to the log book for a new tab).
export default function DashboardLogbook({ handover }) {
  const onOpen = usePanelClick("logbook");

  return <LogbookFollowUps handover={handover} onOpen={onOpen} />;
}
