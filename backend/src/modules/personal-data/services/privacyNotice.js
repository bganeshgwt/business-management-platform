// The starter privacy notice a business publishes, edits and republishes
// (Settings › Personal data): itemised and plain, as the DPDP Rules 2025 ask —
// what is collected and why, how to see, correct or erase it, how to complain,
// and whom to contact — with a short consent notice for each purpose. It
// states no period of keeping: how long tax law keeps a bill is the
// accountant's to say.

// What each kind of business also keeps, beyond a name and a number.
const KEPT = {
  restaurant: 'Your address and landmark when you order for delivery, and what you tell us about allergies, so the kitchen knows.',
  healthcare: 'Your health information, under the clinic\'s own consent for treatment and medical records, which the front desk takes with its notice.',
  pharmacy: 'The prescription for a medicine that needs one, as the pharmacy registers ask.',
  memberships: 'Your membership, your fees and the days you check in.',
  laundry: 'Your garment orders, with what we noted on each garment.',
  rentals: 'At the handover, the photo ID you show (of an Aadhaar only the last four digits) and, for a self-drive vehicle, your driving licence.',
  lodging: 'For each guest at check-in, the photo ID seen (of an Aadhaar only the last four digits), and for a foreign guest the passport and visa details the police ask for.',
  jewellery: 'Your PAN or your declaration on a bill over ₹2,00,000 and on old gold you sell us, with the photo ID shown, as the law asks.',
  garage: 'Your vehicles, their registration numbers and their service history.',
  optical: 'Your eye tests and prescriptions.',
  agri_inputs: 'Your village, and the crops you buy for.',
  fuel_station: 'Your fleet\'s vehicles and their fills.',
  electronics: 'For a repair, the device and what you tell us about it.',
  salon: 'Your visits, the services you have, and notes you agree we keep (allergies, colour formulas).',
};

const contactLine = ({ contactName, contactPhone, contactEmail }) => [contactName, contactPhone, contactEmail].filter(Boolean).join(', ');

// The starter text for a business: { notice, billsText, remindersText, offersText }.
function starter({ name, type, contactName, contactPhone, contactEmail }) {
  const extra = KEPT[type];
  const notice = [
    `${name}: how we use your personal data`,
    '',
    'What we collect, and why',
    '- Your name and mobile number: to make your bill, keep your account with us (dues, advances, points) and reach you about what you ask us for. Giving a mobile number is never a condition of a sale.',
    '- Your address, when you give it: for a delivery, or a tax invoice that needs it.',
    ...(extra ? [`- ${extra}`] : []),
    '- Your bills: kept as tax law requires.',
    '',
    'What we send you, only if you say yes',
    '- Your bills on WhatsApp or SMS.',
    '- Reminders of dues, appointments, renewals and service due, on WhatsApp, SMS or a call.',
    '- Offers. We never send offers to a child.',
    'You can say yes or no to each one, and change your mind at any time: tell us at the counter or on the phone.',
    '',
    'Children',
    '- For a child, a parent or guardian gives consent for them.',
    '',
    'Your rights',
    '- Ask us to show you the data we hold about you, to correct it, or to erase it. We answer within 90 days.',
    '- Bills and other tax records stay as the law requires, even after an erasure.',
    '- Complain to us first. If you are not satisfied, you may complain to the Data Protection Board.',
    '',
    `Contact for personal data: ${contactLine({ contactName, contactPhone, contactEmail }) || name}`,
  ].join('\n');
  return {
    notice,
    billsText: 'Send my bills on WhatsApp or SMS to the number I give. Say no and you get your bill on paper.',
    remindersText: 'Remind me of dues, appointments, renewals and service due, on WhatsApp, SMS or a call. I can stop them at any time.',
    offersText: 'Send me offers on WhatsApp or SMS. I can stop them at any time. Offers are never sent to a child.',
  };
}

// The one line a bill or receipt prints: "Your data: <name>, <phone>, <email>".
const printLine = (row) => (row ? `Your personal data: ${contactLine({ contactName: row.contact_name, contactPhone: row.contact_phone, contactEmail: row.contact_email })}` : null);

module.exports = { starter, printLine, contactLine };
