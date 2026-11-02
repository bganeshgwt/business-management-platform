import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import QRCode from "qrcode";
import Icon from "@bmp/ui/Icon";
import SectionCard from "../../../../components/SectionCard";
import { businessOptions } from "../../../../services/business.service";
import { BusinessHeader } from "../../core/pages/ui";
import { useOpenBusiness } from "../../core/pages/hooks";
import "../../../../styles/business-trade.css";
import "../styles/field-sales.css";

// The salesperson app's page in Business Admin: its address for a
// salesperson's phone (with a QR code to scan), and what makes it work —
// the Salesperson role, a salesperson linked to each login, shops on beats
// with their days. The menu's link opens the app itself (/sales/<id>).
export default function SalespersonAppPage() {
  const biz = useOpenBusiness();
  const address = `${window.location.origin}/sales/${biz.id}`;
  const [qr, setQr] = useState("");
  const [people, setPeople] = useState(null);
  const canSee = biz.can("sales_orders.view");
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(address, { width: 220, margin: 1, errorCorrectionLevel: "M" }).then((url) => alive && setQr(url)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [address]);
  useEffect(() => {
    if (!canSee) return undefined;
    const controller = new AbortController();
    businessOptions(biz.id, "salespeople", controller.signal, { active: true }).then(setPeople).catch(() => setPeople([]));
    return () => controller.abort();
  }, [biz.id, canSee]);
  const linked = (people || []).filter((p) => p.user_id).length;

  return (
    <div className="stack">
      <BusinessHeader icon="scooter" title="Salesperson app"
        description="Your salespeople's phones on the beat: their shops in visit order, orders at each shop's prices, collections and new shops, with or without the network."
        actions={<Link className="button" to={`/sales/${biz.id}`}><Icon name="external" size={15} /> Open the app</Link>} />
      <div className="bz-two">
        <SectionCard icon="qr" title="On a salesperson's phone" description="Scan this, or type the address, in Chrome on their phone; then Install from the app's ⋯ menu (on an iPhone: Share, then Add to Home Screen).">
          <div className="fs-launch">
            {qr ? <img src={qr} width={220} height={220} alt={`QR code for ${address}`} /> : <span className="muted">Drawing the code…</span>}
            <code>{address}</code>
          </div>
        </SectionCard>
        <SectionCard icon="check" title="What it needs" description="Each step once; the app then works offline through the day.">
          <ol className="fs-steps">
            <li>Give each salesperson a login with the <strong>Salesperson</strong> role in <Link to={`/business-admin/${biz.id}/staff`}>Staff &amp; access</Link>.</li>
            <li>Add them under <Link to={`/business-admin/${biz.id}/routes`}>Routes &amp; salespeople</Link> and link each to their login{people ? ` (${linked} of ${people.length} linked)` : ""}.</li>
            <li>Put their shops on beats, each beat on the day it is visited, and set the visit order on the Beats tab.</li>
            <li>Watch their day under <Link to={`/business-admin/${biz.id}/field-sales`}>Field sales</Link>: visits, orders, collections, new shops to approve.</li>
          </ol>
        </SectionCard>
      </div>
    </div>
  );
}
