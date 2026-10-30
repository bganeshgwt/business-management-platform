import PlannedPage from "../../../layouts/PlannedPage";

// The platform's home page (/welcome), where a visitor at the bare address
// lands: what the platform does and for which businesses, how its pricing
// works, and the ways in: a free trial, signing in, or a call back.
const PLAN = {
  title: "The platform's home page",
  icon: "home",
  lead: "What the platform does, the businesses it serves, and how to start using it.",
  coming: [
    "What the platform does for restaurants, shops, clinics and the other businesses it serves",
    "How its pricing works, with today's prices and the free trial",
    "Start a free trial, sign in, or ask us to call you back",
  ],
  today: "A business already on the platform signs in to work.",
  links: [{ to: "/login", label: "Sign in", icon: "login" }],
};

export default function WelcomePage() {
  return (
    <main className="page-center">
      <PlannedPage plan={PLAN} />
    </main>
  );
}
