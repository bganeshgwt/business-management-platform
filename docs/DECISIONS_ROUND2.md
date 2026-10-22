# Round 2 decisions (8 Oct 2026)

The business rules chosen while completing the admin application: one short section per decision — the rule, why, and the setting that changes it. Each builder keeps to its own section.

## Round 3: shops, clinic & lab, food formats and brands (16–21 Oct 2026)

- **Shop prices:** a branch can sell an item at its own price; without one it sells at the item's price. With Loyalty points on, a customer named on the bill pays the item's member price when that is lower. Offers still apply. Change it: the item's *Member price*; *Branch prices* on its row.
- **Coupons:** an offer with a code applies only when the cashier enters the code, with optional limits on uses in all and per customer (a per-customer limit needs the customer named). Change it: *Offers & discounts*.
- **Cashier shifts:** a cashier opens a shift at a counter with the cash in the drawer and closes it with a blind count: they type what they counted before they see what the drawer should hold (their own cash sales, collections, refunds, supplier payments and expenses there), and a difference needs a reason. Many cashiers bill at once in a supermarket, so each count is checked against that cashier's own cash. One open shift per person and counter; a closed shift never changes. Nothing to set.
- **Departments:** a top-level category belongs to one department. A person tied to a department sees and changes only its products and stock, and still bills every item, since a counter sells across departments. Change it: *Products › Categories*; *Staff & access*.
- **Free goods on a purchase:** a supplier's "10 + 1 free" comes into stock at no cost, so each unit costs the line's net (paid units at the rate, less the trade discount) divided by the whole quantity. Nothing to set.
- **Items used in services** (a salon's hair colour, a clinic's gloves) can be kept in stock and never sold: the bill screens leave them out. Change it: the item's *For use in services only, not sold*.
- **Doctors' fees:** a doctor's consultation fee is a service on the bill. Within the doctor's follow-up days of a paid consultation the patient pays the follow-up fee, or nothing when the doctor has none. The doctor's share of the fees is kept for the earnings report. Change it: *Today's patients › Doctors, fees & OPD*.
- **OPD sessions and leave:** an appointment on a doctor's leave is refused, and once the doctor has sessions, so is one outside them. A token on leave is refused too, but a patient who comes outside a session still gets one (patients come early). The sessions' patient caps limit the day's tokens. Change it: *Doctors, fees & OPD* (timings, *Add leave*).
- **Token queue:** each doctor's tokens start at 1 every day; *Priority* goes first; *Next patient* finishes the patient being seen and skips one who was called and did not come in. A patient holds one token per doctor at a time. Nothing to set.
- **A visit's branch:** a clinic visit belongs to the doctor's branch, else the branch the front desk works at, so branch staff see their own branch's visits. Nothing to set.
- **Amended lab reports:** a signed report is kept as it was signed. To correct it, the pathologist amends it with a reason and their PIN; the order reopens, and signing again makes a new version that says which one it amends. The older one prints as *superseded*. Nothing to set.
- **Lab quality control:** each run of a control is judged by the Westgard rules: 1-2s warns; 1-3s, 2-2s, R-4s, 4-1s and 10x reject. While a parameter's latest run today is rejected, patient reports with that parameter cannot be signed. Change it: *Lab orders › Quality control* (each control's target mean and SD).
- **Formats:** a restaurant is a restaurant, a café, a bakery or a cloud kitchen. The format sets the kinds of order the POS takes, the one a new order starts on, token numbers and the features it starts with (a café starts on takeaway with tokens; a bakery takes takeaway and delivery, with recipes, advances and pre-orders and no tables; a cloud kitchen starts on delivery, with online ordering, deliveries and brands and no tables). The server refuses a kind of order the POS does not take. Each setting can be changed afterwards and nothing is deleted. Change it: the owner, in *Settings › Features › Format*; *Service settings › Orders the POS takes*.
- **Pre-orders:** the advance is an ordinary customer advance, in the day's cash. On hand-over the pre-order becomes a takeaway order on today's business day, and its bill takes the advance first. A cancelled pre-order's advance stays held, to be handed back from *Dues › Advances*. Change it: the *Pre-orders & cakes* feature.
- **Day-end unsold:** what will not sell tomorrow is written off at cost as waste, with the reason "Unsold at day end"; what keeps stays in stock. Nothing to set.
- **Sold by weight:** the price is per kg and the quantity on the order is the weight; the POS asks for the grams. Change it: the dish's *Sold: by weight*.
- **Brands:** a category belongs to one brand or to all. An order is taken under one brand, and a dish from another brand's menu is refused. The KOT and the bill print the brand; the brand report takes off each order's own aggregator commission. A paused brand takes no new orders. Change it: *Menu › Brands*; the *Brands* feature.
- Schema changes are in migrations `1791950404000_retail-completion` to `1791950411000_kitchen-brands`.

## Business workspaces and daily money (14 Oct 2026)

- Related-page navigation uses shared underlined tabs in both restaurant and Business Admin screens. The active page stays visible after opening **More tools**; narrow screens have scroll controls. Native links preserve browser history and opening a page in another browser tab. Arrow keys, Home and End move focus, and Enter opens the focused page.
- Udhaar, retail reports, book orders, pharmacy stock/registers and clinic visits share in-page tabs with a named content panel and keyboard selection. Book order and health views preserve other URL filters when switching their view. Guest-book and guest-history tabs use the same underline treatment. Error messages direct users to **Business tools**, matching the actual settings section.
- The sidebar shows daily work, business operations and management. Stock, products, customer dues, reports and settings contain related pages, with less frequent tools under **More tools**. Business type, enabled modules and existing role permissions still decide what is available. Restaurant navigation uses the same grouping without changing its feature permissions.
- Tasks, issues and projects no longer appear in business menus or dashboard cards. New businesses start with optional transfers, repairs, finance, packages, commissions, laboratory work, loyalty, offers and cutting/processing switched off. Existing businesses keep their enabled tools and history. Applicable optional tools can be enabled in **Settings > Business tools**. Showcase demo setup explicitly enables its specialist examples only for the owner's demo businesses.
- *15 Oct 2026:* Tasks is one **Tasks** entry under Management again, shown only in a business that has it switched on; the Overview shows no task cards. A restaurant still starts with tasks, issues and projects on (`1791950402000_restaurant-keeps-task-defaults`). **Settings > Business tools** marks the tools most businesses of a trade use as *Recommended*, with the reason; nothing is switched on by it (`1791950403000_recommended-business-tools`). The owner's demo businesses have the team tools on only in the trades where Tasks is recommended: supermarket, pharmacy and clinic.
- Quick bill keeps billing, customer and payment together. Payment confirmation stays in a dialog; dismissing it prepares the counter for another bill. The product shelf reloads after a payment attempt and when the selling location changes. Cash, UPI, Card and Udhaar remain the visible payment choices. Barcode label selection opens a dialog rather than a section below the item list.
- **Daily expenses** records money already paid for operating costs; supplier purchases remain in Purchases. Entries require an active location, an amount with at most two decimal places and a date no later than today. Recording requires `expenses.create`; reversal requires `expenses.approve` and a reason. Entries cannot be edited or deleted. A reversal is a separate money movement on the reversal date. Expenses cannot be disabled once history exists. *15 Oct 2026:* an expense can be dated at most 30 days back, and not to a past day once the cash at that location has been counted on that day or later (it is then recorded with today's date).
- **Daily money** combines sale payments, later collections, customer refunds, supplier payments and refunds, finance payouts, expense payments/reversals and bounced cheques without counting bill allocations twice. Values on reconciliation screens show exact paise. **Net cash movement** excludes the opening drawer float; it is not a counted balance.
- **Cash check** records opening cash, cash counted, the server-calculated expected amount and the difference for one date and location. A nonzero difference needs a reason. Checks are immutable snapshots; trading can continue. Saving refreshes the displayed movements, and later changes are called out. Recording requires `reports.edit` plus access to the money and expense totals used in the calculation.
- Expense and cash-check submissions use request keys to prevent duplicate entries on retry. Location scope and permissions are checked server-side. Cash checks calculate all movements in one repeatable-read transaction. Audit entries retain who recorded or reversed a financial record.
- Schema changes are in migrations `1791950400000_business-workspaces-and-expenses` and `1791950401000_expense-and-cash-reason-guards`. Apply with `npm --prefix backend run migrate:up`. Financial integration tests use disposable databases; browser review opens and cancels financial dialogs without posting entries to demo businesses.

## Salon, weight shops & repairs

*Builder R2-SVC, 8 Oct 2026. Migration `1791620001000_salon-weight-repairs-round2`.*

### Stylist week and holidays
- **Rule:** a stylist keeps their usual hours and weekly off; a weekly schedule overrides single weekdays (a day off, or other hours). Salon holidays close the whole salon or one branch. Bookings and moves outside them, on leave, or outside the calendar hours are refused.
- **Why:** salons in India run split weeks (a short Sunday, a weekday off by rotation) and close on Diwali, Pongal or Ugadi; a per-weekday row is the least to set up.
- **Change it:** *Stylists & services › Weekly schedule* and the *Holidays* tab. Leave and holidays are refused while bookings exist on those days (move them first), as leave already was.

### Manager override of the hours
- **Rule:** new permission `appointments.approve` (manager template). A holder booking it themselves gives only a reason; anyone else needs a manager's reason and PIN. Kept in `salon_booking_overrides` and the activity log.
- **Why:** the same pattern as the wholesale credit hold; the front desk often has to fit a bride or a regular in.
- **Change it:** give or take `appointments.approve` in Roles.

### Back-bar products
- **Rule:** a service's recipe is in each product's own stock unit (ml, g). The stock leaves **when the service line is billed** (the salon bill is when a service is done), oldest use-by first, at the bill's location. If the books have less, the bill still goes through and the shortfall is recorded. Returning a service gives nothing back (the product was used). Cost = the product's **latest purchase price** before GST (owner's decision); with no purchase yet, the average cost of the stock held.
- **Why:** a counter must never be stopped by stock records; a shortfall is a stock-keeping task, shown in *Service profitability › Products used*.
- **Change it:** *Service times › Products used* (an empty recipe takes nothing).

### A client's advance: refund or wallet
- **Rule:** any receipt with money left can be refunded in cash, UPI or bank (reference needed for UPI/bank), numbered `<receipt>-R<n>`. A deposit held for a booking still to come can instead be moved to the client's wallet: it becomes ordinary advance for any bill and the booking keeps no deposit (a later no-show charges nothing from it). Both need a reason and a manager's PIN (`sales.refund`) — always a PIN, the manager's own when they do it themselves, because money leaves or protection is given up. A refund prints a receipt to sign.
- **Why:** "wallet" in a salon is the client's advance already kept on account (shared receivables), so no new wallet balance is invented.
- **Change it:** who holds `sales.refund` in Roles.

### Monthly target (slab) commission
- **Rule:** a plan has slabs on the **month's net service sales** (after discounts and returns, before GST; services only — package sessions, products and plan sales stay on the flat rules). Default *stepped*: each slab at its own rate (10% of the first ₹50,000, 12% of the rest); option *whole month at the slab reached*. Per stylist, chosen from a month (this month or later), else the flat rules. A plan's slabs never change once saved (paid months stay as they were); a new rate is a new plan. For dates that are not a whole month, a month's slab is shared by the stylist's part of that month's sales, so a mid-month payout uses the rate reached so far.
- **Why:** this is the common Indian salon incentive (a monthly target, a higher rate past it); "stepped" is the wording of the example and never pays less than the slab before.
- **Change it:** *Staff commissions › Target plans* (mode per plan, plan per stylist).

### Cut to order
- **Rule:** already built (pro pass): the whole weight leaves stock, the cuts come in and go on the bill at their own rates; the loss is the waste. Checked again; no change.

### Yield by supplier
- **Rule:** average yield = total usable kg ÷ total whole kg (weighted by weight), per supplier and whole item in the chosen dates, against the item's average over all suppliers. A batch's supplier is the one kept when it was cut, otherwise the purchase that brought its input batch in (so older batches count too). Opening stock with no purchase shows as "No purchase".
- **Why:** a weighted average is what the money sees; a simple average of batches is shown as the worst–best range.

### Repair advances
- **Rule:** the advance taken at intake (already built: on the job card, taken off the bill at delivery) can be refunded only once the job is closed — returned unrepaired, or what is left after a delivery that came to less. Cash, UPI or bank, a reason and a manager's PIN (`sales.refund`); a receipt prints. The receivables advance (`business_collections`) is reused; refunds are `business_collection_refunds` with `source = repair`.
- **Why:** while the job is open the advance belongs to the bill to come.
- **Change it:** who holds `sales.refund`.

## Wholesale & restaurant

*Builder R2-WS, 8 Oct 2026. Migration `1791620003000_wholesale-purchase-orders-challan-schemes-bounces`.*

### Free-goods schemes
- **Rule:** a scheme gives free goods of the same item ("buy 10 cases, get 1 free") or of another item ("buy 5 cases of A, get 1 case of B"), and/or a discount %. The free goods go on the order and the tax invoice as their own line at ₹0, named with the scheme ("Free · scheme name"), and leave stock at dispatch like any line (oldest expiry first). The scheme applies **after** the price is chosen (customer price, price group, case slab, list price), so by default it stacks on a slab price. A scheme marked **"Don't combine with slab price"** prices the line without quantity slabs when it applies: a slab for all customers gives way to the list price, and only a price group's base price (from 1 unit or 1 pack) is used; a customer's own negotiated price still applies. The biggest scheme the line reaches wins; one scheme per line.
- **Why:** FMCG companies run "10+1" and cross-brand schemes on top of the distributor's trade slabs, but some schemes are funded only at the base rate; the distributor must be able to say which.
- **Change it:** *Price groups & schemes › Schemes › Add a scheme* (free item, its pack, and the "Don't combine with slab prices" tick). The scheme report per retailer is *Wholesale reports › Schemes by retailer* (orders that earned it, bought and sent, free goods sent and their value at list price, discount given).

### Bounced cheques
- **Rule:** marking a cheque bounced (credit control, `receivables.approve`) reverses exactly the bill settlements that receipt made — the invoices it settled open again with those amounts — and the receipt stops counting. The bank charge is added to the retailer's account as a debit (an open item from the day it bounced, on the statement as "Bank charge for cheque …"): the business setting, **default ₹500**, pre-filled and editable on each bounce (0 for none). The **2nd bounce within 90 days** (settings) puts the retailer on **credit hold**: new orders and order increases are refused (409, reason `credit_hold`, `holdReason: bounced_cheques`) unless a manager lets one through with a reason (and PIN when someone else is taking the order), exactly like the overdue hold; "never hold" customers are exempt. The hold lifts by itself once the older bounce is outside the window. The bounce writes `cheque.bounced` and, when the limit is reached, `customer.credit_hold_bounces` to the activity log, and `collection.reversed` / `customer.credit_hold` to business_events.
- **Why:** Indian banks charge ₹300–₹750 for a returned cheque and distributors pass it on; two returns in a quarter is the usual trigger for cash-only / hold (and a Section 138 notice), and a rolling window releases a customer who pays on time again without anyone remembering to.
- **Change it:** *Outstanding › More › Credit hold rules*: bank charge, how many bounces (empty = never hold for bounces) and the window in days (7–365).

### Advance on a pickup order (restaurant)
- **Rule:** a takeaway ordered ahead can take an advance from its order row (*Orders › More › Take advance…*) while it is open and not yet billed. It is an ordinary restaurant advance (receipt number, drawer, GST tables 11A/11B) that remembers the order; an order without a guest gets the paying guest put on it. At billing the bill offers that advance first and pre-selects it for the amount due. A cancelled order's advance stays held and is handed back from *Dues › Advances* with a manager's say-so, as any advance.
- **Why:** the restaurant's advances already handle the money, the GST and the refund rules; linking to the order is all a pickup order needs.
- **Change it:** the *Advances* feature switch and `payments.manage` (who may take it).

## Shared core, retail & electronics

*Builder R2-CORE, 8 Oct 2026. Migration `1791620002000_core-retail-electronics-round2`.*

### Split payment on shop bills
- **Rule:** a bill takes up to 8 payments in one posting (cash, UPI, card…); one part may be "the rest of the bill". What is not paid goes on the named customer's udhaar (a walk-in must pay in full unless *Walk-in customers* allows otherwise). Only cash may be over-tendered: the cash handed over is kept on the cash payment and the change is given from cash alone. Day close counts each part under its own method; only the cash part is in the drawer.
- **Why:** the standard Indian counter practice ("₹500 cash, rest on PhonePe"); keeping each part as its own payment row means day close, receivables and reports need no special case.
- **Change it:** nothing to set; the single-payment request still works.
- **Since 14 Oct 2026:** the owner took split payment off the counter screens. Quick bill takes one payment method per bill (or udhaar, with a part paid in cash), and *Prescription sale* one method for the whole bill. The server still accepts up to 8 parts, an EMI down payment can still be split, and the salon bill takes up to three ways to pay.

### Per-staff PIN at a shared counter
- **Rule:** the till stays signed in; a cashier taps *Switch* on Quick bill, picks their name and types their own PIN, and the till carries on as them (the bill being built stays). Every bill records the person it was switched to. With *Ask the biller's PIN for every bill* on, Quick bill asks that person's PIN before each bill and the server refuses a counter bill without it. The PIN and its rules are the existing ones: the person's own PIN (My profile, or set by an admin), five wrong tries lock it, a password-locked account and the two-step device rule apply. Only members whose role may create sales are offered.
- **Why:** shared tills in Indian shops are run by several people; a quick PIN switch keeps accountability without signing out mid-rush, and reuses the restaurant till's tested PIN rules.
- **Change it:** Business settings › Prices and totals › *Shared till* (default: PIN only to switch). The PIN is never stored with the bill.

### Loyalty points when a bill is returned
- **Rule:** points spent on a bill come back in proportion to the bill's value returned (cumulative, so a bill returned in parts gives back exactly what was spent once everything is back); points the bill earned are taken back as before. The goods' refund is what the customer actually paid after points, so nothing is paid twice.
- **Why:** the customer paid part of the bill with points; returning the goods should return that part the way it was paid, as Indian retail loyalty schemes do.
- **Change it:** Loyalty points › Change rules › *Give back spent points on returns* (default on).

### Electronics EMI sale
- **Rule:** at Quick bill, *EMI* takes the financier (Bajaj Finserv, HDFC Bank, ICICI Bank, Home Credit by default; the owner adds others), the loan / agreement number, optional DO number and months, and the down payment (cash, UPI, card — split allowed). The rest is the financed amount: a payment of method `finance` on the bill, so the customer owes nothing for it, and an EMI case owed by the financier. The customer must be named (customer, or buyer name and phone). A loan number is used once per financier. The payout is recorded on *EMI & financiers*: tick the cases it covers, the subvention the financier kept on each (default its *dealer subvention %*), and the amount received must equal financed less subvention to the paisa. It counts as money in (bank / UPI / cheque) on the day it is recorded. If the financier cancels after the goods come back, the case is cancelled and the financed part reversed on the bill; the customer gets back only what they paid themselves.
- **Why:** consumer-durable finance is how most phones and TVs are sold in India; the dealer is paid by the financier, net of the scheme's subvention, days later — so it is a receivable from the financier, never udhaar of the customer.
- **Change it:** Settings › Business tools › *EMI & finance* (*Modules* until 14 Oct 2026; a new electronics shop now starts with it off, marked *Recommended*); the financier list and each one's subvention % on *EMI & financiers › Financiers*; who may sell on EMI (`finance.create`) and record payouts (`finance.edit`) under Roles.

### Accessory kits / bundles
- **Rule:** a kit is an item of its own (code, barcode, kit price, MRP) made of ordinary goods. At the counter it sells as its parts: stock comes off each part; the kit's price (after any customer price) is split over the parts in proportion to their own list prices, to the paisa, so GST is charged at each part's own rate and the invoice shows each part with its HSN ("Part of …"). A serial-numbered part (a phone) needs its IMEI / serial (the counter picks the next unit, changeable) and makes it one kit per line; a batch part takes the batch that expires first. A kit takes no item offer of its own (its price is the offer); bill offers, the counter discount and points still apply. A kit is never bought as a kit — purchases take the parts. Returns are per part, at the part's share.
- **Why:** GST law taxes a mixed supply sold for one price at the highest rate unless the parts are billed separately; splitting by list price and billing each part at its own rate and HSN is the usual, defensible practice for phone + accessory combos.
- **Change it:** Products › *Kits & bundles* (parts, quantities, kit price).

### Printed GST invoice
- **Rule:** tax rows with nothing in them (CGST / SGST / IGST of ₹0, a 0% slab's tax columns) are not printed; a 0% (exempt / nil-rated) line shows "Exempt" in its GST column and in the HSN summary, on A4 and 80 mm.
- **Why:** an invoice full of "0% ₹0.00" rows is noise; the HSN summary still has to show exempt supplies for the GST return.
- **Change it:** nothing to set.

### Staff sign-in landing
- **Rule:** someone with no restaurant role (a kirana cashier) lands straight on their business; someone with several lands on the one they opened last, else the first in their list. Restaurant staff land as before (their restaurant, or the business they last opened).
- **Why:** a shop's staff should never see the restaurant dashboard.
- **Change it:** nothing to set; the business switcher still moves between businesses.

## Pharmacy & clinic

*Builder R2-HEALTH, 8 Oct 2026. Migration `1791620004000_pharmacy-clinic-lab`.*

> **Standard practice chosen; review with your pharmacist/doctor/legal advisor before going live.** Sources: Drugs and Cosmetics Rules 1945 (Rule 65, Schedules H, H1, X), GST 2.0 rates (22 Sep 2025), the Clinical Establishments Act 2010, IMC (Professional Conduct) Regulations 2002, the DPDP Act 2023 and DPDP Rules 2025.

### Prescription medicines (Schedule H, H1, X)
- **Rule:** each medicine has a schedule in the drug master (none, G, H, H1, X, narcotic). A bill with an H / H1 / X / narcotic line is made on *Prescription sale* and needs the patient's name, the doctor's name and registration number, the prescription date and (by default) a photo or scan. The database refuses such a line on a plain bill (Quick bill) while the pharmacy rules are on. Bills made before the rules were switched on stay as they are.
- **Why:** Rule 65 allows these sales only on a registered medical practitioner's prescription, under a registered pharmacist; the scan is the shop's proof at an inspection.
- **Change it:** the schedule per medicine (*Pharmacy › Drug master*); *Pharmacy settings › A photo or scan … is required* (on).

### The H1 and Schedule X registers
- **Rule:** each H1, X or narcotic line is written to its register with the sale: date, bill, patient (and address if given), prescriber's name, registration number and address, drug, quantity, batch and expiry; X and narcotic entries also name the pharmacist who signed. Entries can never be changed or deleted. Kept: H1 register 3 years, Schedule X register 2 years, prescriptions 2 years (each entry stores its "keep until" date).
- **Why:** Rule 65 asks for a separate H1 register kept three years; Schedule X prescriptions are kept two years.
- **Change it:** *Pharmacy settings › Registers and prescriptions* (years).

### Pharmacist sign-off for Schedule X
- **Rule:** a Schedule X or narcotic sale needs a registered pharmacist (a staff member set up with their council registration) to enter their own PIN (*My profile › PIN*, with the usual lock after wrong tries). Optional on other prescription sales.
- **Why:** Schedule X sales are under the pharmacist's personal supervision; the PIN proves who checked it without sharing logins.
- **Change it:** *Pharmacy settings › Registered pharmacists*.

### Drug licences and the pharmacist on the bill
- **Rule:** every pharmacy bill (A4 and 80 mm) prints the drug licence numbers filled in (Form 20, 21, 20B, 21B, 20F) and the registered pharmacist (the one who signed, else the first active one), plus the prescriber and each line's schedule, batch and expiry.
- **Why:** a chemist shows its licence numbers on the cash memo; batch and expiry let a recall be traced. 20 / 21 are the retail licences, 20B / 21B wholesale, 20F Schedule X: the shop fills in the ones it holds.
- **Change it:** *Pharmacy settings › Drug licences*.

### Strips and loose tablets
- **Rule:** a medicine stocked in tablets gets "1 strip = N tablets" (and a box) from the drug master; the counter sells strips by default, loose tablets only when the drug master allows cutting the strip. Batches are taken first-to-expire on the server, whole strips first; an expired or recalled batch is never sold.
- **Why:** chemists commonly cut strips for short courses, but not for every medicine.
- **Change it:** *Drug master › Tablets per strip / A strip may be cut*.

### Substitutes
- **Rule:** items with the same salt (composition; case and spaces ignored) and strength are substitutes; the counter offers them cheapest-in-stock first. The pharmacist chooses; nothing is swapped automatically.
- **Why:** generic substitution saves the customer money; the choice stays with the pharmacist and the prescriber.
- **Change it:** the composition and strength in the drug master.

### Expiry and breakage returns to the distributor
- **Rule:** *Expiry, returns & recalls* lists batches expiring within 90 days grouped by the distributor of their latest purchase. A debit note returns them as supplier returns on those purchases (what is owed to the distributor goes down at once by the purchase value with GST); a batch with no purchase on record is written off with the reason. The distributor's credit note (number, date, amount, which may be less) closes the note.
- **Why:** distributors take back expiring stock against a debit note and settle by credit note; booking it as a supplier return keeps payables and stock right.
- **Change it:** *Pharmacy settings › Expiring soon means within (days)*.

### Batch recall
- **Rule:** recalling a batch lists every bill that took it, with the customer's or patient's phone, and (by default) blocks it: the database refuses any sale or transfer of a blocked batch; it can still go back to the distributor or be written off. A recall is closed with a note.
- **Why:** CDSCO "not of standard quality" alerts name batches; the shop must stop selling and reach the buyers.
- **Change it:** block / unblock / close on the recall.

### GST on medicines
- **Rule:** the rate stays per item in the catalogue; the demo uses 5 % for medicines (most moved from 12 % to 5 % on 22 Sep 2025), 0 % for insulin, 18 % for sanitiser-type goods; consultations and diagnostics are exempt (SAC 9993).
- **Why:** GST 2.0 rates; the item master is where the rate is already kept.
- **Change it:** each item's tax rate.

### Patient consent (DPDP)
- **Rule:** registering a patient needs consent for "treatment and medical records", recorded with the notice version shown, how it was given (signed form, verbal, digital) and by whom. Reports on WhatsApp / e-mail and reminders are separate, optional consents. A withdrawal is recorded once with the reason; withdrawing treatment consent stops new visits and lab orders, while the record is kept for the retention period. A changed notice becomes a new version.
- **Why:** the DPDP Act wants consent for a stated purpose after a clear notice, and withdrawal as easy as giving it; medical records must still be kept.
- **Change it:** *Clinic & lab settings › Consent notice* and *Clinical records kept for (years)* (3).

### Who sees clinical data
- **Rule:** two new permissions: `patients.view_clinical` (vitals, complaints, diagnoses, prescriptions, lab results, the clinical card) and `patients.edit_clinical` (writing them). Only the Doctor role (and the Owner) has them. Front desk (Cashier) sees the patient's details, consent, appointments, visits, bills and "report ready". Lab technicians and pathologists see results through `lab.edit` / `lab.approve`. Every read of clinical data is written to the activity log (`patient.clinical_viewed`, with what was seen). The Manager template gets no clinical access.
- **Why:** DPDP "reasonable security safeguards": access only for those who need it, with a log of access.
- **Change it:** *Roles & permissions* (columns "See clinical", "Write clinical").

### Consultation records
- **Rule:** a completed consultation is fixed by the database; a correction is a dated note added below it. The prescription is written by generic name and printed (A5) with the doctor's registration number and council; ICD-10 is optional. A visit opened from an appointment completes that appointment.
- **Why:** IMC Regulations 1.3.1 (records kept three years, not altered) and the doctor's registration number on prescriptions; generic names as the NMC asks.
- **Change it:** *Clinic & lab settings › Doctors* (registration numbers).

### Lab results and reports
- **Rule:** reference ranges by sex and age band (and critical limits); each result is flagged low / high / critical / abnormal as typed, with the range used kept on the result. Results are entered once the sample is received in the lab. A report is approved by a pathologist with their PIN; after that the results cannot change. The A4 report shows the lab, the patient, collection and report times, results with units and ranges, and the pathologist's name, qualification and registration.
- **Why:** NABL-style report content; a registered pathologist signs reports.
- **Change it:** *Lab › Tests & panels* (ranges); *Clinic & lab settings* (lab name, registration, footer, pathologists).
- **Since 21 Oct 2026:** a signed report can be corrected, by amendment, and every signed version is kept; a report cannot be signed while today's latest quality-control run for one of its parameters is rejected (see *Round 3*).

### Outside-lab referral commission
- **Rule:** a test can be sent to an outside lab (its name, reference and charge are recorded; the results are typed in and approved as usual, and the report says where it was tested). A referral commission is recorded only if the clinic switches it on (default **off**).
- **Why:** referral commissions are an **ethical and legal question**: the IMC Regulations 2002 (6.4) forbid doctors from giving or receiving a commission for referrals, and "cut practice" is treated as misconduct. Take advice before switching it on.
- **Change it:** *Clinic & lab settings › Referral commission* (owner only).

### Roles by business type
- **Rule:** role templates may now belong to some business types: Pharmacist (pharmacy), Doctor, Lab technician and Pathologist (clinic / lab). Existing pharmacies and clinics get them; other types do not.
- **Why:** a kirana should not see a "Doctor" role.
- **Change it:** they are ordinary roles, editable under *Roles & permissions*.

## Independent check

*Round 2 checker, 8 Oct 2026. No migration.*

### Day close counts advances handed back and bounced cheques
- **Rule:** an advance refunded to a customer (salon deposit, repair advance) is money out on the day it is paid back, under its method; a cheque receipt that bounced is taken off on the day it bounced (it still shows as received on the day it came in, so an earlier day close never changes).
- **Why:** before, the drawer and "net" figures kept counting money that had gone back or never arrived.
- **Change it:** nothing to set.

### Pharmacy counter takes split payment and the shared-till PIN
- **Rule:** *Prescription sale* takes the same split payment as Quick bill (up to 8, the last part "the rest of the bill") and the same *Switch* / "PIN for every bill"; Schedule X still needs the registered pharmacist's own PIN whoever is billing.
- **Why:** split payment was wanted on every shop bill; the pharmacy counter had only one method.
- **Change it:** Business settings › *Shared till*.
- **Since 14 Oct 2026:** *Prescription sale* takes one payment method per bill again, as Quick bill does (see *Split payment on shop bills*); *Switch* and "PIN for every bill" are unchanged.
