# Business rules

For owners, accountants, the pharmacist, doctor and legal adviser who review the health rules, support staff, and developers who change a rule: each rule someone may question, why it is so, and where to change it.

Each rule has up to three parts:

- **Rule:** what the program does.
- **Why:** the reason, where the rule alone does not make it plain.
- **Change it:** the setting that changes it, or *nothing to set*.

A few rules are not settings at all. They come first, under [Fixed on purpose](#fixed-on-purpose).

The everyday numbers, such as expiring-soon days, voucher validity, credit age groups and receipt paper, are settings that start at a usual value. They are described with their screens: [ADMIN_GUIDE.md › Business settings › Rules](ADMIN_GUIDE.md#business-settings--rules) for a business, and *Settings › Alerts and timings* for a restaurant. How each rule is worked out and stored is in [BUSINESS_PLATFORM_DATA_MODEL.md](BUSINESS_PLATFORM_DATA_MODEL.md). The words are in [GLOSSARY.md](GLOSSARY.md).

## Contents

- [Fixed on purpose](#fixed-on-purpose)
- [Every business](#every-business)
- [Shops and the shared core](#shops-and-the-shared-core)
- [Money and the day](#money-and-the-day)
- [Wholesale](#wholesale)
- [Electronics](#electronics)
- [Salon & spa](#salon--spa)
- [Meat and weight-based shops](#meat-and-weight-based-shops)
- [Pharmacy, clinic and lab](#pharmacy-clinic-and-lab)
- [Hardware, paints & building materials](#hardware-paints--building-materials)
- [Seeds, fertilisers & pesticides](#seeds-fertilisers--pesticides)
- [Optical shops](#optical-shops)
- [Vehicle service & auto parts](#vehicle-service--auto-parts)
- [Gyms, studios & coaching](#gyms-studios--coaching)
- [Restaurant and food formats](#restaurant-and-food-formats)

## Fixed on purpose

These are not settings. Changing one means changing the code; the PIN lockout is changed in the server's settings.

- **GST, GSTIN and state-code rules.** The law sets them. For example, a GSTIN's first two digits are its state code.
- **The list of permissions.** It is part of the security design. An owner chooses which role holds which permission and makes roles of their own, but cannot add a permission.
- **The PIN lockout.** It stops guessing: five wrong tries within 15 minutes lock a PIN (or, for passwords, the account) for 15 minutes. An owner cannot change it. Whoever runs the server can change the numbers in `backend/.env` (the `ACCOUNT_LOCK_*` settings).
- **At most 8 payments on one bill.** This is the API's limit. The counter screens take fewer (see [Paying at the counter](#paying-at-the-counter)).
- **Label-sheet sizes.** Barcode labels print on standard A4 label sheets of 24, 40 or 65 labels.
- **The reason lists that drive reports:** wastage, claims, debit notes and cancellations. The reports group by these reasons.
- **The stock-age groups.** The fashion style report groups stock as 0–30, 31–60, 61–90 and over 90 days old. The electronics serial list filters by 0–30, 31–60 and over 60 days.

## Every business

### Where staff land after signing in

- **Rule:** someone with no restaurant role (a kirana cashier, say) lands straight on their business: the one they opened last, else the first in their list. Restaurant staff land on their restaurant's dashboard, or on the business they opened last when that is another business. A platform Super Admin lands on *Platform › Restaurants*.
- **Why:** a shop's staff should never see the restaurant dashboard.
- **Change it:** nothing to set. The business switcher moves between businesses.

### One till, many cashiers: the per-staff PIN

- **Rule:** a shop's till stays signed in. A cashier taps *Switch* on Quick bill, picks their name and types their own PIN, and the till carries on as them. The bill being built stays. Every bill records the person the till was switched to. With *Ask the biller's PIN for every bill* on, Quick bill asks that person's PIN before each bill, and the server refuses a counter bill without it. The PIN is the person's own personal PIN (*My profile › Personal PIN*, or set by an admin), with the usual lockout, the account lock and the two-step device rule. Only people whose role may create sales are offered. *Prescription sale* has the same *Switch* and PIN rule; a Schedule X sale still needs the registered pharmacist's own PIN, whoever is billing.
- **Why:** several people run a shared till in Indian shops. A quick PIN switch keeps each bill's biller on record without signing out in a rush, and it reuses the restaurant till's PIN rules.
- **Change it:** *Business settings › Prices, totals and numbering › Shared till* (default: ask the PIN only to switch). The PIN is never stored with the bill.

### Nothing is posted twice: request keys

- **Rule:** in every business but the restaurant, each posting (a bill, a purchase, a payment, a return, a stock move, an expense, a cash check) is sent with a request key. The same request sent again, after a double tap or a dropped connection, returns what was saved the first time and posts nothing new. The same key with different content is refused. Permissions and a person's location are checked on the server, and the activity log keeps who recorded or reversed each money record.
- **Why:** a retry on a poor connection must never post a bill, a payment or an expense twice.
- **Change it:** nothing to set.

### Late-night trading

- **Rule:** in a restaurant, between midnight and the day cut-off (5 am by default), last night's business day is still the trading day everywhere: write-off control, the dashboard, the day book, reports' default dates, the stock screens, deliveries, advances, the log book and captain sections. Until the cut-off, last night's day can also still be opened. In every other business the day is the calendar date in the business's time zone; its *Day cut-off* setting decides only which day a task due after midnight belongs to.
- **Why:** a restaurant that closes after midnight keeps the night on one business day. Read by the calendar date, its dashboard and day book would jump at midnight to a day with no bills.
- **Change it:** a restaurant's cut-off hour: *Daily work › Business day › Cash rules* (*Last night's day may be opened until*), set by the owner (`restaurant.settings.manage`). A business's task cut-off: *Business settings › Rules › Day cut-off*.

## Shops and the shared core

These rules apply to every business type but the restaurant. The goods rules apply to the shops that sell goods: grocery and kirana, supermarket, books & stationery, pharmacy, fashion, electronics, meat and other weight-based shops, general stores, hardware and building materials, seeds and fertilisers, optical shops, garages and auto parts, jewellers and fuel stations.

### Branch and member prices

- **Rule:** a branch can sell an item at its own price; a branch without one sells at the item's price. With *Loyalty points* on, a customer named on the bill pays the item's member price when that is lower. Offers still apply.
- **Change it:** the item's *Member price*, and *Branch prices* on its row.

### MRP, GST and the shelf price

- **Rule:** a new goods shop starts with prices that include GST and with totals rounded to the rupee. Each item can carry an MRP (GST included) and an HSN or SAC code. An item is never priced above its MRP, never given a new shelf price above it on a receipt, and never billed above it. When prices are before GST, the GST is added before comparing. The HSN code and the MRP are copied onto each bill line, and a posted bill keeps the tax mode it was made with.
- **Why:** in a goods shop, what the shelf says is what the customer pays.
- **Change it:** *Business settings › Prices, totals and numbering* (*Selling prices*, *Round sale totals*); each item's *MRP* and *HSN / SAC* code in its edit form.

### The counter discount and walk-in customers

- **Rule:** at Quick bill, someone whose role holds `sales.discount` (the Manager role by default) can take a small discount off the bill, in ₹ or %, with a reason. It comes after offers and before points. It is capped at *Most discount at the counter* (10 % of the bill by default); the owner is not limited. A walk-in pays the whole bill, on the screen and on the server: udhaar needs a named customer, unless *Walk-in customers* is set to *May leave a bill unpaid*.
- **Why:** udhaar is money a named customer owes.
- **Change it:** *Business settings › Prices, totals and numbering* (*Most discount at the counter*, *Walk-in customers*); who holds `sales.discount` in *Roles & permissions*.

### Cash of ₹2,00,000 or more

- **Rule:** no bill takes ₹2,00,000 or more in cash, counting every cash payment on it whenever it is paid, and no customer pays ₹2,00,000 or more in cash in one business day, counting the cash on their bills and their collection receipts. The payment or receipt that would reach the limit is refused, with what to do: take the rest by UPI, card, bank transfer or cheque. Every screen that takes money goes through this rule, and so does anything that writes a payment to the database.
- **Why:** the Income-tax Act 2025 (section 186; section 269ST of the 1961 Act until April 2026) forbids receiving that much in cash from one person in a day or for one transaction, and the penalty equals the cash received.
- **Change it:** only when the law changes: the limit is in the database triggers `business_payments_cash_limit` and `business_collections_cash_limit`.

### PAN on a bill over ₹2,00,000

- **Rule:** a sale over ₹2,00,000 records the buyer's PAN: typed on the bill, saved with the customer (*Customers › the customer › PAN*), or read from the customer's GSTIN or wholesale details. A buyer who has no PAN signs a declaration (Form 97); the bill then records that it was taken. Without either the bill is refused. The PAN, or the declaration, prints under the buyer on the invoice.
- **Why:** the income-tax rules make the buyer quote their PAN on a purchase over ₹2,00,000, and the shop must keep it.
- **Change it:** a code change (`PAN_ABOVE_PAISE` in `business.service.js`) when the rules change.

### Coupons

- **Rule:** an offer with a code applies only when the cashier enters the code. It can be limited to a number of uses in all and per customer; a per-customer limit needs the customer named on the bill.
- **Change it:** the offer, in *Offers & discounts*.

### Paying at the counter

- **Rule:** Quick bill takes one payment method per bill, from the business's own payment methods; when a kind has several (two UPI accounts, say), the cashier picks which. *Udhaar* puts the bill on a named customer's account, with an optional part paid in cash. *Prescription sale* takes one method for the whole bill. Two screens take more than one payment: an EMI sale's down payment can be split, and a salon bill takes up to three ways to pay. The API takes up to 8 payments on one bill, and one of them may be "the rest of the bill". Only cash may be over-tendered: the cash handed over is kept on the cash payment, and the change comes from cash alone. Daily money counts each payment under its own method; only cash is in the drawer.
- **Why:** one method per bill is the owner's choice for the counter screens. Where a bill takes several payments, each is its own payment row, so Daily money, receivables and reports need no special case.
- **Change it:** the methods in *Settings › Payment methods*; *Walk-in customers* in Business settings. The limit of 8 is [fixed](#fixed-on-purpose).

### Loyalty points when a bill is returned

- **Rule:** points spent on a bill come back in proportion to the value returned. The count is cumulative, so a bill returned in parts gives back exactly what was spent once everything is back. Points the bill earned are taken back. The refund for the goods is what the customer actually paid after points, so nothing is paid twice.
- **Why:** the customer paid part of the bill with points. Returning the goods returns that part the way it was paid, as Indian retail loyalty schemes do.
- **Change it:** *Loyalty points › Change rules › Give back spent points on returns* (on by default).

### Kits and bundles

- **Rule:** a kit is an item of its own (code, barcode, kit price, MRP) made of ordinary goods. At the counter it sells as its parts. Stock comes off each part, and the kit's price (after any customer price) is split over the parts in proportion to their own list prices, to the paisa. GST is charged at each part's own rate, and the invoice shows each part with its HSN ("Part of …"). A part with a serial number, such as a phone, needs its IMEI or serial: the counter picks the next unit, which can be changed, and each line then holds one kit. A part kept in batches takes the batch that expires first. A kit takes no item offer of its own, because its price is the offer; bill offers, the counter discount and points still apply. A kit is never bought as a kit: purchases take the parts. Returns are per part, at the part's share.
- **Why:** GST law taxes a mixed supply sold for one price at the highest rate unless the parts are billed separately. Splitting by list price and billing each part at its own rate and HSN is the usual, defensible practice for a phone sold with accessories.
- **Change it:** *Products & services › Kits & bundles* (parts, quantities, kit price).

### The printed GST invoice

- **Rule:** tax rows with nothing in them (CGST, SGST or IGST of ₹0, a 0 % slab's tax columns) are not printed. A 0 % line (exempt or nil-rated) shows "Exempt" in its GST column and in the HSN summary, on A4 and on 80 mm.
- **Why:** an invoice full of "0% ₹0.00" rows is noise, but the HSN summary must still show exempt supplies for the GST return.
- **Change it:** nothing to set.

### Departments

- **Rule:** a top-level category belongs to one department. A person tied to a department sees and changes only its products and stock, and still bills every item.
- **Why:** a counter sells across departments.
- **Change it:** each category's department in *Products & services › Categories*; the person's department in *Staff & access*.

### Who a manager can change in Staff & access

- **Rule:** *Give access* changes someone, and *Password* sets them a new password, only when the person doing it manages them. A manager tied to a location manages the people tied to that same location, and one tied to a department the people of that department; neither manages someone who works at every location or in every department. Nobody manages the owner, themselves, or someone whose role can do anything theirs cannot. The owner manages everyone else.
- **Why:** a manager must not demote or lock out someone above them or outside their part of the business; and whoever sets a password can sign in as that person and do whatever they may do.
- **Change it:** nothing to set. It follows each person's *Works at*, department and role in *Staff & access*, and the roles in *Roles & permissions*.

### Items used in services

- **Rule:** an item a salon or a clinic uses up in its services (hair colour, gloves) can be kept in stock and never sold. The bill screens leave it out.
- **Change it:** the item's *For use in services only, not sold*.

### Free goods on a supplier's bill

- **Rule:** a supplier's "10 + 1 free" comes into stock at no extra cost. Each unit received costs the line's net (the paid units at the rate, less the trade discount) divided by the whole quantity, free units included.
- **Change it:** nothing to set.

### Cashier shifts

- **Rule:** a cashier opens a shift at a counter with the cash in the drawer and closes it with a blind count: they type what they counted before they see what the drawer should hold (their own cash sales, collections, refunds, supplier payments and expenses there). A difference needs a reason. Each person has one open shift per counter, and a closed shift never changes.
- **Why:** in a supermarket many cashiers bill at once, so each count is checked against that cashier's own cash.
- **Change it:** nothing to set.

### A quotation's prices

- **Rule:** a quotation is priced by the server exactly as a sale of the same lines would be at that moment: customer and slab prices, the branch's price, running offers, a manager's discount within the counter limit, GST and round-off. Never above an item's MRP. A kit cannot go on a quotation (its parts can). A revision prices every line again at that day's prices.
- **Why:** what the customer is told must be what the bill says.
- **Change it:** nothing to set; the prices themselves are set on the items and price lists.

### A quotation holds its prices until its date

- **Rule:** an open quotation may be billed, or made into a sales order, only up to its *Valid until* date, on the business's own calendar (at most 180 days ahead). After it, it shows as *Expired* and must be revised first. The bill is posted at the quoted prices: each line keeps its quoted taxable value and GST, a line taken from two batches is split in proportion so the bill still adds up to the quotation to the paisa, and the bill's total must equal the quotation's. It is refused, with the reason, while an item's GST rate or pack size differs from the quotation, while its quoted rate (GST included) is above its MRP now, or when the business rounds totals differently now.
- **Why:** cement and steel prices move every week; a shop holds a price only for as long as it promised to, and never bills against the law (MRP) or at a GST rate that is no longer the item's.
- **Change it:** the date on each quotation (when making or revising it).

### A quotation that is billed or cancelled

- **Rule:** a billed, ordered or cancelled quotation never changes: its lines, totals, customer and site stay as they were (the database refuses any change). An open one is cancelled with a reason; nothing is deleted. Undoing the sale is a return on the bill. A customer who is not saved pays a goods shop's bill in full when it is made; only a saved customer's quotation becomes a sales order, and only for goods.
- **Why:** the quotation is the record of what was offered and accepted.
- **Change it:** nothing to set.

### A licence belongs to one location

- **Rule:** with *Licences & registrations* on, each licence is kept for the one location that holds it, with its kind, number, issuing authority and the dates it is valid (no end date: it does not run out). It keeps its location and kind for good, and one number is kept once for a kind of licence in the business. A licence is renewed by changing its *Valid until*, and switched off once surrendered or cancelled; it is never deleted (the database refuses both). The activity log keeps each change with the values before and after. A licence is *in force* on a day when it is on, that day is on or after *Valid from*, and on or before *Valid until*.
- **Why:** the licences a shop must show are issued for each place of business, and an inspector asks for the one held on a given day.
- **Change it:** the licence itself, under *Settings › Licences*; who may change licences is the role's `licences.edit`.

### The bell before a licence runs out

- **Rule:** the bell warns about an active licence 60 days before its *Valid until*, and again, as critical, once that date has passed. A licence switched off is not warned about.
- **Why:** a renewal takes weeks; a shop selling under a lapsed licence sells without one.
- **Change it:** the 60 days is a code change (`WARN_DAYS` in `businessLicences.service.js`).

## Money and the day

### Daily expenses

- **Rule:** an expense records money already paid for a running cost; supplier purchases stay in Purchases. It needs an active location, an amount with at most two decimal places, and a date no later than today and at most 30 days back. It cannot be dated to a past day once the cash at that location has been counted on that day or later: the server refuses it and asks for today's date. Recording needs `expenses.create`. An expense is never edited or deleted: someone with `expenses.approve` reverses it with a reason, and the reversal is a money movement of its own on the day it is made. Expenses cannot be switched off once one has been recorded.
- **Why:** a day whose cash has been counted stays as it was counted.
- **Change it:** the *Daily expenses* tool in *Settings › Business tools*; who holds `expenses.create` and `expenses.approve` in *Roles & permissions*. The 30-day limit is not a setting.

### What Daily money adds up

- **Rule:** Daily money combines sale payments, later collections, customer refunds, supplier payments and refunds, finance payouts, expenses and their reversals, and bounced cheques, without counting a bill's allocations twice. An advance handed back to a customer (a salon deposit, a repair advance) is money out on the day it is paid back, under its method. A cheque that bounced is taken off on the day it bounced; it still shows as received on the day it came in, so an earlier day's figures never change. Reconciliation screens show exact paise. *Net cash movement* leaves out the opening float in the drawer: it is not a counted balance.
- **Why:** the drawer and net figures must never count money that went back or never arrived.
- **Change it:** nothing to set.

### The cash check

- **Rule:** a cash check records, for one date and location, the opening cash, the cash counted, the amount the server works out the drawer should hold, and the difference. A difference needs a reason. A check is a permanent snapshot: trading can carry on after it, and a later change to that day's money is called out. Recording needs `reports.edit`, and also `expenses.view` when expenses are on. The server works out every movement in one consistent read.
- **Why:** a drawer cannot be reconciled by someone who cannot see the money that left it.
- **Change it:** who holds `reports.edit` (Manager, Accountant and Cashier by default) in *Roles & permissions*.

## Wholesale

### Free-goods schemes

- **Rule:** a scheme gives free goods of the same item ("buy 10 cases, get 1 free") or of another item ("buy 5 cases of A, get 1 case of B"), a discount %, or both. The free goods go on the order and on the tax invoice as their own line at ₹0, named after the scheme ("Free · scheme name"), and leave stock at dispatch like any line, oldest expiry first. The scheme applies after the price is chosen (customer price, price group, case slab, list price), so by default it stacks on a slab price. A scheme marked *Don't combine with slab prices* prices the line without quantity slabs when it applies: a slab for all customers gives way to the list price, and only a price group's base price (from 1 unit or 1 pack) is used. A customer's own negotiated price still applies. The biggest scheme the line reaches wins, and a line takes one scheme. A return of scheme goods does not take back the free goods ([BACKLOG.md](BACKLOG.md#7-left-inside-built-modules)).
- **Why:** FMCG companies run "10 + 1" and cross-brand schemes on top of the distributor's trade slabs, but some schemes are funded only at the base rate. The distributor must be able to say which.
- **Change it:** *Price groups & schemes › Schemes › Add a scheme* (the free item, its pack, and the *Don't combine with slab prices* tick). *Wholesale reports › Schemes by retailer* shows, per retailer, the orders that earned a scheme, what was bought and sent, the free goods sent with their value at list price, and the discount given.

### Bounced cheques

- **Rule:** marking a cheque bounced (credit control, `receivables.approve`) reverses exactly the bill settlements that receipt made: the invoices it settled open again with those amounts, and the receipt stops counting. The bank charge is added to the retailer's account as a debit, an open item from the day the cheque bounced, shown on the statement as "Bank charge for cheque …". The charge comes from the business setting (₹500 by default), filled in and editable on each bounce (0 for none). The second bounce within 90 days puts the retailer on credit hold: new orders and order increases are refused, unless a manager lets one through with a reason (and their PIN when someone else is taking the order), exactly as with the overdue hold. Customers marked *never hold* are exempt. The hold lifts by itself once the older bounce falls outside the window. Each bounce is written to the activity log.
- **Why:** Indian banks charge ₹300–₹750 for a returned cheque, and distributors pass it on. Two returns in a quarter is the usual trigger for cash-only or a hold (and a Section 138 notice). A rolling window releases a customer who pays on time again, without anyone having to remember to.
- **Change it:** *Outstanding › More › Credit hold rules*: the bank charge, how many bounces (empty: never hold for bounces) and the window in days (7–365).

## Electronics

### EMI sales

- **Rule:** at Quick bill, *EMI* takes the financier, the loan or agreement number, an optional DO number and number of months, and the down payment (cash, UPI or card, which may be split). A new electronics shop starts with Bajaj Finserv, HDFC Bank, ICICI Bank and Home Credit; the owner adds others. The rest of the bill is the financed amount. It is a payment of method `finance` on the bill, so the customer owes nothing for it, and an EMI case owed by the financier. The customer must be named (a saved customer, or a buyer's name and phone). A loan number is used once per financier. A payout is recorded on *EMI & financiers*: tick the cases it covers and the subvention the financier kept on each (by default its *dealer subvention %*). The amount received must equal the financed amount less the subvention, to the paisa. It counts as money in (bank, UPI or cheque) on the day it is recorded. If the financier cancels after the goods come back, the case is cancelled and the financed part reversed on the bill; the customer gets back only what they paid themselves.
- **Why:** most phones and TVs in India are sold on consumer-durable finance. The financier pays the dealer days later, net of the scheme's subvention, so the financed part is owed by the financier and is never the customer's udhaar.
- **Change it:** *Settings › Business tools › EMI & finance* (a new electronics shop starts with it off, marked *Recommended*); the financier list and each one's subvention % in *EMI & financiers › Financiers*; who may sell on EMI (`finance.create`) and record payouts (`finance.edit`) in *Roles & permissions*.

### Repair advances

- **Rule:** the advance taken when a repair comes in is kept on the job card and taken off the bill at delivery. It can be refunded only once the job is closed: returned unrepaired, or what is left after a delivery that came to less. A refund is paid in cash, UPI or bank, needs a reason and a manager's PIN (`sales.refund`), and prints a receipt.
- **Why:** while the job is open, the advance belongs to the bill to come.
- **Change it:** who holds `sales.refund` in *Roles & permissions*.

## Salon & spa

### A stylist's week and the salon's holidays

- **Rule:** a stylist keeps their usual hours and weekly day off, and a weekly schedule overrides single weekdays (a day off, or other hours). Salon holidays close the whole salon or one branch. A booking or a move is refused outside these hours, on leave, or outside the calendar hours. Leave and holidays are refused while bookings exist on those days; move the bookings first.
- **Why:** salons in India run split weeks (a short Sunday, a weekday off in turn) and close on Diwali, Pongal or Ugadi. One row per weekday is the least to set up.
- **Change it:** *Stylists & services › Stylists & rooms* (a stylist's *Weekly schedule* and *Add leave*) and the *Holidays* tab.

### A manager's override of the hours

- **Rule:** a booking outside the hours needs the permission `appointments.approve` (in the Manager role by default). Someone who holds it and books it themselves gives only a reason; anyone else needs a manager's reason and PIN. Each override is kept with its reason and in the activity log.
- **Why:** the same pattern as the wholesale credit hold. The front desk often has to fit in a bride or a regular.
- **Change it:** give or take `appointments.approve` in *Roles & permissions*.

### Products used in a service (back-bar)

- **Rule:** a service's recipe is in each product's own stock unit (ml, g). The stock leaves when the service line is billed, because the salon bill is made when a service is done. It leaves oldest use-by first, at the bill's location. If the books hold less, the bill still goes through and the shortfall is recorded. Returning a service gives nothing back, because the product was used. The cost is the product's latest purchase price before GST (the owner's decision); with no purchase yet, it is the average cost of the stock held.
- **Why:** a counter must never be stopped by stock records. A shortfall is a stock-keeping task, shown in *Service profitability › Products used*.
- **Change it:** *Stylists & services › Service times › Products used* (an empty recipe takes nothing).

### A client's advance: refund or wallet

- **Rule:** any receipt with money left can be refunded in cash, UPI or bank (a reference is needed for UPI and bank), numbered `<receipt>-R<n>`. A deposit held for a booking still to come can instead be moved to the client's wallet: it becomes ordinary advance for any bill, and the booking keeps no deposit, so a later no-show charges nothing from it. Both need a reason and a manager's PIN (`sales.refund`). The PIN is always asked, the manager's own when they do it themselves, because money leaves or a protection is given up. A refund prints a receipt to sign.
- **Why:** a salon's "wallet" is the client's advance, already kept on account, so no new kind of balance is needed.
- **Change it:** who holds `sales.refund` in *Roles & permissions*.

### Monthly target (slab) commission

- **Rule:** a plan has slabs on the month's net service sales (after discounts and returns, before GST). It covers services only: package sessions, products and plan sales stay on the flat rules. The default mode, *stepped*, pays each slab at its own rate (for example 10 % of the first ₹50,000 and 12 % of the rest). The other mode pays the whole month at the rate of the slab reached. Each stylist is put on a plan from a month (this month or later); without one, the flat rules apply. A plan's slabs never change once saved, so paid months stay as they were; a new rate is a new plan. For dates that are not a whole month, the month's slab is shared by the stylist's part of that month's sales, so a mid-month payout uses the rate reached so far.
- **Why:** a monthly target with a higher rate past it is the common Indian salon incentive. *Stepped* never pays less than the slab before.
- **Change it:** *Staff commissions › Target plans* (the mode of each plan, the plan of each stylist).

## Meat and weight-based shops

### Cut to order

- **Rule:** the whole weight leaves stock, the cuts come into stock and go on the bill at their own rates, and what is lost is the waste.
- **Change it:** nothing to set.

### Yield by supplier

- **Rule:** average yield is the total usable kg divided by the total whole kg (weighted by weight), per supplier and whole item over the chosen dates, set against the item's average over all suppliers. A batch's supplier is the one recorded when it was cut, otherwise the supplier of the purchase that brought its input batch in, so older batches count too. Opening stock with no purchase shows as "No purchase".
- **Why:** a weighted average is what the money sees. The simple average of the batches is shown as the worst-to-best range.
- **Change it:** nothing to set.

## Pharmacy, clinic and lab

> **Standard practice, to be reviewed before going live.** These rules follow standard Indian practice. Review them with your pharmacist, doctor and legal adviser before real use. Sources: the Drugs and Cosmetics Rules 1945 (Rule 65; Schedules H, H1 and X), the GST 2.0 rates (in force from 22 September 2025), the Clinical Establishments Act 2010, the IMC (Professional Conduct) Regulations 2002, the DPDP Act 2023 and the DPDP Rules 2025.

### Pharmacy

#### Prescription medicines (Schedule H, H1, X)

- **Rule:** each medicine has a schedule in the drug master: none, G, H, H1, X or narcotic. A bill with an H, H1, X or narcotic line is made on *Prescription sale* and needs the patient's name, the doctor's name and registration number, the prescription date and, by default, a photo or scan. While the pharmacy rules are on, the database refuses such a line on a plain bill (Quick bill). Bills made before the rules were switched on stay as they are.
- **Why:** Rule 65 allows these sales only on a registered medical practitioner's prescription, under a registered pharmacist. The scan is the shop's proof at an inspection.
- **Change it:** the schedule of each medicine (*Medicines & products › Drug master*); *Pharmacy settings › A photo or scan … is required* (on).

#### The H1 and Schedule X registers

- **Rule:** each H1, X or narcotic line is written to its register with the sale: date, bill, patient (and address if given), the prescriber's name, registration number and address, drug, quantity, batch and expiry. X and narcotic entries also name the pharmacist who signed. Entries can never be changed or deleted. They are kept for 3 years (H1 register), 2 years (Schedule X register) and 2 years (prescriptions); each entry stores its "keep until" date.
- **Why:** Rule 65 asks for a separate H1 register kept for three years. Schedule X prescriptions are kept for two years.
- **Change it:** *Pharmacy settings › Registers and prescriptions* (years).

#### Pharmacist sign-off for Schedule X

- **Rule:** a Schedule X or narcotic sale needs a registered pharmacist (a staff member set up with their council registration) to enter their own PIN (*My profile › Personal PIN*, with the usual lockout). It is optional on other prescription sales.
- **Why:** Schedule X sales are under the pharmacist's personal supervision. The PIN proves who checked the sale without sharing logins.
- **Change it:** *Pharmacy settings › Registered pharmacists*.

#### Drug licences and the pharmacist on the bill

- **Rule:** every pharmacy bill (A4 and 80 mm) prints the drug licence numbers filled in (Forms 20, 21, 20B, 21B and 20F) and the registered pharmacist (the one who signed, else the first active one), plus the prescriber, and each line's schedule, batch and expiry. A branch with licences of its own prints them.
- **Why:** a chemist shows its licence numbers on the cash memo, and batch and expiry let a recall be traced. Forms 20 and 21 are the retail licences, 20B and 21B wholesale, and 20F Schedule X; the shop fills in the ones it holds.
- **Change it:** *Pharmacy settings › Drug licences*, and *Licences by branch*.

#### Strips and loose tablets

- **Rule:** a medicine stocked in tablets gets "1 strip = N tablets" (and a box) from the drug master. The counter sells strips by default, and loose tablets only when the drug master allows cutting the strip. The server takes batches first to expire, whole strips first, and never sells an expired or recalled batch.
- **Why:** chemists commonly cut strips for short courses, but not for every medicine.
- **Change it:** *Drug master › Tablets per strip* and *A strip may be cut*.

#### Substitutes

- **Rule:** items with the same salt (the composition, ignoring case and spaces) and the same strength are substitutes. The counter offers them cheapest in stock first. The pharmacist chooses; nothing is swapped automatically.
- **Why:** generic substitution saves the customer money, and the choice stays with the pharmacist and the prescriber.
- **Change it:** the composition and strength in the drug master.

#### Expiry and breakage returns to the distributor

- **Rule:** *Expiry, returns & recalls* lists the batches expiring within the pharmacy's expiring-soon window (90 days by default), grouped by the distributor of their latest purchase. A debit note returns them as supplier returns on those purchases, so what is owed to the distributor goes down at once by the purchase value with GST. A batch with no purchase on record is written off with the reason. The distributor's credit note (number, date, amount, which may be less) closes the note.
- **Why:** distributors take back expiring stock against a debit note and settle by credit note. Booking it as a supplier return keeps payables and stock right.
- **Change it:** *Pharmacy settings › Expiring soon means within (days)*.

#### Batch recall

- **Rule:** recalling a batch lists every bill that took it, with the customer's or patient's phone, and by default blocks the batch: the database refuses any sale or transfer of a blocked batch. It can still go back to the distributor or be written off. A recall is closed with a note.
- **Why:** CDSCO "not of standard quality" alerts name batches. The shop must stop selling them and reach the buyers.
- **Change it:** block, unblock or close on the recall itself.

#### GST on medicines

- **Rule:** the GST rate is kept per item in the catalogue. Typical rates: 5 % for most medicines, 0 % for insulin, 18 % for sanitiser-type goods. Consultations and diagnostics are exempt (SAC 9993).
- **Why:** these are the GST 2.0 rates, and the item master is where the rate is kept.
- **Change it:** each item's tax rate.

### Clinic and lab

#### Patient consent (DPDP)

- **Rule:** registering a patient needs consent for "treatment and medical records", recorded with the version of the notice shown, how it was given (signed form, verbal, digital) and by whom. Reports on WhatsApp or e-mail, and reminders, are separate and optional consents. A withdrawal is recorded once, with the reason. Withdrawing treatment consent stops new visits and lab orders, while the record is kept for the retention period. A changed notice becomes a new version.
- **Why:** the DPDP Act asks for consent for a stated purpose after a clear notice, and for withdrawal as easy as giving it. Medical records must still be kept.
- **Change it:** *Clinic & lab settings › Consent notice* and *Clinical records kept for (years)* (3).

#### Who sees clinical data

- **Rule:** two permissions guard clinical data: `patients.view_clinical` (vitals, complaints, diagnoses, prescriptions, lab results, the clinical card) and `patients.edit_clinical` (writing them). Only the Doctor role and the Owner have them. The front desk (Cashier) sees the patient's details, consent, appointments, visits, bills and "report ready". Lab technicians and pathologists see results through `lab.edit` and `lab.approve`. Every read of clinical data is written to the activity log (`patient.clinical_viewed`, with what was seen). The Manager role gets no clinical access.
- **Why:** the DPDP Act's "reasonable security safeguards": access only for those who need it, with a log of access.
- **Change it:** *Roles & permissions* (the columns *See clinical* and *Write clinical*).

#### Consultation records

- **Rule:** once a consultation is completed, the database keeps it as it is; a correction is a dated note added below it. The prescription is written by generic name and printed (A5) with the doctor's registration number and council; an ICD-10 code is optional. A visit opened from an appointment completes that appointment.
- **Why:** the IMC Regulations (1.3.1) ask for records kept three years and not altered, and for the doctor's registration number on prescriptions. Generic names are what the NMC asks for.
- **Change it:** *Clinic & lab settings › Doctors and pathologists* (registration numbers).

#### Doctors' fees and follow-ups

- **Rule:** a doctor's consultation fee is a service on the bill. Within the doctor's follow-up days after a paid consultation, the patient pays the follow-up fee, or nothing when the doctor has none; a free follow-up is recorded without a bill. The doctor's share of the fees is kept for the earnings report.
- **Change it:** *Today's patients › Doctors, fees & OPD*.

#### OPD sessions and leave

- **Rule:** an appointment on a doctor's leave is refused, and once the doctor has OPD sessions, so is one outside them. A token on leave is refused too, but a patient who comes outside a session still gets one. The sessions' patient caps limit the day's tokens.
- **Why:** patients come early.
- **Change it:** *Doctors, fees & OPD* (timings, *Add leave*).

#### The token queue

- **Rule:** each doctor's tokens start at 1 every day, and *Priority* goes first. *Next patient* finishes the patient being seen and skips one who was called and did not come in. A patient holds one token per doctor at a time.
- **Change it:** nothing to set.

#### A visit's branch

- **Rule:** a clinic visit belongs to the doctor's branch, else to the branch the front desk works at.
- **Why:** branch staff see their own branch's visits.
- **Change it:** nothing to set.

#### Lab results and reports

- **Rule:** reference ranges are set by sex and age band, with critical limits. Each result is flagged low, high, critical or abnormal as it is typed, and the range used is kept on the result. Results are entered once the sample is received in the lab. A pathologist approves a report with their PIN, and after that the results cannot change except by an amendment (below). A report cannot be signed while today's latest quality-control run for one of its parameters is rejected. The A4 report shows the lab, the patient, the collection and report times, the results with units and ranges, and the pathologist's name, qualification and registration.
- **Why:** this is NABL-style report content, and a registered pathologist signs reports.
- **Change it:** *Lab orders › Tests & panels* (ranges); *Clinic & lab settings* (lab name, registration, footer, pathologists).

#### Amended lab reports

- **Rule:** a signed report is kept as it was signed. To correct it, the pathologist amends it with a reason and their PIN; the order reopens, and signing again makes a new version that says which one it amends. The older version prints as *superseded*.
- **Change it:** nothing to set.

#### Lab quality control

- **Rule:** each run of a control is judged by the Westgard rules: 1-2s warns; 1-3s, 2-2s, R-4s, 4-1s and 10x reject. While a parameter's latest run today is rejected, patient reports with that parameter cannot be signed. A QC run is never changed.
- **Change it:** *Lab orders › Quality control* (each control's target mean and SD).

#### Outside-lab referral commission

- **Rule:** a test can be sent to an outside lab. Its name, reference and charge are recorded; the results are typed in and approved as usual, and the report says where it was tested. A referral commission is recorded only if the clinic switches it on (off by default).
- **Why:** referral commissions are an ethical and legal question. The IMC Regulations 2002 (6.4) forbid doctors from giving or receiving a commission for referrals, and "cut practice" is treated as misconduct. Take advice before switching it on.
- **Change it:** *Clinic & lab settings › Referral commission*, by someone whose role holds `settings.edit` (the Owner and the Manager by default).

### Roles by business type

- **Rule:** some roles belong to one type of business: Pharmacist to a pharmacy; Doctor, Lab technician and Pathologist to a clinic & lab; Optometrist to an optical shop; Mechanic to a garage; Trainer to a gym, studio or coaching centre. A business of that type starts with them, and other types do not get them.
- **Why:** a kirana should not see a "Doctor" role.
- **Change it:** they are ordinary roles, editable in *Roles & permissions*.

## Hardware, paints & building materials

A hardware shop sells as every goods shop does ([Shops and the shared core](#shops-and-the-shared-core)), with quotations ([A quotation's prices](#a-quotations-prices)) and these rules of its own.

### A site belongs to one customer

- **Rule:** a site (a contractor's or builder's place of work) is added under one customer and stays with them; it is closed, never deleted, and its bills stay. Only a sale to that customer goes to the site: a walk-in's bill, a purchase or another customer's bill cannot, and the database refuses a site of another customer on a bill, a quotation or a sales order. A closed site takes no new bill, quotation or order. A posted bill's site may be set, changed or taken off later by someone allowed to edit sites, and the activity log keeps each change.
- **Why:** a contractor runs several sites at once and pays for each separately; the site's ledger must hold that customer's bills only.
- **Change it:** nothing to set; who may add and change sites is the role's `hardware_sites.edit`.

### A site's ledger and orders

- **Rule:** a site's ledger is its bills (what they came to), less goods that came back and payments on those bills, plus refunds, in date order, with the running balance; what is due on a site is what is still to collect on its bills. A collection receipt counts on the site's ledger once it is put against the site's bills (money kept on account is the customer's, not a site's). Every invoice a sales order's dispatch raises goes to the order's site; setting an order's site also moves its invoices raised without one.
- **Why:** the shop and the contractor settle up site by site.
- **Change it:** nothing to set.

### Today's rates change the items' own prices

- **Rule:** a rate saved on the board is the item's price, changed as it would be on the item itself: within its MRP, with its GST slab and everything else kept, and logged as a price change. The rates in one save are saved together or not at all. A rate someone else changed after the board was opened is not overwritten. Bills and new quotations use the new price; a quotation already made keeps its own prices until it is revised.
- **Why:** a hardware shop's cement and steel prices move with the market every day; one board saves the morning's typing, and going through the item keeps one price per item.
- **Change it:** which items are on the board, on the board itself; who may change prices is the role's `catalog.edit`.

### A fitter's commission is fixed with the bill

- **Rule:** a bill names at most one fitter, when it is posted (Quick bill, New sale, or the bill made from a quotation); a fitter switched off cannot be named. Each line earns by one rule: the item's own, else the nearest category's up the tree, else the rule for every item; one rule of each is on at a time. A percent is of the line's value before GST, after discounts; an amount per unit is for each stock unit of that one item, and never more than the line's value. The commission is worked out in paise when the bill is posted and kept with it: changing or switching off a rule later never changes it, and the database refuses any change to it. Goods taken back on the bill take back the line's commission in proportion to what has come back so far, so a line returned in parts gives back exactly what it earned.
- **Why:** a fitter is owed what the bill earned when it was made; rates change, the bills behind them do not. A return undoes the sale it belongs to, and the commission with it.
- **Change it:** the rules on *Customers & contractors › Fitters › Commission rules*; who may change them is the role's `fitter_commission.edit`.

### A fitter is paid what is due, through the expense book

- **Rule:** what a fitter is due is what their bills earned, less what returns took back, less what they were paid. A payout is never more than that. Each payout is a paid expense of the shop, dated today at the location that paid, so the day's money counts it; reversing that expense takes the payout back and the amount is due again. Paying needs both `fitter_commission.approve` and `expenses.create`. Commission records and payouts are never edited or deleted.
- **Why:** money paid to a fitter leaves the drawer or the bank like any other expense, and the books must show it once.
- **Change it:** who may pay is the role's `fitter_commission.approve`.

## Seeds, fertilisers & pesticides

A farm-input shop sells as every goods shop does ([Shops and the shared core](#shops-and-the-shared-core)), and with its tools on (*Seeds, fertilisers & pesticides*) each item says what kind of farm input it is: fertiliser (subsidised or not), seed, pesticide, bio-input or another item. These rules follow from that. Each is checked by the server before the bill is saved, and again by the database where the bill's farm-input lines are kept. Review them with an agriculture officer of the state before trading: licence validity and dealer rules differ by state.

### A fertiliser, seed or pesticide sells only under a licence in force

- **Rule:** while *Licences & registrations* is on, a bill line of a fertiliser, a seed or a pesticide is refused unless the selling location holds, that day, a licence in force that covers fertilisers, seeds or insecticides respectively. The refusal says which licence is missing, switched off, run out (and when) or not yet valid. With *Licences & registrations* off, bills are not checked against licences, and *Settings › Farm input checks* says so. Bio-inputs and other items need no licence here.
- **Why:** the Fertiliser (Control) Order 1985, the Seeds (Control) Order 1983 and the Insecticides Rules 1971 each require the dealer to hold an authorisation or licence for each place of business; selling without one is selling unlicensed.
- **Change it:** keep each location's licences under *Settings › Licences*; switch the check off by switching *Licences & registrations* off in *Settings › Business tools*.

### A banned molecule is never sold

- **Rule:** a pesticide's active molecules are kept with the item, by name. An item made of a molecule the molecule list marks *banned* cannot be added or given that molecule, and is never billed, even if the molecule was banned after the item was made. The database refuses both.
- **Why:** a molecule banned for use in India must not reach a farmer from the shop.
- **Change it:** nothing to set: the list is the platform's (below).

### A molecule barred on some crops is never sold for them

- **Rule:** a pesticide made of a molecule barred on some crops (for example chlorpyrifos on ber, citrus and tobacco) is billed only with the crop the farmer is buying it for: the line's own, or the bill's. The crop is matched to the crops the list names, by name or another name (jowar is sorghum); a barred crop refuses the bill. Any other crop is kept with the line as it was said. A crop the list names as a group (vegetables; fruits and vegetables eaten raw) is matched only when it is said as that group, so the counter shows the barred crops for the cashier to ask about.
- **Why:** S.O. 4294(E) of 3 October 2023 bars some molecules on named crops while allowing them on others; only the crop tells the two apart.
- **Change it:** nothing to set.

### The molecule list is the platform's, and only what is cited

- **Rule:** the molecule list (*Farm inputs › Molecules*) is platform data, the same for every shop and changed only by the platform. Each entry has its status (banned, restricted use or barred on some crops), the crops it must not be used on, its rule in words and the order it comes from. It holds only entries with a cited source: six banned molecules, five restricted ones and seven barred on named crops. A restricted-use molecule (aluminium phosphide, methyl bromide, DDT, the 3% smoke generator of cypermethrin, carbofuran other than its 3% CG) is shown with its rule on the item form and at the counter; the bill is not refused for it.
- **Why:** a list a shop could edit would not protect anyone, and an entry without its source cannot be checked.
- **Change it:** the platform adds and corrects entries with a migration as orders change ([BACKLOG.md › Left inside built modules](BACKLOG.md#7-left-inside-built-modules)).

### A seed lot is sold only while valid

- **Rule:** a seed is kept by batch, and a seed lot's expiry is its validity date: the test date on its tag plus 9 months (6 months more after a passing retest). A receipt of seed, or a seed's opening stock, needs that date. A lot past it is not sold: the bill is refused, naming the lot and the date. A pesticide is kept by batch too, and a batch past its expiry is refused the same way, to be kept apart and marked not for sale.
- **Why:** seed certification fixes a lot's validity from its test date, and the Insecticides Rules forbid selling expired stock.
- **Change it:** nothing to set; a lot's date is the one given when it is received.

### A subsidised fertiliser carries its PoS receipt

- **Rule:** a fertiliser marked *subsidised* is billed only with the receipt number the government's PoS device printed for the sale (letters, digits, - and /): one for the bill, or one on each line. It is kept with each subsidised line and printed on the bill. No Aadhaar number is ever asked for or kept; the Farmer ID kept with a farmer is the Agri Stack one. A PoS receipt on any other line is refused.
- **Why:** every subsidised fertiliser sale goes through the Aadhaar-checked PoS device, and the company is paid the subsidy only on those; with no link to the PoS, the receipt number is what ties the bill to the PoS sale.
- **Change it:** the item's *Subsidised* box.

### The PoS stock is typed in, never changed

- **Rule:** *Type the PoS stock* keeps, for each subsidised fertiliser at a location, what the PoS device shows and the shop's own stock at that moment, under the business's date. The reconciliation shows, by day and fertiliser, the bags billed, the bills and PoS receipts, what came back, and the last entry of the day with its difference. Entries are never changed or deleted; a mistake is put right by typing it again.
- **Why:** the shop's stock and the PoS's must agree; the difference is what the company and the inspector look at.
- **Change it:** nothing to set.

### Season credit is due at the harvest

- **Rule:** a bill left on udhaar for a named customer may carry the season it is for (kharif, rabi or zaid, of the year before, this year or the next) and the harvest date it falls due (today or later, at most 400 days away). That date is the bill's due date, so the bell, Udhaar and the dues by village count it as overdue only after it. A walk-in's bill, or one paid in full, carries no season. The season is kept with the bill and never changed.
- **Why:** farmers buy on credit for a crop and pay when it is harvested.
- **Change it:** given on each bill at Quick bill.

### The registers come from the transactions

- **Rule:** the stock and price board (each fertiliser's and seed's opening stock on a day, and its closing stock once the day is over), the monthly seed stock return and the insecticide sale register are worked out from the bills, purchases, returns and stock movements of the location, on the business's own clock; nothing is typed twice. The board shows today's price and MRP. The seed return gives quintals where an item's unit is a weight or its weight of one is given; its other changes are corrections, counts and transfers. It is due by the 5th of the next month.
- **Why:** the Fertiliser (Control) Order and the Seeds (Control) Order require a daily display of stock and prices, the Seeds (Control) Order a monthly return, and the Insecticides Rules a record of insecticide sales with their batches; working them out from the same records keeps them true to the books.
- **Change it:** nothing to set.

## Optical shops

An optical shop sells as every goods shop does ([Shops and the shared core](#shops-and-the-shared-core)); with *Prescriptions & spectacle orders* on it also keeps its customers' prescriptions and makes spectacles to order through a lab or its own workshop. Each rule below is checked by the server, and the ones about records that must not change are held by the database too.

### A prescription's powers are checked as they are written

- **Rule:** each eye has at most one row for distance, near and intermediate vision. SPH and CYL go in steps of 0.25 from -30 to +30 (plano is 0.00). AXIS is a whole number of degrees from 1 to 180, given with a CYL other than 0 and only then. ADD goes from +0.25 to +4.00, on the near or intermediate row only. A prism (0.25 to 20 prism dioptres, in steps of 0.25) has its base: in, out, up or down. A row needs at least one of them or the visual acuity, and a prescription at least one row. The PD is of both eyes together or of each eye, never both. The test is never on a day still to come. A refusal names the eye, the vision and the power.
- **Why:** a spectacle prescription is written per eye and vision in quarter-dioptre steps, with the axis of a cylinder; a power typed wrong makes the wrong lenses.
- **Change it:** nothing to set.

### The examiner is named, with a registration number from outside

- **Rule:** a prescription is examined by a member of the business, named as they are, or by an outside doctor or optometrist, named with the registration number on their prescription (required). A member's registration number is optional; the form offers the one on their latest prescription. Both print on the prescription.
- **Why:** optometrists are a listed profession under the National Commission for Allied and Healthcare Professions Act, 2021, so who examined, and their registration, belongs with the powers.
- **Change it:** nothing to set.

### A prescription on a spectacle order never changes

- **Rule:** a prescription can be corrected, its customer included, until a spectacle order uses it; the activity log keeps what was and what is. From then on it and its powers never change, and the database refuses it: a correction is a new prescription. A spectacle order keeps a copy of the prescription as it was when booked. A prescription is never deleted.
- **Why:** the spectacles were made from those powers; what the lab was given must stay as it was.
- **Change it:** nothing to set.

### Valid a year, due for a test after the recall months

- **Rule:** a prescription is valid until a year after its test unless another day is given (on or after the test, at most five years after it). The recall list holds every active customer whose latest test was the recall months ago or more: 12 to start with, any whole number from 1 to 60.
- **Why:** no rule was found that sets how long a prescription stays valid or how often to test again, so the year is a starting value each shop changes.
- **Change it:** *Valid until* on each prescription; the months on *Customers › Recall list*, by a role that holds `settings.edit`.

### An order is priced at booking, and billed with the day's GST

- **Rule:** an order's items (the frame from stock, the lens items, other items) are priced when it is booked exactly as a sale of them would be then: customer and slab prices, branch prices, running offers, the discount (with its reason, within the counter's limit), GST and round-off. The order keeps those prices; the frame, the lenses and the prices never change once booked. Delivery posts the bill at them, with GST at each item's rate on the day of the bill: a price that includes GST keeps its total and its GST is worked out again from it; a price before GST keeps its taxable value. Delivery is refused when an item is switched off, its pack size changed, or what the bill would charge for one unit is above its MRP now.
- **Why:** the customer agreed the price when they ordered; GST is the rate of the day of the invoice, and nothing is sold above its MRP.
- **Change it:** nothing to set; GST is each item's slab (spectacles, frames, spectacle and contact lenses 5%, sunglasses 18%).

### Stock leaves at delivery

- **Rule:** nothing leaves stock when an order is booked. The frame and the other goods leave stock at delivery, from the order's location: a batch item oldest expiry first, and an item not in usable stock there (or past its expiry) stops the delivery until it is received. Stock is not held for an order: Quick bill can sell the same frame meanwhile, and the order then shows it short.
- **Why:** the bill and the stock move together, when the customer takes the spectacles.
- **Change it:** nothing to set.

### The advance is the customer's money on account

- **Rule:** an advance taken at booking is a numbered collection receipt in the customer's name, by cash, UPI, card or bank, and never more than the order's total. It pays first when the order is billed. On a cancelled order it stays the customer's: it is handed back from the order (all that is left, or part, by cash, UPI or bank, with a reason and a manager's PIN), or it stays on their account for a later bill. The cash limit counts it like any collection.
- **Why:** until the spectacles are billed the money is the customer's; money leaving the drawer needs a second person's say-so.
- **Change it:** who may take an advance is the role's `sales.edit`; who may approve handing it back, `sales.refund`.

### The work goes one step at a time, and the quality check is signed

- **Rule:** an order goes from booked to the lab or the workshop, between the two, to the quality check, and from the quality check to ready (passed) or back to the lab or the workshop (failed, with what was wrong); ready spectacles found wrong go back the same way, with the reason; ready goes to delivered. Steps are never skipped and the database refuses any other move. Passing or failing the quality check needs `optical.approve`, and a pass is stamped with who and when; an order is ready only after a pass. Cancelling needs a reason. A delivered or cancelled order never changes, and nothing about an order is deleted; every step is kept with who made it.
- **Why:** finished spectacles are checked against the prescription before the customer gets them, and the job's history shows who did what.
- **Change it:** who passes the quality check is the role's `optical.approve` (the owner, a manager and the optometrist by default).

### A lens needs its fitting, and a multifocal its near power

- **Rule:** each lens on an order needs powers for its eye on the prescription and that eye's fitting PD. A bifocal or progressive lens also needs the near power (an ADD, or a near SPH) for its eye on the prescription and that eye's fitting height.
- **Why:** a lens is centred on the eye's PD, and a bifocal or progressive lens is placed by its fitting height and made with the reading power.
- **Change it:** nothing to set.

### A remake is linked to its order, and costs the customer nothing unless they bear it

- **Rule:** only a delivered order is made again, for its own customer: a new order linked to it, with the reason and who bears the cost (the lab, the shop or the customer). When the lab or the shop bears it, the order costs the customer nothing (the database holds its total at 0): no discount, no advance, and a bill of 0 when it takes stock at delivery. When the customer bears it, it is priced as any order.
- **Why:** a lab's mistake, a breakage under the shop's promise or a customer who cannot get used to the lenses is not the customer's cost, and the link keeps the job's whole story.
- **Change it:** nothing to set.

### Each contact-lens power is an item

- **Rule:** with Variants on, the power grid makes one item for each power of the ranges given (from -20.00 to +20.00, in steps of 0.25 or 0.50; at most 200 at a time and 300 for one product), all of one product with one base curve (7 to 10 mm) and one diameter (12 to 16 mm), each keeping its power, base curve and diameter. A power the product already has is left as it is; another base curve or diameter is another product. Each power then has its own price, stock and batches like any item.
- **Why:** contact lenses are stocked and sold power by power.
- **Change it:** each power's price and details on the item.

### The MD-42 registration is kept as a licence

- **Rule:** the medical device sale registration (MD-42) is kept under *Settings › Licences* with its number and dates; the bell warns before a date it is given runs out. Contact-lens bills are not refused without it.
- **Why:** anyone selling contact lenses without a licence for them needs the MD-42 registration (G.S.R. 754(E) of 30 September 2022); keeping it where every licence is kept shows it with its dates.
- **Change it:** *Settings › Licences*.

## Vehicle service & auto parts

A garage sells parts as every goods shop does ([Shops and the shared core](#shops-and-the-shared-core)); with *Vehicles & job cards* on it also keeps its customers' vehicles and works on them with job cards, from the estimate the owner approves to the bills. Each rule below is checked by the server, and the ones about records that must not change are held by the database too.

### A vehicle is its registration number

- **Rule:** a registration number is kept as it is on the plate: capital letters and digits only (spaces, dashes and dots are left out), 4 to 15 of them with at least one letter and one digit. A business has one vehicle per number and one per chassis number. Its owner is a customer; a change of owner keeps every owner it has had, with when and who recorded it, and the database writes that history and refuses to change it. A vehicle is never deleted: one sold or scrapped is switched off, once no job card of it is open.
- **Why:** a plate is typed many ways (*TS 09 EA-4521*, *ts09ea4521*); kept one way, it finds the vehicle however it is typed. A vehicle's history stays with it when it changes hands.
- **Change it:** nothing to set.

### A reading lower than the last needs a manager

- **Rule:** every odometer reading is kept (in and out of a job card, or typed on the vehicle), and the vehicle's latest reading is the newest one. A reading lower than the last is refused unless someone whose role holds `garage.approve` approves it with the reason: they give only the reason themselves; anyone else names them and they type their PIN. The database refuses a lower reading without that approval, and an approval on a reading that is not lower. Readings are never changed or deleted. The kilometres a vehicle runs in a day are worked out from its readings since the last approved lower one.
- **Why:** an odometer only goes up. A lower reading is a typing mistake, or a meter replaced or reset, and a manager says which; reminders by kilometres depend on the readings.
- **Change it:** who may approve is the role's `garage.approve` (the owner and a manager by default).

### The estimate has versions, and the owner approves what they pay

- **Rule:** each change to the estimate saved is a new version, kept as it was: who, when, the lines, the total and the insurer's lines. An approval records who approved, how (in person, by phone or on WhatsApp), when (never in the future), and the amount: the total of the version approved. A version that comes to more than the owner last approved, a revision or parts a mechanic adds, sends the job card back to *Estimate sent* until they approve again; one that comes to less keeps the approval. A received job card may go straight to work (a quick job) without one. Versions and approvals are never changed or deleted.
- **Why:** a workshop does not bill more than the owner agreed to, and the record shows who agreed to what, and how.
- **Change it:** nothing to set; who sends estimates and records approvals is a role holding both `garage.view` and `garage.edit` (the owner, a manager and a cashier by default).

### Parts are priced as a sale would be, and leave stock when the job is billed

- **Rule:** a part is an item kept in stock; labour and outside work are service items, and outside work needs its charge and the workshop that did it. A part is priced at the customer's price for it (their price list, the branch's price or the item's price) unless a rate is typed: a lower rate is a discount and needs `sales.discount`, and no part is charged above its MRP. Nothing leaves stock until the job is billed; then each part leaves stock at the job card's location (a serial-numbered part by its numbers, a batch by the oldest expiry first), and a part not in usable stock there stops the billing until it is received. The bill keeps the job card's prices with GST at each item's rate on the day of the bill: a price that includes GST keeps its total, a price before GST its taxable value; a part charged above its MRP that day stops the billing.
- **Why:** the stock and the bill move together, so a job card cancelled before it is billed leaves the stock as it was; the customer agreed the estimate's prices, and GST is the rate of the day of the invoice.
- **Change it:** nothing to set; GST is each item's slab (parts and labour 18%, the tractor parts the GST Council listed 5%).

### A job card's steps

- **Rule:** a job card goes from received to estimate sent, approved, in progress, waiting for parts and ready in the order the work needs (a received job card may start straight away); *Estimate sent* waits for the owner's approval of the version sent; a ready vehicle goes back to work only with the reason; *Ready* goes to delivered by billing the job. The database refuses any other move. A job card with lines is delivered only with its bill. Cancelling needs a reason. A delivered or cancelled job card never changes, nor do its lines, mechanics and claim. Every step is kept in the history with who made it.
- **Why:** the board shows where every vehicle is, and the history who did what.
- **Change it:** who cancels is the role's `garage.cancel` (the owner and a manager by default).

### A mechanic works on the job cards assigned to them

- **Rule:** someone whose role holds `garage.edit` but not `garage.view` (the Mechanic) sees only the job cards they are put on: they record the work done, add the parts they used (at the customer's price, as a new version) and move the job along (in progress, waiting for parts, ready), and print its copies. They see no prices, totals, bills or advances unless their role also holds `sales.view`. Sending the estimate, recording approvals and claims, taking an advance, and billing and delivering are the desk's. Only active members whose role holds `garage.edit` (or full access) can be put on a job card.
- **Why:** the mechanic does the work; the money and the owner's say-so are the desk's.
- **Change it:** *Roles & permissions*.

### A cashless claim is two bills that add up to the job

- **Rule:** a job card's claim names the insurer (a customer, never the job card's own), cashless or reimbursement, the policy number, the claim number, the surveyor, the amount the insurer approved (more than 0; in whole rupees where the business rounds its bills to the rupee), the deductible and the depreciation. Each line is paid by the customer or, on a claim, by the insurer. A cashless claim is billed as two bills: one to the insurer for exactly the approved amount, spread over its lines in proportion to their value and rounded on the running total so the parts add up to the paisa; and one to the customer for their own lines and the owner's share of the claim (the insurer's lines less the approved amount: the deductible, the depreciation and what was not allowed), billed as one line of the claim-share item. The two bills come to the job's total exactly. Billing waits until the approved amount and the claim number are in, the approved amount (and the approved amount with the deductible and the depreciation) is not more than the insurer's lines, and the claim-share item is set. A reimbursement claim is billed to the customer for the whole job, naming the claim. The claim is taken off only by making its lines the customer's (*Take the claim off* does both); the claim of a delivered job card never changes.
- **Why:** CBIC Circular 217/11/2024-GST describes the garage issuing two invoices on a claim, one to the insurance company for the approved claim cost and one to the customer for the repair in excess of it (the compulsory deductible, depreciation, what the cover leaves out); the insurer may take input tax credit on the invoice in its own name. On reimbursement the insured pays the garage and the insurer repays them up to the approved claim cost.
- **Change it:** the claim-share item in *Settings › Garage settings*. The owner's share is billed at that item's GST slab, whatever the slabs of the insurer's lines: have an accountant confirm it where those lines carry another slab (tractor parts at 5%).

### The advance is the customer's money on account

- **Rule:** an advance on an open job card (one, when it is opened or later) is a numbered collection receipt in the customer's name, by cash, UPI, card or bank, and never more than the job's total once there is an estimate. It pays first when the job is billed. On a cancelled job card it stays the customer's: it is handed back from the job card (all that is left, or part, by cash, UPI or bank, with a reason and a manager's PIN), or it stays on their account for a later bill. The cash limit counts it like any collection.
- **Why:** until the job is billed the money is the customer's; money leaving the drawer needs a second person's say-so.
- **Change it:** who may take an advance is a role holding `garage.view`, `garage.edit` and `sales.edit` (the owner, a manager and a cashier by default); who may approve handing it back, `sales.refund`.

### The next service, and who is due

- **Rule:** billing a job sets the vehicle's next service: by date, the garage's months after the bill, and by reading, its kilometres after the reading out (or in), to start with; or the day and reading typed (a day after today within five years, a reading above the vehicle's), or none. A job card with nothing on it, delivered with no bill, leaves the vehicle's next service as it was. *Service due* holds every vehicle in use whose next service falls within 7 days, by its date or by the day its kilometres a day will take it to the reading due, and every one whose insurance or PUC runs out within 30 days or has run out. Each reminder given (WhatsApp, a call) is kept; one in the last 30 days counts as recent.
- **Why:** a service falls due by months or by kilometres, whichever comes first; the reading is projected from the odometer log, so the reminder goes before the reading is reached.
- **Change it:** the months (1 to 36, 6 to start with) and kilometres (500 to 100,000, 5,000 to start with) in *Settings › Garage settings*, by a role that holds `settings.edit`; each job's own on its bill.

## Gyms, studios & coaching

A gym, a studio or a coaching centre sells its plans as services on bills of the shared core ([Shops and the shared core](#shops-and-the-shared-core)); with *Plans & memberships* on it also keeps each member's memberships, checks members in at the desk and splits fees into instalments. Each rule below is checked by the server, and the ones about records that must not change are held by the database too.

### A plan is its own service item, and its GST is the item's

- **Rule:** a plan is sold as a service item of the catalogue, its own (no other plan's, and never a joining fee), made with the plan from the price, GST slab and SAC typed, or an existing service chosen. A joining fee is another service item. The bill takes each line's GST from its item's slab. A plan keeps its item for good (its price changes on the item) and is switched off, never deleted.
- **Why:** from 22 September 2025, the services of a gym, health club, fitness centre or yoga centre (SAC group 99972) are at 5% without input tax credit, and the 5% is mandatory: CBIC says the provider cannot charge 18% with credit instead. Coaching and tuition (999293) and dance, music and art classes (999291) stay at 18%. A studio selling both bills each plan under its own slab.
- **Change it:** each plan's slab and SAC on the plan (*Settings › Membership plans*) or on its item; have an accountant confirm them.

### A membership keeps its terms as sold

- **Rule:** a membership keeps, from the day it is sold: the plan's name and kind, its days or months and sessions, the price as billed (the plan's line: its taxable value, GST and rate), the joining fee billed with it, the refund policy's version, the freezes and days it may be frozen, its grace days and whether it can be passed on. Its first day and its last day as sold never change; its last day moves only by its freezes. A later change to the plan applies to memberships sold from then on. The database refuses any other change, and a membership is never deleted.
- **Why:** what a member bought, and the policy they were given, are what count if they cancel or complain. The coaching-centre guidelines of the Ministry of Education (2024, as reported) also ask that a course's fee is not raised while it runs.
- **Change it:** nothing to set.

### The refund policy is kept in versions

- **Rule:** every plan has a refund policy, written when the plan is made. A changed policy is the plan's next version; every version is kept as it was written, and a membership keeps the version it was sold with, which prints on its membership slip.
- **Why:** a district consumer commission has held a membership's blanket "no refund under any circumstances" term unfair, noting that the terms had never been given to the member; a policy stated, given and kept as sold is the business's answer to a complaint.
- **Change it:** the policy on the plan (*Settings › Membership plans*).

### When a membership runs, and renewals

- **Rule:** a membership starts today or on a later day within 180 days. By days, its last day is so many days later counting the first; by months, the day before the same date so many months on (the month's last day when it has fewer). A pack of sessions has no last day: it runs until its sessions are used, unless it is sessions within a time. A renewal starts the day after the membership it renews ends, while it runs or within its grace days, and from today once they are past; a membership is renewed once. Two memberships of one plan with a last day never overlap for a member (packs of one plan may: the oldest is used first). A membership closed by a cancellation, a transfer or an upgrade ends on its last day counted.
- **Why:** a member who renews on time keeps the days they paid for, without a gap or two plans paid for the same days.
- **Change it:** nothing to set; the plan's days, months and grace days on the plan.

### Freezes stay within the plan's limits

- **Rule:** a membership with a last day is frozen from today or a day within 60 days, between its first and its last day, for at most the days and in at most the freezes its plan allowed when it was sold (both or neither); freezes of a membership never overlap. Its last day moves on by the days frozen. When the member comes back early, the freeze ends that day and counts only the days up to it; a freeze ended before it began (called off) counts no days and no freeze. A frozen membership lets no one in. A membership followed by its renewal is not frozen. Freezes are never deleted.
- **Why:** a member away for a while keeps the days they paid for, within what the plan promised; a renewal already sold starts on its own day.
- **Change it:** the freezes and days on the plan; who freezes is the role's `member_plans.edit` (the owner, a manager and a cashier by default).

### Who is let in at the desk

- **Rule:** a member is found by their code (typed or scanned from the QR on their slip) or by a search, and let in on a membership that runs that day: started, not closed, not frozen, within its last day or its grace days after it, with a session left on a pack. Otherwise they are turned away with the reason: no membership, not started yet, over (grace days past), frozen, no sessions left, or fees overdue. A pack loses one session a day: a second visit the same day uses none. The membership used is the one asked for, else one by time before a pack (no session is used then), the pack ending first before the others. Every check-in is kept, let in or not, on the business's date, and never changed.
- **Why:** the desk knows at once whether to let a member in and why not; the record shows who came, when and on what.
- **Change it:** the grace days on the plan; who checks members in is the role's `member_plans.create` (the owner, a manager, a cashier and a trainer by default).

### Fees overdue turn a member away

- **Rule:** a member whose fees are overdue by more than the business's days is turned away at check-in, even with a membership running: a bill past its due day, or for a fee in instalments an instalment past its own, not yet paid. The desk sees how much; a trainer does not.
- **Why:** a member with fees long unpaid is asked to pay before training on.
- **Change it:** *Fees overdue at check-in* in *Settings › Membership plans* (7 days to start with; 0 to 365, or *Never turn a member away for fees*), by a role that holds `settings.edit`.

### What a cancellation gives back

- **Rule:** a running membership is cancelled with a reason. Its days used are counted from its first day to the day of cancelling, both counted, less the days frozen (none when it has not begun); a pack's are its sessions used. What may come back is the part not used of the price as billed: the days left over the days sold, the sessions left over the sessions sold, or for sessions within a time the smaller of the two, worked out to the paisa (halves up). Less may be given back, and the joining fee may be given back in full too. What comes back is a credit note on the membership's bill (its GST in the line's own proportion, adding up exactly); what the member paid beyond what is then due on the bill is refunded by cash, UPI, card or bank, and what they had not paid is simply owed less. Anything given back needs `member_plans.refund` and a manager's approval with their PIN (`member_plans.approve`; their own PIN when they cancel it themselves). A membership passed on by another member gives nothing back. The bill lines that sold a membership come back only on its own credit note: the database refuses a return of them made any other way.
- **Why:** the member pays for what they used; the coaching-centre guidelines (2024, as reported) ask for a pro-rata refund within 10 days when a student leaves midway, and the refund here is paid on the day. Money leaving the drawer needs a second person's say-so.
- **Change it:** who cancels is the role's `member_plans.cancel`, who gives back `member_plans.refund`, and who approves `member_plans.approve` (the owner and a manager by default).

### An upgrade's credit pays the new bill first

- **Rule:** a running membership is upgraded to another plan from today; its last day counted is yesterday (the day before its first day when it has not begun). The part not used, worked out as for a cancellation, comes back as a credit note on its bill, and what the member paid beyond what is now due on it pays the new plan's bill first: a refund by credit note on the old bill and a payment by credit note on the new one, so no money moves. A credit bigger than the new plan's bill is refused (a cancellation with its refund, then a new sale, moves a member to a cheaper plan). A membership passed on by another member is not upgraded.
- **Why:** the member keeps the value of what they did not use, and the two bills add up to what they paid.
- **Change it:** who upgrades is a role holding `member_plans.edit` and `sales.create` (the owner, a manager and a cashier by default).

### A membership passed on keeps its bill

- **Rule:** a membership is passed on to another member only when its plan allows it, it is not frozen and has no freeze to come, and nothing is left to pay on its bill. It closes as transferred, and the other member's membership carries on from today (or its first day, when it has not begun) to its last day, with its sessions and freezes left, on the same bill and policy version. Nothing comes back from it later: the bill is the first member's.
- **Why:** the first member paid for it; what is left passes on, not the money.
- **Change it:** *Can be passed on* on the plan.

### Instalments add up to the bill

- **Rule:** a fee in instalments has 2 to 36 of them, each with its due day (the first today or later, the last within three years, each after the one before) and amount, adding up to the bill exactly; they are set with the sale and never changed, and the bill falls due on the last of them. Payments on the bill, less refunds, cover the instalments in order; one past its day not fully covered is overdue. A cancelled or upgraded membership's instalments no longer fall due.
- **Why:** a coaching fee paid in parts has its days agreed at enrolment, and each payment is a numbered receipt.
- **Change it:** nothing to set.

### A plan's item is sold only with its membership

- **Rule:** a bill with a plan's item is posted only by Members & plans, which writes the membership with it; the core refuses that item on any other bill of the business while the tool is on.
- **Why:** every plan sold has its membership, so the desk, the renewals and the dues agree with the bills.
- **Change it:** nothing to set.

### A trainer sees no money

- **Rule:** the Trainer sees members, their plans and check-ins, checks members in, and sees personal-training sessions and marks them done or missed. Memberships show without prices, bills or dues to anyone whose role does not hold `sales.view`, and the fees due list is for those who do. Selling a membership also needs `sales.create`.
- **Why:** the floor staff train members; the money is the desk's.
- **Change it:** *Roles & permissions*.

## Restaurant and food formats

### Advance on a pickup order

- **Rule:** a takeaway ordered ahead can take an advance from its order row (*Orders › More › Take advance…*) while it is open and not yet billed. It is an ordinary restaurant advance (receipt number, drawer, GST tables 11A and 11B) that remembers the order; an order without a guest gets the paying guest put on it. At billing, the bill offers that advance first and selects it for the amount due. A cancelled order's advance stays held and is handed back from *Dues & accounts › Advances* with a manager's say-so, like any advance.
- **Why:** the restaurant's advances already handle the money, the GST and the refund rules. Linking the advance to the order is all a pickup order needs.
- **Change it:** the *Advances* feature, and who holds `payments.manage` (who may take it).

### Formats: restaurant, café, bakery, cloud kitchen

- **Rule:** a restaurant is a restaurant, a café, a bakery or a cloud kitchen. The format sets the kinds of order the POS takes, the one a new order starts on, token numbers, and the features it starts with. A café starts on takeaway with tokens. A bakery takes takeaway and delivery, with recipes, advances and pre-orders, and no tables. A cloud kitchen starts on delivery, with online ordering, deliveries and brands, and no tables. The server refuses a kind of order the POS does not take. Each setting can be changed afterwards, and changing the format deletes nothing.
- **Change it:** the platform team picks the format when it creates the restaurant (*Platform › Restaurants*). Afterwards the owner changes it in *Settings › Features › Format*, and the kinds of order in *Service settings › Orders the POS takes*.

### Pre-orders

- **Rule:** a pre-order's advance is an ordinary customer advance, in the day's cash, so it needs *Advances & deposits*: while that is off, a pre-order is booked without one, and the server refuses an advance, on booking or later. When the till cannot take it (no business day open, say), the pre-order is still booked and a warning says so; *Take advance* on the pre-order takes it later. On hand-over the pre-order becomes a takeaway order on today's business day, and its bill takes the advance first. A cancelled pre-order's advance stays held, to be handed back from *Dues & accounts › Advances*. The bake list adds up by item what is due on a day at one till: the pre-orders booked at that outlet, or, with no outlet picked, at the main counter. Asked for without a date, it uses the day that till is trading on. The kitchen's own permission (`kds.view`) reads the bake list and nothing else of pre-orders. Staff tied to an outlet see and act on that outlet's pre-orders only; everyone else sees every outlet's, whichever outlet is picked. An outlet with open pre-orders (booked, in production or ready) is neither closed nor deleted until they are handed over or cancelled.
- **Why:** an advance is spent on the bill (*From advance*) or handed back from *Dues & accounts › Advances*, and both need *Advances & deposits*: an advance taken while it is off could be neither. Each outlet's kitchen bakes what was booked at that outlet; another outlet's cakes are on that outlet's list. The kitchen bakes from the list, but takes no orders and no money. Staff tied to an outlet work at that outlet only, for pre-orders as for its bills and advances. A closed outlet's bake list is on no till, so its cakes would be baked nowhere, and a deleted outlet's pre-orders would fall to the main counter's list.
- **Change it:** the *Pre-orders & cakes* feature; *Advances & deposits*, and who holds `payments.manage` (who may take the advance) and `kds.view` (who reads the bake list); the outlet a person is tied to, in *Users*.

### Day-end unsold

- **Rule:** in a bakery or café, what will not sell tomorrow is written off at cost as waste, with the reason "Unsold at day end". What keeps stays in stock.
- **Change it:** nothing to set.

### Sold by weight

- **Rule:** a dish sold by weight is priced per kg, and the quantity on the order is the weight. The POS asks for the grams.
- **Change it:** the dish's *Sold: by weight*.

### Brands

- **Rule:** a category belongs to one brand, or to all. An order is taken under one brand, and a dish from another brand's menu is refused. The KOT and the bill print the brand. The brand report takes off each order's own aggregator commission. A paused brand takes no new orders. With the *Brands* feature off, no new order or category can be taken under a brand; orders and categories that have one keep it.
- **Change it:** *Menu › Brands*; the *Brands* feature.

### A bill never waits for stock

- **Rule:** a guest's bill is never refused for a stock shortfall. Billing may take stock below zero, and the bell then asks for a count. A manual stock-out is refused below zero. A goods shop works the other way: a sale takes only stock that is there and not expired.
- **Why:** a bill must never fail because someone forgot to record a delivery. The figure below zero is a visible signal to fix.
- **Change it:** nothing to set.
