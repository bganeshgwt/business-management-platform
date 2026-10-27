import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import PageHeader from "../../../components/PageHeader";
import ContentTabs from "../../../components/ContentTabs";
import RequestsTab from "./RequestsTab";
import BreachesTab from "./BreachesTab";
import NoticeTab from "./NoticeTab";
import "../styles/personal-data.css";

// Personal data (DPDP Act 2023 and Rules 2025), the same for a shop and a
// restaurant: the requests register, the breach register, and the privacy
// notice with its contact. The tab and an open record live in the address
// (?tab=requests&request=12), so the bell's links land on them.

const TABS = [
  { value: "requests", label: "Requests" },
  { value: "breaches", label: "Breaches" },
  { value: "notice", label: "Notice & contact" },
];

export default function PrivacyView({ privacy }) {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.value === params.get("tab")) ? params.get("tab") : "requests";
  const go = useCallback((next) => setParams((p) => {
    const out = new URLSearchParams(p);
    for (const [name, value] of Object.entries(next)) {
      if (value === null || value === undefined || value === "") out.delete(name);
      else out.set(name, String(value));
    }
    return out;
  }), [setParams]);
  const openRequest = useCallback((id) => go({ request: id }), [go]);
  const openBreach = useCallback((id) => go({ breach: id }), [go]);
  const words = privacy.api.person;

  return (
    <div className="stack">
      <PageHeader icon="shield" title="Personal data"
        description={`The privacy notice and contact your ${words.many} are shown, their requests to see, correct or erase their data (answered within 90 days), and the breach register. Consent for bills, reminders and offers is taken where a ${words.one} is taken.`} />
      <ContentTabs label="Personal data" value={tab} options={TABS} onChange={(value) => go({ tab: value, request: null, breach: null })}>
        {tab === "requests" && <RequestsTab privacy={privacy} openId={params.get("request")} onOpen={openRequest} />}
        {tab === "breaches" && <BreachesTab privacy={privacy} openId={params.get("breach")} onOpen={openBreach} />}
        {tab === "notice" && <NoticeTab privacy={privacy} />}
      </ContentTabs>
    </div>
  );
}
