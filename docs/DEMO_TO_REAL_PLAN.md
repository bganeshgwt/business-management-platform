# Plan: turning demo businesses into real ones

Status: **done, 21 Oct 2026, by option E (clean copies)**. All 11 demo shops
have a real twin, `LIVE-<KIND>`, with the same set-up and empty books. The
demos are unchanged and stay for training (`npm run demo:today` still
refreshes them). See *Done: clean copies* at the end.

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
| **E. Clean copies** (chosen) | Demos stay; each gets a real twin with the demo's set-up (modules, branches, roles, categories, products, prices, the type's own masters) and none of its history. | Going live with clean books, without setting up from scratch |

For a business that will be used for real, **D or E is the safe way**: real books
should not start with sample sales, sample customers or sample GSTINs.

## Steps for the other options

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
4. Add the products (**Products & services**; a new product can take its
   opening stock), or bring stock in with a purchase or a stock count. There
   is no product import for these types; the CSV imports are the restaurant's
   (menu, recipes, stock items, suppliers, guests).
5. Demos stay for training and showing.

## Related, later

- Subscriptions (`platform_plans`, `platform_plan_modules`, `business_subscriptions`)
  apply to real businesses only; demos never need a plan.
- On a live server keep `MULTI_BUSINESS_DEVELOPMENT=false`, so demos never show.

## Done: clean copies (option E, 21 Oct 2026)

Run (in `backend`, after `npm run db:backup -- --verify`):

```
npm run business:real-copies -- --owner-user-id 2            # every demo shop of user 2
npm run business:real-copies -- --owner-user-id 2 --only SALON,CLINIC
```

A shop already copied (its `LIVE-<KIND>` code is taken) is skipped, so it is
safe to run again. Code: `scripts/make-real-copies.js` and
`src/modules/business/core/services/businessClone.service.js`; test:
`tests/integration/business-clean-copy.test.js`.

**Copied:** settings, modules, branches, departments, tax rates, units,
payment methods, roles and permissions, categories, products, SKUs, pack
sizes, branch prices, offers and loyalty settings, and each type's set-up:
fashion variants and GST slabs; electronics models, financiers and kits;
book sets; the drug master; lab tests, ranges, profiles and QC materials;
doctors' fees and OPD sessions; salon services, plans and commission rules;
yield templates; wholesale price groups, schemes, salespeople, routes and
beats; task templates.

**Not copied:** bills, payments, refunds, stock and batches, customers and
suppliers, patients, visits and reports, appointments, tasks, the activity
log, staff logins, and with the logins the registered pharmacist, doctors and
pathologist who sign. GSTINs, phone numbers, e-mail, logo, licence numbers and
the lab's registration are left empty.

Result (owner: owner@foodex.com, user 2):

| Real business | Copied from | SKUs | Branches | Modules |
|---|---|---|---|---|
| LIVE-KIRANA (#42) | RD-2-KIRANA | 58 | 1 | 13 |
| LIVE-SUPERMARKET (#43) | RD-2-SUPERMARKET | 45 | 2 | 17 |
| LIVE-WHOLESALE (#44) | RD-2-WHOLESALE | 19 | 2 | 12 |
| LIVE-FASHION (#45) | RD-2-FASHION | 112 | 2 | 13 |
| LIVE-ELECTRONICS (#48) | RD-2-ELECTRONICS | 26 | 2 | 15 |
| LIVE-SALON (#49) | RD-2-SALON | 70 | 1 | 11 |
| LIVE-MEAT (#50) | RD-2-MEAT | 14 | 2 | 13 |
| LIVE-DRYFRUITS (#51) | RD-2-DRYFRUITS | 21 | 2 | 13 |
| LIVE-BOOKS (#52) | RD-2-BOOKS | 40 | 1 | 12 |
| LIVE-PHARMACY (#53) | RD-2-PHARMACY | 36 | 2 | 14 |
| LIVE-CLINIC (#54) | RD-2-CLINIC | 15 | 1 | 10 |

### Before a pilot customer uses one

1. Fill **Business settings** with the customer's details: *Name shown in the
   app* (it prints on bills), legal name, GSTIN, address, phone. The name in
   the business switcher stays the demo's: the app cannot rename a business yet.
2. On each **Location** (Settings › Locations): GSTIN and phone; close the
   branches they don't have.
3. Pharmacy (*Pharmacy settings*): drug licence numbers, and *Licences by
   branch* for a branch with its own. Clinic (*Clinic & lab settings*): the
   lab's registration.
4. **Staff & access**: the customer's own staff logins, each tied to a branch.
   Then the people who sign, chosen from those logins: the registered
   pharmacists (*Pharmacy settings*), or the doctors and the pathologist with
   their registration numbers (*Clinic & lab settings*).
5. Check prices; take in opening stock (purchase or stock count).
6. Give the customer's own login a role in **Staff & access** (Manager, or a
   role made under Roles & permissions). The Owner role is given only when a
   business is created and cannot be handed out, so the copy stays owned by
   the login that made it; handing ownership over is not in the app yet.
