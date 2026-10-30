import PlannedPage from "../../../layouts/PlannedPage";

// Contact (/contact): the platform company's details, its support contact
// and grievance officer, and the form to ask to be called back.
const PLAN = {
  title: "Contact us",
  icon: "phone",
  lead: "Reach the platform's team, or ask us to call you back.",
  coming: [
    "The company's name, address, phone and email",
    "The support contact and the grievance officer",
    "A form to ask us to call you back about the platform",
  ],
  today: "A business already on the platform signs in to work.",
  links: [{ to: "/login", label: "Sign in", icon: "login" }],
};

export default function ContactPage() {
  return (
    <main className="page-center">
      <PlannedPage plan={PLAN} />
    </main>
  );
}
