import PlannedPage from "../../../layouts/PlannedPage";

// Signing up (/signup): an owner registers themselves and their business,
// chooses a plan, and starts a free trial, signed in at once.
const PLAN = {
  title: "Start a free trial",
  icon: "user-plus",
  lead: "Register yourself and your business, choose a plan, and use it free for the trial.",
  coming: [
    "You and your business on one page: your name, mobile, email and password, and the business's name, type, city and state",
    "The plan, monthly or yearly, and the modules and applications you add, with what it comes to after the trial",
    "Your business opens at once, free for the trial, with everything its type can use",
  ],
  today: "The platform's team sets up a new business and its owner's sign-in.",
  links: [{ to: "/login", label: "Sign in", icon: "login" }],
};

export default function SignupPage() {
  return (
    <main className="page-center">
      <PlannedPage plan={PLAN} />
    </main>
  );
}
