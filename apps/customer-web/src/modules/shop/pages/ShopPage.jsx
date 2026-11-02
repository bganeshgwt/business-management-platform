import { useEffect, useState } from "react";
import { Link, Route, Routes } from "react-router-dom";
import Icon from "@bmp/ui/Icon";
import { money } from "@bmp/shared/format";
import { GuestEmpty } from "../../../shared/GuestStates";
import { myOrders } from "../services/shopCart";
import ShopHome from "./ShopHome";
import ShopCart from "./ShopCart";
import ShopCheckout from "./ShopCheckout";
import ShopStatus from "./ShopStatus";
import "../../../styles/guest.css";
import "../styles/shop.css";

// A shop's online shop on the guests' site (docs/ARCHITECTURE.md › Build a
// guest page for a business). Public, no login:
//   /shop                        the orders placed from this phone
//   /shop/<link>                 the shop: search, categories, every item
//   /shop/<link>/cart            the cart, checked with the shop
//   /shop/<link>/checkout        pickup or delivery, details, paying, consents
//   /shop/status/<guest token>   one order, live, with what the guest may still do
export default function ShopPage() {
  return (
    <Routes>
      <Route index element={<MyOrders />} />
      <Route path="status/:guestToken" element={<ShopStatus />} />
      <Route path=":token" element={<ShopHome />} />
      <Route path=":token/cart" element={<ShopCart />} />
      <Route path=":token/checkout" element={<ShopCheckout />} />
      <Route path="*" element={<Incomplete />} />
    </Routes>
  );
}

const STATUS = { placed: "Waiting for the shop", accepted: "Accepted", packed: "Packed", ready: "Ready for pickup", out_for_delivery: "Out for delivery",
  completed: "Done", declined: "Declined", cancelled: "Cancelled" };

// The orders this phone placed (kept on it for 60 days), newest first.
function MyOrders() {
  const [list] = useState(() => myOrders());
  useEffect(() => { document.title = "Your orders"; }, []);
  return (
    <main className="guest-app sp-page">
      <div className="sp-mine">
        <h1 className="sp-title"><Icon name="receipt" size={22} /> Your orders</h1>
        {list.length === 0 ? (
          <GuestEmpty heading="h2" icon="store" title="No orders on this phone yet">
            Open the shop link a shop sent you to order for pickup or delivery. Each order you place shows here, with where it has got to.
          </GuestEmpty>
        ) : (
          <ul className="sp-mine-list">
            {list.map((entry) => (
              <li key={entry.guestToken}>
                <Link to={`/shop/status/${entry.guestToken}`}>
                  <span className="sp-mine-shop"><strong>{entry.shopName}</strong><small>Order {entry.orderNo} · {new Date(entry.placedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</small></span>
                  <span className="sp-mine-side"><strong>{money(entry.total)}</strong>{entry.status && <small>{STATUS[entry.status] || ""}</small>}</span>
                  <Icon name="chevron-right" size={18} />
                </Link>
              </li>
            ))}
          </ul>
        )}
        <p className="sp-note-small sp-center">Kept on this phone only. Anyone who has this phone can see them.</p>
      </div>
    </main>
  );
}

function Incomplete() {
  return (
    <main className="guest-app guest-center">
      <GuestEmpty heading="h1" icon="link" title="This shop link isn't complete">
        Part of the address seems to be missing. Open the link the shop sent you once more, or ask the shop for it.
      </GuestEmpty>
    </main>
  );
}
