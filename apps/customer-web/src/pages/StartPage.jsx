import { useLocation } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import "../styles/guest.css";
import "./pages.css";

// The site's own address, or a link with part of it missing. Every page here
// opens from a business's own link (its booking or shop link, a restaurant's
// table QR code or ordering link), so this says how to reach the right one
// instead of "Page not found". Only a table's QR code link (/order/…) speaks
// of tables: a salon's, a gym's or a clinic's guests have none.
export default function StartPage() {
  const { pathname } = useLocation();
  const bare = pathname === "/";
  const table = /^\/order(\/|$)/.test(pathname);

  return (
    <main className="guest-app guest-center">
      <div className="g-problem">
        <span className="g-problem-mark">
          <Icon name="qr" size={34} />
        </span>
        <h1>{bare ? "Order or book from your link" : "This link isn't complete"}</h1>
        <p>
          {bare
            ? "These pages open from a business's own link. Open the booking, shop or ordering link the business shared with you, or scan its QR code."
            : table
              ? "Part of the address seems to be missing. Scan the QR code on your table again, or open the link the restaurant sent you once more. If it still doesn't open, please ask the staff."
              : "Part of the address seems to be missing. Open the link the business sent you once more, or scan its QR code again. If it still doesn't open, please call the business."}
        </p>
      </div>
    </main>
  );
}
