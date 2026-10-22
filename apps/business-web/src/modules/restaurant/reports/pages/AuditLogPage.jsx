import PageHeader from "../../../../components/PageHeader";
import { EmptyState } from "../../../../components/Feedback";
import useAuth from "../../../../hooks/useAuth";
import ActivityLog from "./ActivityLog";

// Who did what, and who approved it: voids, refunds, dishes taken off orders,
// price changes, day close, salary changes, sign-in lockouts. An owner opens
// this to answer "show me every void and refund by Ravi last week".
export default function AuditLogPage() {
  const { hasPermission } = useAuth();

  // A role can reach this page (through the Roles permission on the menu)
  // without being allowed to read the log itself; say so plainly instead of
  // showing a refused request.
  if (!hasPermission("audit.view")) {
    return (
      <div className="stack">
        <PageHeader icon="history" title="Activity log" description="Who did what, when, and which manager approved it." />
        <EmptyState
          icon="lock"
          message="Reading the activity log needs its own permission"
          hint="Ask the owner to add 'Read the activity log' to your role under Users → Roles."
        />
      </div>
    );
  }

  return (
    <div className="stack">
      <PageHeader
        icon="history"
        title="Activity log"
        description="Who did what, when, and which manager approved it. Pick a person and switch on money-sensitive to check voids, refunds and discounts."
      />

      <ActivityLog />
    </div>
  );
}
