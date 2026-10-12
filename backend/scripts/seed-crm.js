#!/usr/bin/env node
//
// Guest book details for the demo restaurant: what the floor would know about
// its regulars (VIP, allergies, Jain food), the corporate guests who take a
// GST invoice in their company's name, who agreed to hear about offers, and a
// few complaints tied to the bill they were about, with what was given to put
// them right.
//
//   node scripts/seed-crm.js
//
// Works on the guests seed-demo.js and seed-guest-insights.js add, by name,
// and skips any that are not there. Safe to run again: every value is set to
// the same thing each time, and a complaint is only added once (by subject).
// It never deletes anything.
require("dotenv").config({ quiet: true });

const pool = require("../src/config/database");
const { featureOff } = require("./featureGate");
const { gstinCheckCharacter } = require("../src/utils/gstin");

const say = (message) => console.log(message);

// A GSTIN whose check character is right, from its first fourteen.
const gstin = (first14) => `${first14}${gstinCheckCharacter(first14)}`;

// Who the floor knows something about.
const GUESTS = [
  { name: "Chaitanya Raju Bhupathiraju", tags: ["vip", "corporate"], company: "Bhupathiraju Constructions Pvt Ltd", gstin: gstin("37AAHCB4417M1Z"), consent: true },
  { name: "Swapna Kanumuri", tags: ["vip"], consent: true },
  { name: "Harsha Vardhan Pinnamaneni", tags: ["vip", "family"], consent: true },
  { name: "Keerthi Sowmya Alluri", tags: ["allergy"], allergies: "Peanuts and cashew", consent: true },
  { name: "Madhavi Yerra", tags: ["jain"], consent: false },
  { name: "Vikram Aditya Gokaraju", tags: ["corporate"], company: "Gokaraju Infra Projects LLP", gstin: gstin("36AAMFG2231K1Z"), consent: false },
  { name: "Bhavani Shankar Gollapudi", tags: ["family"], consent: true },
  { name: "Tejaswini Mudunuri", tags: ["blogger"], consent: true },
  { name: "Deepika Chowdary Ravi", tags: [], consent: true },
  { name: "Sneha Latha Kakarla", tags: ["vegan"], consent: true },
  { name: "Imran Sheikh", tags: [], consent: true },
  { name: "Farhana Shaik", tags: ["allergy"], allergies: "Shellfish", consent: false },
  // seed-demo.js
  { name: "Ravi Teja Konidela", tags: ["vip"], consent: true },
  { name: "Anusha Reddy", tags: ["allergy"], allergies: "Shellfish", consent: true },
  { name: "Priya Darshini", tags: ["vegan"], consent: true },
  { name: "Abdul Rahman", tags: ["corporate"], company: "Rahman Exports", gstin: gstin("37AAKFR6612B1Z"), consent: false },
  { name: "Padmavathi Devi", tags: ["jain"], consent: false },
  { name: "Sita Mahalakshmi", tags: [], consent: true },
  { name: "Divya Bharathi", tags: [], consent: true },
];

// Complaints about a real bill of a real guest, with what they were given.
const COMPLAINTS = [
  {
    guest: "Swapna Kanumuri",
    subject: "Mutton biryani was far too salty",
    category: "food",
    priority: "medium",
    status: "resolved",
    description: "Sent back after two spoonfuls. Said it tasted of the bottom of the pot.",
    resolution: "Remade the biryani at once; the head chef came to the table and apologised.",
    compensation: { type: "replaced", value: 420, notes: "Fresh mutton biryani, the first one not charged" },
  },
  {
    guest: "Vikram Aditya Gokaraju",
    subject: "Tax invoice did not carry the company name",
    category: "billing",
    priority: "medium",
    status: "closed",
    description: "Needed a GST invoice in the company's name for the team lunch; the bill was printed as a plain receipt.",
    resolution: "Company name and GSTIN added to his guest record; invoice reprinted in the company's name.",
    compensation: { type: "apology", value: 0, notes: null },
  },
  {
    guest: "Keerthi Sowmya Alluri",
    subject: "Dessert had cashew although the captain was told of her allergy",
    category: "food",
    priority: "high",
    status: "in_progress",
    description: "Noticed before eating. Upset that the allergy she mentioned did not reach the kitchen.",
    resolution: null,
    compensation: { type: "complimentary", value: 180, notes: "Gulab jamun on the house, nut-free" },
  },
];

const findGuest = async (restaurantId, name) =>
  (
    await pool.query(
      "SELECT id, name, created_at FROM customers WHERE restaurant_id = $1 AND name = $2 AND erased_at IS NULL ORDER BY id LIMIT 1",
      [restaurantId, name]
    )
  ).rows[0] || null;

(async () => {
  const restaurant = (await pool.query("SELECT id, name FROM restaurants ORDER BY id LIMIT 1")).rows[0];

  if (!restaurant) {
    say("No restaurant to seed.");
    return;
  }

  const restaurantId = restaurant.id;

  // Nothing to seed for a feature switched off in Settings -> Features.

  if (await featureOff(pool, restaurantId, "guests")) {

    return;

  }
  const manager = (
    await pool.query(
      `SELECT u.id, u.name FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       WHERE u.restaurant_id = $1 AND u.status = 'active' AND r.code IN ('MANAGER', 'RESTAURANT_ADMIN')
       ORDER BY CASE r.code WHEN 'MANAGER' THEN 0 ELSE 1 END, u.id
       LIMIT 1`,
      [restaurantId]
    )
  ).rows[0];

  say(`Guest book details for ${restaurant.name}`);

  let tagged = 0;

  for (const guest of GUESTS) {
    const row = await findGuest(restaurantId, guest.name);

    if (!row) {
      continue;
    }

    // Consent is recorded as given on the day they signed up, by whoever
    // signed them up; a seeded "no" is simply never asked.
    await pool.query(
      `UPDATE customers
       SET tags = $3::text[],
           allergies = $4,
           company_name = COALESCE($5, company_name),
           gstin = COALESCE($6, gstin),
           marketing_opt_in = $7,
           marketing_opt_in_at = CASE WHEN $7 THEN COALESCE(marketing_opt_in_at, created_at) END,
           marketing_opt_in_by = CASE WHEN $7 THEN COALESCE(marketing_opt_in_by, created_by) END
       WHERE restaurant_id = $1 AND id = $2`,
      [restaurantId, row.id, guest.tags, guest.allergies || null, guest.company || null, guest.gstin || null, guest.consent]
    );
    tagged += 1;
  }

  say(`  ${tagged} regulars tagged, with consent and business details`);

  let logged = 0;

  for (const complaint of COMPLAINTS) {
    const guest = await findGuest(restaurantId, complaint.guest);

    if (!guest) {
      continue;
    }

    const exists = await pool.query("SELECT 1 FROM complaints WHERE restaurant_id = $1 AND subject = $2", [
      restaurantId,
      complaint.subject,
    ]);

    if (exists.rows.length) {
      continue;
    }

    // The bill it was about: the guest's latest paid bill.
    const bill = (
      await pool.query(
        `SELECT b.id, b.order_id, b.billed_at, c.mobile
         FROM bills b
         JOIN orders o ON o.id = b.order_id
         JOIN customers c ON c.id = o.customer_id
         WHERE b.restaurant_id = $1 AND o.customer_id = $2 AND b.bill_status <> 'void'
         ORDER BY b.billed_at DESC
         LIMIT 1`,
        [restaurantId, guest.id]
      )
    ).rows[0];

    await pool.query(
      `INSERT INTO complaints (restaurant_id, customer_id, customer_name, customer_mobile, subject, description,
                               category, priority, complaint_status, assigned_to, resolution, resolved_at,
                               bill_id, order_id, compensation_type, compensation_value, compensation_notes,
                               created_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::varchar, $10, $11,
               CASE WHEN $9::varchar IN ('resolved', 'closed') THEN COALESCE($16::timestamptz, NOW()) + INTERVAL '40 minutes' END,
               $12, $13, $14, $15, $17, COALESCE($16::timestamptz, NOW()) + INTERVAL '5 minutes', $10, $10)`,
      [
        restaurantId,
        guest.id,
        guest.name,
        bill ? bill.mobile : null,
        complaint.subject,
        complaint.description,
        complaint.category,
        complaint.priority,
        complaint.status,
        manager ? manager.id : null,
        complaint.resolution,
        bill ? bill.id : null,
        bill ? bill.order_id : null,
        complaint.compensation.type,
        complaint.compensation.value,
        bill ? bill.billed_at : null,
        complaint.compensation.notes,
      ]
    );
    logged += 1;
  }

  say(`  ${logged} complaints tied to their bills`);
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
