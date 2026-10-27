import { useEffect } from "react";
import { PURPOSES } from "../personalData";
import { useConsentGate } from "../useConsentGate";

// A message link gated on its purpose: a plain link once the person agreed,
// else a button that asks them first (useConsentGate) and then opens it.
// `onSent` records what was sent. A WhatsApp link opens in a new tab; a
// phone call (tel:) in place.
//
//   <ConsentLink privacy={privacy} purpose="reminders" person={{ id, name }} href={link} onSent={record}>WhatsApp</ConsentLink>
export default function ConsentLink({ privacy, purpose, person, href, onSent, className = "chip-button", title, children }) {
  const gate = useConsentGate(privacy);
  const { want } = gate;
  useEffect(() => { want(person?.id); }, [want, person?.id]);
  const web = /^https?:/i.test(href || "");
  if (gate.allowed(purpose, person?.id) && href) {
    return <a className={className} href={href} target={web ? "_blank" : undefined} rel={web ? "noreferrer" : undefined} title={title} onClick={() => onSent?.()}>{children}</a>;
  }
  const open = async () => {
    if (await gate.ensure(purpose, person)) {
      if (href && web) window.open(href, "_blank", "noopener");
      else if (href) window.location.href = href;
      onSent?.();
    }
  };
  return (
    <>
      <button type="button" className={className} title={title || `Asks for their consent to ${PURPOSES[purpose]?.words || purpose} first`} onClick={open}>{children}</button>
      {gate.dialog}
    </>
  );
}
