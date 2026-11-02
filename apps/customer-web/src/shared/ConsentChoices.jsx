import Icon from "@bmp/ui/Icon";
import "./shared.css";

// What a guest may agree to on a business's page (DPDP Act 2023, and the
// E-Commerce Rules' explicit consent): one box per purpose the page asks,
// each in the business's own words from its privacy notice, none ever ticked
// for the guest, and the notice a tap away. A box left unticked sends
// nothing for that purpose, and the page goes on just the same.
//
//   <ConsentChoices privacy={card.privacy} purposes={["reminders", "offers"]}
//                   value={consents} onChange={setConsents} businessName={card.name} />
//
//   privacy   the business card's privacy ({ url, billsText, remindersText,
//             offersText, contact }); null while the business has published
//             no notice: then nothing is asked (the API would refuse it)
//   purposes  which of bills_digital, reminders, offers the page asks
//   value     the purposes ticked; onChange(list) with the new list
// The page sends `value` and `privacy.id` with its booking or order.

const TEXTS = { bills_digital: "billsText", reminders: "remindersText", offers: "offersText" };

export default function ConsentChoices({ privacy, purposes = ["bills_digital", "reminders", "offers"], value = [], onChange, businessName = "" }) {
  if (!privacy) {
    return null;
  }

  const asked = purposes.filter((purpose) => TEXTS[purpose] && privacy[TEXTS[purpose]]);
  const toggle = (purpose) => onChange(value.includes(purpose) ? value.filter((one) => one !== purpose) : [...value, purpose]);

  return (
    <fieldset className="gs-consents">
      <legend>
        Messages from {businessName || "the business"} <em>optional</em>
      </legend>
      {asked.length > 0 && <p className="gs-consents-intro">Tick what you would like. Leave a box empty and nothing is sent for it.</p>}
      {asked.map((purpose) => (
        <label key={purpose} className="gs-consent">
          <input type="checkbox" checked={value.includes(purpose)} onChange={() => toggle(purpose)} />
          <span>{privacy[TEXTS[purpose]]}</span>
        </label>
      ))}
      <p className="gs-consents-notice">
        <Icon name="shield" size={15} />
        <span>
          <a href={privacy.url} target="_blank" rel="noopener noreferrer">
            Read {businessName ? `${businessName}'s` : "the"} privacy notice
          </a>
          {privacy.contact ? ` · Questions about your data: ${privacy.contact}` : ""}
        </span>
      </p>
    </fieldset>
  );
}
