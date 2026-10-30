import PlannedPage from "../../../layouts/PlannedPage";

// The platform's policies, one address each: its terms of service (/terms),
// its privacy policy (/privacy-policy; /privacy is a restaurant's own Personal
// data screen) and its refunds, cancellation and service delivery
// (/refunds). Each says what the platform really does.
const PLANS = {
  terms: {
    title: "Terms of service",
    icon: "file",
    lead: "The terms on which a business uses the platform.",
    coming: [
      "The free trial, paying for a plan, and when a business's access starts and ends",
      "When a plan ends: the business's records are kept, and can still be seen, printed and exported",
      "The platform as the processor of a business's customers' data, on the business's instructions",
    ],
    today: "The platform's team gives the terms that apply to your business.",
    links: [{ to: "/login", label: "Sign in", icon: "login" }],
  },
  privacy: {
    title: "Privacy policy",
    icon: "shield",
    lead: "What the platform collects about the people who sign up or ask to be called back, and why.",
    coming: [
      "What is collected at sign-up and with a request to be called back, and why",
      "How a business's customers' data is kept, for that business alone",
      "Your rights over your data, and how to reach the grievance officer",
    ],
    today: "The platform's team answers questions about your personal data.",
    links: [{ to: "/login", label: "Sign in", icon: "login" }],
  },
  refunds: {
    title: "Refunds, cancellation and service delivery",
    icon: "receipt",
    lead: "How a plan is paid for, cancelled and delivered.",
    coming: [
      "Paying for a plan by UPI or bank transfer with the payment's reference, and access from the day the payment is confirmed",
      "Cancelling: a paid period is not refunded, and runs to its end",
      "How the service is delivered: online, in the browser, for the dates paid for",
    ],
    today: "The platform's team answers questions about paying for a plan.",
    links: [{ to: "/login", label: "Sign in", icon: "login" }],
  },
};

export default function PolicyPage({ kind }) {
  return (
    <main className="page-center">
      <PlannedPage plan={PLANS[kind]} />
    </main>
  );
}
