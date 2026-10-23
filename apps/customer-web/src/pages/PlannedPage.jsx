import Icon from "@bmp/ui/Icon";
import { PLANNED_PAGES } from "../plannedPages";
import "../styles/guest.css";
import "./pages.css";

// A guest page that is planned but not built yet (plannedPages.js): its
// address works today and says what is coming and what to do until then.
export default function PlannedPage({ page }) {
  const plan = PLANNED_PAGES[page];

  return (
    <main className="guest-app guest-center">
      <div className="g-problem">
        <span className="g-problem-mark">
          <Icon name={plan.icon} size={34} />
        </span>
        <span className="g-soon">Coming soon</span>
        <h1>{plan.title}</h1>
        <p>{plan.coming}</p>
        <p className="g-until">
          <strong>Until then,</strong> {plan.today}
        </p>
      </div>
    </main>
  );
}
