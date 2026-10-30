import useAuth from "../hooks/useAuth";
import ChoosePin from "../modules/access/pages/ChoosePin";
import "../styles/access.css";

// In place of every screen, while this session is one a shared till opened
// with a PIN someone else set (user.pinChangeRequired): the person chooses
// their own before anything else, as the server refuses every other request
// until then. Mounted by AuthProvider, so the POS, the captain app, a shop's
// counter and every workspace get it alike. Choosing it opens the screen they
// were on afresh, as them; someone who is not that person signs out.
export default function PinChangePrompt() {
  const { user, refreshUser, logout } = useAuth();

  return (
    <div className="acc-lock" role="dialog" aria-modal="true" aria-label="Choose your own PIN">
      <div className="acc-lock-panel acc-pin-panel">
        <ChoosePin user={user} onChosen={refreshUser} onCancel={logout} cancelLabel="Not you? Sign out" />
      </div>
    </div>
  );
}
