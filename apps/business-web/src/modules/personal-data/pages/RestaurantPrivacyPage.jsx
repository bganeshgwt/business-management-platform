import { useRestaurantPrivacy } from "../usePrivacy";
import PrivacyView from "./PrivacyView";

// A restaurant's personal data (Settings › Personal data): its guests'
// requests, its breach register, and its privacy notice and contact.
export default function RestaurantPrivacyPage() {
  return <PrivacyView privacy={useRestaurantPrivacy()} />;
}
