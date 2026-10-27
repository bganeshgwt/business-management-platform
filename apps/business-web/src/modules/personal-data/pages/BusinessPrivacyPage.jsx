import { useShopPrivacy } from "../usePrivacy";
import PrivacyView from "./PrivacyView";

// A shop's personal data (Settings › Personal data): its customers' requests,
// its breach register, and its privacy notice and contact.
export default function BusinessPrivacyPage() {
  return <PrivacyView privacy={useShopPrivacy()} />;
}
