import { useLocation } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import "../styles/guest.css";
import "./pages.css";

// The site's own address, or a link with part of it missing. Every page here
// opens from a restaurant's own link, so this says how to reach the right one
// instead of "Page not found".
export default function StartPage() {
  const { pathname } = useLocation();
  const bare = pathname === "/";

  return (
    <main className="guest-app guest-center">
      <div className="g-problem">
        <span className="g-problem-mark">
          <Icon name="qr" size={34} />
        </span>
        <h1>{bare ? "Order or book from your link" : "This link isn't complete"}</h1>
        <p>
          {bare
            ? "These pages open from a restaurant's own link. Scan the QR code on your table to order, or open the ordering or booking link the restaurant shared with you."
            : "Part of the address seems to be missing. Scan the QR code on your table again, or open the link the restaurant sent you once more. If it still doesn't open, please ask the staff."}
        </p>
      </div>
    </main>
  );
}
