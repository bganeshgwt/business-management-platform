import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import ActionMenu from "../../../../components/ActionMenu";
import Icon from "@bmp/ui/Icon";
import { businessRead } from "../../../../services/business.service";
import { getErrorMessage } from "../../../../services/api";
import { businessPath } from "../../../../services/businessNav";
import { toast } from "../../../../services/toast";
import { NewBatchDialog } from "./ProcessingPage";
import "../styles/weight.css";

// Quick bill's tools for a meat or weight shop, kept here so
// the shared counter only mounts them:
//  - Cut to order: a whole bird or fish cut in front of the customer. The
//    cutting batch is posted at once (the whole item leaves stock, the cut
//    comes in), then the cut is added to the bill at its weighed weight from
//    that batch. If the bill is not taken, the cut stays in stock.
//  - Orders for pickup: ?pickup=<id> fills the bill with the order's items
//    (weights, or "₹200 worth" turned into a weight at today's rate) and
//    its customer, and hands the order to the counter (onPickup): its bill
//    carries the order, which the server closes with it, its advance paying
//    first.
// toolsRef.current.posted(documentId) is called by the counter after a bill,
// and toolsRef.current.cancel() when it starts another.
export default function CounterWeightTools({ biz, locationId, onAdd, onCustomer, onPickup, toolsRef, additionalActions = [] }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [cutting, setCutting] = useState(false);
  const [pickup, setPickup] = useState(null);
  const loaded = useRef(null);
  const canCut = biz.has("processing") && biz.can("processing.create");

  // Fill the bill from an order for pickup, once.
  useEffect(() => {
    const id = params.get("pickup");
    if (!id || loaded.current === id || !locationId) return;
    loaded.current = id;
    (async () => {
      try {
        const page = await businessRead(biz.id, "weight/pickup-orders", { id, limit: 1 });
        const order = page.items[0];
        if (!order || !["open", "ready"].includes(order.status)) { toast.error("That order is already closed."); return; }
        for (const line of order.lines) {
          const found = await businessRead(biz.id, "retail/scan", { code: line.code, locationId });
          const shelf = biz.settings.tax_mode === "inclusive" ? Number(found.sku.price) : Number(found.sku.price) * (1 + Number(found.sku.tax_rate) / 100);
          const quantity = line.quantity ? Number(line.quantity) : shelf > 0 ? Math.round((Number(line.amount) / shelf) * 1000) / 1000 : null;
          onAdd({ ...found, quantity: quantity ? String(quantity) : null, fromOrder: true });
        }
        if (order.contact_id) {
          const contacts = await businessRead(biz.id, "contacts", { kind: "customer", q: order.customer_name, limit: 20 });
          const contact = contacts.items.find((c) => String(c.id) === String(order.contact_id));
          if (contact) onCustomer(contact);
        }
        setPickup(order);
        toast.info(`${order.customer_name}'s order is on the bill. Weigh each item and check the weights.${Number(order.advance_left) > 0
          ? ` Its advance of ${biz.exact(order.advance_left)} comes off the bill.` : ""}`, { duration: 6000 });
      } catch (err) {
        toast.error(getErrorMessage(err));
      } finally {
        setParams((p) => { const next = new URLSearchParams(p); next.delete("pickup"); return next; }, { replace: true });
      }
    })();
  }, [biz, locationId, onAdd, onCustomer, params, setParams]);

  // The counter bills the order with it on the bill.
  useEffect(() => {
    onPickup?.(pickup);
  }, [pickup, onPickup]);

  // After the counter takes the bill: the server closed the order with it.
  useEffect(() => {
    if (!toolsRef) return undefined;
    toolsRef.current = {
      posted: () => {
        if (!pickup) return;
        toast.success(`${pickup.customer_name}'s order is collected.`);
        setPickup(null);
      },
      cancel: () => setPickup(null),
    };
    return () => { toolsRef.current = null; };
  }, [pickup, toolsRef]);

  const added = async (batch) => {
    setCutting(false);
    for (const out of batch.outputs || []) {
      try {
        const found = await businessRead(biz.id, "retail/scan", { code: out.code, locationId });
        // The cut's own batch first, so the bill sells exactly what was cut.
        const lots = [...(found.lots || [])].sort((a, b) => Number(b.lot_code === out.lotCode) - Number(a.lot_code === out.lotCode));
        onAdd({ ...found, lots, quantity: out.quantity, fromOrder: true });
      } catch (err) {
        toast.error(getErrorMessage(err));
      }
    }
    toast.success(`${batch.batch_no}: cut and on the bill.`);
  };

  return (
    <>
      {pickup && (
        <span className="rt-pickup-chip" title="The bill closes this order when it is taken">
          <Icon name="clipboard" size={14} /> Order: {pickup.customer_name}{Number(pickup.advance_left) > 0 ? ` · advance ${biz.exact(pickup.advance_left)}` : ""}
        </span>
      )}
      <ActionMenu text="More" label="More counter actions" items={[
        ...additionalActions,
        ...(biz.can("sales.view") ? [{ label: "Pickup orders", icon: "clipboard", onClick: () => navigate(businessPath(biz.id, "pickup-orders")) }] : []),
        ...(canCut ? [{ label: "Cut to order", icon: "scale", onClick: () => setCutting(true) }] : []),
      ]} />
      {cutting && (
        <NewBatchDialog path="weight/cut-to-order" title="Cut to order" submitLabel="Cut and add to the bill" onClose={() => setCutting(false)} onSaved={added}
          description="Weigh the whole item, cut it, weigh the cut. The cut goes on this bill; the whole item leaves stock now." />
      )}
    </>
  );
}
