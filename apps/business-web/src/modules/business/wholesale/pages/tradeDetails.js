import { useEffect, useState } from "react";
import { businessRead, businessWrite } from "../../../../services/business.service";

// A wholesale customer's trade details on the customer form:
// beat, price group, state and PIN (place of supply), contact person, PAN,
// FSSAI, trade or walk-in, never hold. Loaded with the form, saved after the
// customer is saved.
const EMPTY = { beatId: "", priceGroupId: "", contactPerson: "", stateCode: "", pinCode: "", pan: "", fssai: "", tradeType: "trade", holdExempt: false };

export function useTradeDetails(biz, contactId, enabled) {
  const [value, setValue] = useState(EMPTY);
  const [loaded, setLoaded] = useState(null);
  useEffect(() => {
    if (!enabled || !contactId) return undefined;
    const controller = new AbortController();
    businessRead(biz.id, `wholesale-customers/${contactId}`, undefined, controller.signal).then((p) => {
      const next = { beatId: p.beat?.beat_id ? String(p.beat.beat_id) : "", priceGroupId: p.price_group_id ? String(p.price_group_id) : "", contactPerson: p.contact_person || "",
        stateCode: p.state_code || "", pinCode: p.pin_code || "", pan: p.pan || "", fssai: p.fssai || "", tradeType: p.trade_type || "trade", holdExempt: Boolean(p.hold_exempt) };
      setValue(next); setLoaded(next);
    }).catch(() => {});
    return () => controller.abort();
  }, [biz.id, contactId, enabled]);
  const changed = JSON.stringify(value) !== JSON.stringify(loaded || EMPTY);
  const save = async (id) => {
    if (!enabled || (!changed && loaded)) return null;
    const body = { ...value, priceGroupId: value.priceGroupId || null, stateCode: value.stateCode || null, pinCode: value.pinCode || null, pan: value.pan || null, fssai: value.fssai || null, contactPerson: value.contactPerson || null };
    if (biz.can("sales_orders.edit")) body.beatId = value.beatId || null;
    else delete body.beatId;
    if (!biz.can("receivables.approve") && !(loaded?.holdExempt) && !value.holdExempt) delete body.holdExempt;
    return businessWrite(biz.id, `wholesale-customers/${id}`, body, "put");
  };
  return { enabled, value, set: (name) => (event) => setValue((v) => ({ ...v, [name]: event.target.type === "checkbox" ? event.target.checked : event.target.value })), save };
}
