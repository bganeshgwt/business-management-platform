# Plan: turning demo businesses into real ones

Status: **ready, not started** (decision deferred, 15 Oct 2026). Nothing has been changed yet.

## Today

The 11 realistic shops are **demo businesses** (`businesses.is_demo = true`):
Sri Lakshmi Kirana, Sai Annapurna Super Bazaar, Sahyadri FMCG Distributors,
Rangoli Silks & Fashions, Sri Venkateswara Mobiles & Electronics, Glow & Grace
Salon & Spa, Al-Noor Fresh Chicken, Gupta Dry Fruits, Vidya Book House,
Sri Sai Medicals, Sanjeevani Family Clinic.

What the demo mark does:

| Where | Effect of `is_demo = true` |
|---|---|
| `businessAccess.service.js` (load) | Visible only when `MULTI_BUSINESS_DEVELOPMENT=true`; hidden on a live server |
| `scripts/realistic/base.js:49` | `npm run demo:today` writes only into demo businesses; it refuses a real one |
| `scripts/demo-business-tools.js` | Demo tools are switched on only for demos |
| `scripts/seed-tasks.js`, `setup-business-demos.js` | Sample data only for demos |
| Business Admin cards | A demo's name shows its owner after " — " |

## The choice (decide before doing anything)

| Option | What happens | Good for |
|---|---|---|
| **A. Keep them as demos** (recommended) | No change. `demo:today` keeps refreshing them. Real customers' shops are created with **Add a business** or the platform console. | Showing, testing, training |
| **B. Make all 11 real** | They appear everywhere like real shops. `demo:today` stops refreshing them. Their months of **sample** sales, customers and GSTINs stay in their books. | Only if they are the actual shops to run |
| **C. Make some real** | As B, for the shops named only. | One shop going live |
| **D. Fresh real businesses** | Demos stay; new, empty real businesses of the needed types are created for real work. | Going live with clean books |

For a business that will be used for real, **D is the safe way**: real books
should not start with sample sales, sample customers or sample GSTINs.

## Steps, when decided

### Option B or C: remove the demo mark

1. Back up: `npm run db:backup -- --verify` (in `backend`).
2. List the businesses and confirm the names and ids with the owner.
3. For each one, in one transaction:
   - `UPDATE businesses SET is_demo = false WHERE id = $1 AND is_demo`;
   - write an audit row (`business.demo.converted`, who and when);
   - replace sample GSTINs, addresses and phone numbers in Business settings
     and on each branch with the real ones (the owner's details).
4. Decide about the sample history: keep it (marked in the audit log), or
   start clean by choosing option D instead. Posted bills and payments cannot
   be deleted (by design), so "clean" means a new business.
5. Remove the converted shops from `scripts/realistic/` definitions, or
   `demo:today` will report "Business code … is already used by someone else".
6. Check the staff logins in `backend/.local/realistic-demo-logins.json`:
   reset every password, and give real staff their own accounts.
7. Run the integration suite and open each converted shop once.

### Option D: fresh real businesses

1. **Add a business** (owner) or the platform console (platform admin) for each type needed.
2. Owner fills **Business settings** (legal name, GSTIN, address), **Locations**,
   **Payment methods**, **Tax rates**, and switches on the **Business tools**
   (Recommended ones are marked).
3. Staff accounts from **Staff & access** (new logins, each tied to a branch).
4. Import products and opening stock (Products › Import).
5. Demos stay for training and showing.

## Related, later

- Subscriptions (`platform_plans`, `platform_plan_modules`, `business_subscriptions`)
  apply to real businesses only; demos never need a plan.
- On a live server keep `MULTI_BUSINESS_DEVELOPMENT=false`, so demos never show.
