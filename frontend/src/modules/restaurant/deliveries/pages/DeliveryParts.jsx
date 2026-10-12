// The guest phone and channel badge shared by the delivery screens.

import { useState } from "react";
import Icon from "../../../../components/Icon";
import { getDelivery } from "../services/delivery.service";
import { digitsOf } from "./deliveryFormat";

// The guest's number on a card. Staff who may not see guests' full numbers
// get the last four digits ("XXXXXX0491"), on every card: a day's board is
// otherwise a list of every customer's number. The one delivery that needs a
// call (the gate is locked, the address is wrong) is opened with Call, which
// reads that delivery alone and shows its number to dial.
export function GuestPhone({ delivery }) {
  const [shown, setShown] = useState(null);
  const [state, setState] = useState("idle");
  const mobile = delivery.customerMobile;

  if (!mobile) {
    return <span className="muted small">no phone</span>;
  }

  const full = shown || (/X/.test(mobile) ? null : mobile);

  if (full) {
    return (
      <a className="dlv-tel" href={`tel:${digitsOf(full)}`}>
        <Icon name="phone" size={13} /> {full}
      </a>
    );
  }

  const reveal = () => {
    setState("reading");
    getDelivery(delivery.id)
      .then((one) => {
        setShown(one.customerMobile || null);
        setState(one.customerMobile && !/X/.test(one.customerMobile) ? "idle" : "failed");
      })
      .catch(() => setState("failed"));
  };

  return (
    <span className="dlv-tel dlv-tel-masked">
      <Icon name="phone" size={13} /> {mobile}
      <button
        type="button"
        className="link-button dlv-call"
        onClick={reveal}
        disabled={state === "reading"}
        title={`Show ${delivery.customerName || "the guest"}'s number to call`}
      >
        {state === "reading" ? "Reading…" : state === "failed" ? "Try again" : "Call"}
      </button>
    </span>
  );
}

export function ChannelBadge({ channel }) {
  if (!channel) {
    return <span className="dlv-channel sw-none">No channel</span>;
  }

  return (
    <span className={`dlv-channel sw-${channel.color}`}>
      <i aria-hidden="true" />
      {channel.name}
    </span>
  );
}
