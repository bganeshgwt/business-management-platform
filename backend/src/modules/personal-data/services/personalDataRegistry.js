// Where a shop's customer's personal data lives, table by table: what the
// access export shows under which heading, what an erasure blanks, and what it
// keeps and why. Every table with a foreign key to business_contacts is here
// (tests/integration/personal-data.test.js reads the database's own list of
// foreign keys and fails on one this file does not name), so a module added
// later is placed on purpose: erased, kept with its reason, not a
// customer's (a supplier's, an insurer's), or never shown to them.
//
//   label   the export's heading for the table's rows
//   erase   column -> what it becomes: null, or 'name' for the erased name
//           ("Erased customer #<id>", for a column that must hold a name)
//   keep    why the rows stay as they are (shown to staff and the accountant)
//   party   'supplier': the rows are a supplier's or an insurer's, never a customer's
//   own     this module's own record (consents, requests, breaches): kept as the record
//   secret  kept, and never in an export nor named by an erasure: the
//           suspicious transaction log, which the law forbids telling the
//           person about (the PMLA's tipping off)
//
// A table whose guard keeps closed rows as they were lets an erasure's change
// through only for these columns (business_privacy_erasing, migration
// 1791977000000_personal-data), so the two lists are kept the same.

const ERASED_NAME = 'name';

const TABLES = {
  business_documents: { label: 'Bills, invoices and credit notes', keep: 'Tax records: the buyer\'s name, GSTIN, address and PAN as billed stay on each bill, as tax law needs.' },
  business_collections: { label: 'Money received', keep: 'Receipts for money received are accounting records.' },
  business_collection_cheques: { label: 'Cheques received', keep: 'Cheques are accounting records.' },
  business_collection_refunds: { label: 'Money handed back', keep: 'Money handed back is an accounting record.' },
  business_exchanges: { label: 'Returns and exchanges', keep: 'Returns are part of the bills they change.' },
  business_exchange_vouchers: { label: 'Credit vouchers', erase: { customer_name: null, customer_phone: null } },
  business_price_rules: { label: 'Prices agreed', keep: 'A price agreed holds no personal details.' },
  business_quotations: { label: 'Quotations', erase: { customer_name: ERASED_NAME, customer_phone: null } },
  business_appointments: { label: 'Appointments', keep: 'An appointment holds no personal details beyond the erased record.' },
  business_supplier_payments: { label: 'Payments to suppliers', party: 'supplier' },
  books_customer_orders: { label: 'Book orders', erase: { customer_name: ERASED_NAME, phone: null, notes: null } },
  retail_credit_reminders: { label: 'Dues reminders sent', keep: 'A log of the reminders sent, kept at least a year as the DPDP Rules ask of processing logs.' },
  retail_loyalty_entries: { label: 'Loyalty points', keep: 'The points ledger adds up the business\'s points owed; points left are cancelled with an entry.' },
  salon_client_notes: { label: 'Salon notes and colour formulas', erase: { body: 'Erased at the customer\'s request' } },
  salon_client_plans: { label: 'Salon packages and memberships', keep: 'Packages are part of the bills that sold them.' },
  salon_client_profiles: { label: 'Salon client card', erase: { birthday: null, anniversary: null, gender: null, preferred_resource_id: null, allergies: null } },
  salon_walk_ins: { label: 'Salon walk-ins', erase: { note: null } },
  weight_pickup_orders: { label: 'Orders for pickup', erase: { customer_name: ERASED_NAME, phone: null, notes: null } },
  weight_processing_batches: { label: 'Cutting batches', party: 'supplier' },
  electronics_repair_jobs: { label: 'Repairs', erase: { customer_name: ERASED_NAME, customer_phone: null, phone_digits: null, passcode: null } },
  electronics_warranties: { label: 'Warranties', erase: { customer_name: ERASED_NAME, customer_phone: null, phone_digits: null } },
  electronics_faulty_units: { label: 'Faulty units', party: 'supplier' },
  electronics_warranty_claims: { label: 'Warranty claims', party: 'supplier' },
  agri_farmers: { label: 'Farmer details', erase: { village: 'Erased', relative_name: null, land_acres: null, crops: null, farmer_id: null, notes: null } },
  health_patients: { label: 'Patient record', keep: 'Medical records are kept for the years in Clinic & lab settings; the patient\'s details stay with them.' },
  pharmacy_prescriptions: { label: 'Prescriptions dispensed', keep: 'The pharmacy registers keep the patient on each prescription, for the years in Pharmacy settings.' },
  pharmacy_debit_notes: { label: 'Debit notes', party: 'supplier' },
  member_profiles: { label: 'Member code', keep: 'A member code holds no personal details beyond the erased record.' },
  member_memberships: { label: 'Memberships', keep: 'Memberships are part of the bills that sold them.' },
  member_checkins: { label: 'Check-ins', keep: 'A log of visits, kept at least a year as the DPDP Rules ask of processing logs.' },
  laundry_orders: { label: 'Garment orders', erase: { customer_name: ERASED_NAME, customer_phone: null, notes: null } },
  rental_bookings: { label: 'Rental bookings', erase: { customer_name: ERASED_NAME, customer_phone: null, id_kind: null, id_ref: null, licence_no: null, licence_valid_until: null, notes: null } },
  lodging_stays: { label: 'Stays', erase: { guest_name: ERASED_NAME, guest_phone: null, arrived_from: null, going_to: null, purpose: null, notes: null },
    also: 'The guest register of each stay (every occupant, with the photo ID seen) is kept, as the police ask of a lodging.' },
  jewellery_old_gold: { label: 'Old gold bought', keep: 'An old gold voucher keeps the seller\'s photo ID and PAN or declaration, as the law asks of the purchase.' },
  jewellery_schemes: { label: 'Gold schemes', erase: { member_name: ERASED_NAME, member_phone: null, nominee_name: null, nominee_relation: null } },
  jewellery_bills: { label: 'Jewellery bills', keep: 'Part of the tax invoices.' },
  fuel_vehicles: { label: 'Fleet vehicles', keep: 'The fuel bills name each vehicle filled.' },
  fuel_receipts: { label: 'Tanker receipts', party: 'supplier' },
  garage_vehicles: { label: 'Vehicles', keep: 'A vehicle\'s service history stays with the vehicle.' },
  garage_vehicle_owners: { label: 'Vehicle owners', keep: 'A vehicle\'s owners are part of its history.' },
  garage_job_cards: { label: 'Job cards', erase: { customer_name: ERASED_NAME, customer_phone: null } },
  garage_claims: { label: 'Insurance claims', party: 'supplier' },
  optical_prescriptions: { label: 'Eye tests and prescriptions', keep: 'Linked only to the erased record, they no longer say whose they are.' },
  optical_orders: { label: 'Spectacle orders', erase: { customer_name: ERASED_NAME, customer_phone: null } },
  optical_recall_reminders: { label: 'Recall reminders sent', keep: 'A log of the reminders sent, kept at least a year as the DPDP Rules ask of processing logs.' },
  optical_contact_lens_trials: { label: 'Contact-lens trials', keep: 'Contact lenses given out, with their batch: records of medical devices kept at least two years under the MD-42 registration.' },
  hardware_sites: { label: 'Sites', erase: { name: 'Site', address: null, contact_person: null, phone: null, active: false } },
  wholesale_claims: { label: 'Claims', keep: 'Trade records of the invoices they settle.' },
  wholesale_customer_beats: { label: 'Beat', keep: 'A beat holds no personal details.' },
  wholesale_customer_profiles: { label: 'Trade details', erase: { contact_person: null, pin_code: null, pan: null, fssai: null } },
  wholesale_hold_releases: { label: 'Credit hold releases', keep: 'Trade records of the orders released.' },
  wholesale_orders: { label: 'Sales orders', keep: 'Trade records of the invoices they became.' },
  wholesale_purchase_orders: { label: 'Purchase orders', party: 'supplier' },
  business_consents: { label: 'Consents', own: true },
  business_children: { label: 'Marked as a child', own: true },
  business_privacy_requests: { label: 'Requests', own: true },
  business_privacy_breach_people: { label: 'Breaches affecting them', own: true },
  business_privacy_breach_notices: { label: 'Breach notices sent', own: true },
  business_licence_sources: { label: 'Certificates of source (Form O)', party: 'supplier' },
  jewellery_karigars: { label: 'Karigars', party: 'supplier' },
  jewellery_orders: { label: 'Custom orders', keep: 'A custom order is part of the jewellery bill that delivered it, or was cancelled; it names the customer only through the erased record.' },
  jewellery_approvals: { label: 'Approval challans', keep: 'An approval challan records pieces that went out and came back or were sold; it names the customer only through the erased record.' },
  jewellery_hallmark_consignments: { label: 'Hallmarking consignments', party: 'supplier' },
  jewellery_supplier_metal: { label: 'Metal with suppliers', party: 'supplier' },
  agri_buyer_tags: { label: 'Buyer tags (pest-control operator, government body, bulk consumer)', erase: { reference: 'Erased', notes: null, active: false } },
  agri_overrides: { label: 'Managers\' overrides at the counter', keep: 'A log of what a manager allowed on a bill, with the bill it was used on.' },
  agri_season_credits: { label: 'Season credit', erase: { guarantor_name: null, guarantor_phone: null, guarantor_address: null, crop_pledged: null, notes: null },
    also: 'The season\'s terms and its bills stay: they are accounting records.' },
  agri_produce_receipts: { label: 'Produce taken against dues', keep: 'Payments received in produce are accounting records.' },
  agri_schemes: { label: 'Company schemes', party: 'supplier' },
  jewellery_refinery_challans: { label: 'Refinery challans', keep: 'A refinery challan is a trade record of metal sent to a refiner, or sold to a bullion dealer on a bill.' },
  jewellery_kyc_documents: { label: 'KYC documents', keep: 'KYC records are kept at least five years after the business with the customer ends, as the Prevention of Money-laundering Act asks of a jeweller.' },
  jewellery_kyc_owners: { label: 'Beneficial owners', keep: 'A firm\'s beneficial owners are part of its KYC, kept at least five years as the Prevention of Money-laundering Act asks.' },
  jewellery_cash_family_members: { label: 'Family group in the cash report', keep: 'The cash report adds up a family\'s cash for the Income Tax limit; the group names the customer only through the erased record.' },
  jewellery_str_cases: { label: 'Suspicious transaction log', secret: true },
  rental_hirers: { label: 'Hirer register', erase: { address: null, licence_authority: null, licence_classes: '{}', licence_issued_on: null, foreigner: false, passport_no: null,
    passport_authority: null, passport_nation: null, passport_issued_on: null, passport_valid_until: null, birth_date: null, permit_no: null, permit_issued_on: null,
    permit_classes: '{}', visa_no: null, visa_valid_until: null } },
  rental_files: { label: 'Handover and return photos and signatures', keep: 'The signed handover and return, with the photos of what was handed over and came back, are the record of the hire and of any damage charged; they stay with the booking. No copy of an ID document is kept.' },
};

// Children of the rows above that the export also shows: the lines of each bill.
const CHILDREN = {
  business_documents: [{ table: 'business_document_lines', key: 'document_id', label: 'Bill lines', columns: 'document_id,label,unit,quantity,unit_price,tax_rate,net,tax,hsn_code' }],
};

// Columns never put in an export: keys that only the program reads.
const HIDDEN = new Set(['request_key', 'request_hash', 'checkout_key', 'checkout_hash', 'checkin_key', 'checkin_hash', 'cancel_key', 'cancel_hash',
  'close_key', 'close_hash', 'credit_key', 'delivery_key', 'bill_key', 'passcode']);

// What is kept whatever the tables hold, for the record of an erasure.
const ALWAYS_KEPT = [
  'The activity log, kept at least a year as the DPDP Rules ask of processing logs.',
  'The customer\'s consents and this request, as the record.',
];

module.exports = { TABLES, CHILDREN, HIDDEN, ALWAYS_KEPT, ERASED_NAME };
