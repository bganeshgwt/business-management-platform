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
- [Personal data](#personal-data)
- [An owner's GST thresholds](#an-owners-gst-thresholds)
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
- [Laundry & dry cleaning](#laundry--dry-cleaning)
- [Jewellery & gold](#jewellery--gold)
- [Rentals & hire](#rentals--hire)
- [Fuel stations](#fuel-stations)
- [Hotels, lodges & guest houses](#hotels-lodges--guest-houses)
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

- **Rule:** someone with no restaurant role (a kirana cashier, say) lands straight on their business: the one they opened last, else the first in their list. Restaurant staff land on their restaurant's dashboard, or on the business they opened last when that is another business. A platform Super Admin lands on *Platform › Restaurants*. Until a person's businesses are known, the home address shows the loading screen with no header or menu, so a business never opens under the restaurant's header first; opening another business from the switcher draws its header with its loading screen at once.
- **Why:** a shop's staff should never see the restaurant dashboard, and a header that says the restaurant while a shop opens sends people to the wrong menu.
- **Change it:** nothing to set. The business switcher moves between businesses.

### A business's name

- **Rule:** a business's name (the one the switcher, the header and every screen show) is changed in *Business settings › Business details › Business name* by the owner or anyone whose role may change the settings (*settings.edit*): trimmed, 1 to 150 characters, as when the business is created. Another business of the same owner may have the same name, as at creation. Each rename is written to the business's activity log with the old and the new name. The name printed on bills (*Name shown in the app*) is its own setting. A restaurant's business takes its restaurant's name: the restaurant is renamed on its *Profile*, and the database renames its business with it (and logs it); the business's settings refuse a name of their own for it.
- **Why:** a shop renamed in real life must not keep its old name on every screen; the type and the code stay, so bills and reports keep their numbers.
- **Change it:** nothing to set.

### A password someone else set is changed at the first sign-in

- **Rule:** a password someone else sets for a person works for one sign-in only. That covers a new login's first password (made in a restaurant's *Users*, in *Staff & access*, on the platform screens with a new restaurant or business, or with `npm run user:create`) and every new password an admin or the platform sets for someone. After it, and after the two-step code where the person uses one, they choose their own password before anything else opens: the server refuses every other request until they have. The new password follows the usual rules (8 to 72 characters) and must differ from the one they were given. Choosing it signs them out on every other device, and they carry on to the page they were opening. A person who changes their own password in *My profile* is not asked again.
- **Why:** whoever set the password knows it, and until the person changed it they could sign in as that person and do whatever their role allows.
- **Change it:** nothing to set. The database marks every password written by anyone but the person themselves, so no screen or script can leave one out.

### A PIN someone else set is replaced at its first use

- **Rule:** a PIN someone else sets for a person (an admin, under a restaurant's *Users*) is marked as set by another until the person chooses their own. Until then it still unlocks the person's own till, takes a shared till over for them and switches a shop's till to them, and at once asks them to choose their own PIN with their password: a till unlocked with it opens only after that, and a till taken over or switched with it opens a session that answers nothing else until they have. The new PIN follows the usual rules and must differ from the one they were given. Meanwhile it approves nothing as them: a manager's approval at the restaurant's till, a business manager's PIN (a refund, an override, money handed back), a credit hold's release, a pharmacist's, doctor's or pathologist's signature and a counter bill's PIN refuse it with the reason (409 `pin_not_own`) before reading it, so no try is spent; a till switched with it gives the next bill no proof. Every prompt that lists who may approve or sign shows such a person greyed, as *PIN not their own yet* with the reason, and does not let them be picked: the restaurant's approval prompt, and a business's own (a manager's approval, a credit hold's release, a pharmacist's or pathologist's sign-off, and the counter bill's PIN for the person billing); each list's answer says whose PIN someone else set. The person's own PIN (*My profile › Personal PIN*, or the step a till asks for) clears the mark, and so does removing the PIN; an admin setting their own PIN under *Users* sets their own. Both are in the activity log: the PIN set by another, and the person's own replacing it. PINs set before this rule are not marked: who set them is not known.
- **Why:** whoever set the PIN knows it, and until the person changed it they could unlock or take over a till as that person, or approve as them; the owner's rule is that the person chooses their own at its first use, as with a password someone else set.
- **Change it:** nothing to set. The time clock's PIN (*Staff → Time clock*, set by a manager) is a separate PIN for clocking in and out, and approves nothing.

### One till, many cashiers: the per-staff PIN

- **Rule:** a shop's till stays signed in. A cashier taps *Switch* on Quick bill, picks their name and types their own PIN, and the till carries on as them. The bill being built stays. Every bill records the person the till was switched to. With *Ask the biller's PIN for every bill* on, Quick bill asks that person's PIN before each bill, and the server refuses a counter bill without it. The PIN is the person's own personal PIN (*My profile › Personal PIN*, or set by an admin, which switches the till but confirms no bill until they choose their own: [A PIN someone else set is replaced at its first use](#a-pin-someone-else-set-is-replaced-at-its-first-use)), with the usual lockout, the account lock and the two-step device rule. Only people whose role may create sales are offered. *Prescription sale* has the same *Switch* and PIN rule; a Schedule X sale still needs the registered pharmacist's own PIN, whoever is billing.
- **Why:** several people run a shared till in Indian shops. A quick PIN switch keeps each bill's biller on record without signing out in a rush, and it reuses the restaurant till's PIN rules.
- **Change it:** *Business settings › Prices, totals and numbering › Shared till* (default: ask the PIN only to switch). The PIN is never stored with the bill.

### The switch's PIN counts for the next bill

- **Rule:** with *Ask the biller's PIN for every bill* on, the PIN typed to switch the till also counts for the next bill: the switch gives the till a proof (random, never shown) that is good for one counter bill (Quick bill or *Prescription sale*), within 2 minutes of the switch, by the person the till was switched to, in that business, from the session the switch began. The server keeps only its SHA-256 and spends it inside the bill's own posting: a bill refused for another reason (stock, a credit limit) leaves it for the next try, and the same bill sent again (its answer lost) is answered with it. Used, run out, or after a page reload, the PIN is asked as before. The screen keeps the proof in memory only and never keeps or sends the PIN again.
- **Why:** a cashier who has just switched the till to themselves with their PIN should not type it again for the bill in hand; anything wider (a time window per person, a remembered PIN) would let a colleague bill under their name.
- **Change it:** the 2 minutes are the code's (`businessCounter.service.js`).

### Nothing is posted twice: request keys

- **Rule:** in every business but the restaurant, each posting (a bill, a purchase, a payment, a return, a stock move, an expense, a cash check) is sent with a request key. The same request sent again, after a double tap or a dropped connection, returns what was saved the first time and posts nothing new. The same key with different content is refused. Permissions and a person's location are checked on the server, and the activity log keeps who recorded or reversed each money record.
- **Why:** a retry on a poor connection must never post a bill, a payment or an expense twice.
- **Change it:** nothing to set.

### Late-night trading

- **Rule:** in a restaurant, between midnight and the day cut-off (5 am by default), last night's business day is still the trading day everywhere: write-off control, the dashboard, the day book, reports' default dates, the stock screens, deliveries, advances, the log book and captain sections. Until the cut-off, last night's day can also still be opened. In every other business the day is the calendar date in the business's time zone; its *Day cut-off* setting decides only which day a task due after midnight belongs to.
- **Why:** a restaurant that closes after midnight keeps the night on one business day. Read by the calendar date, its dashboard and day book would jump at midnight to a day with no bills.
- **Change it:** a restaurant's cut-off hour: *Daily work › Business day › Cash rules* (*Last night's day may be opened until*), set by the owner (`restaurant.settings.manage`). A business's task cut-off: *Business settings › Rules › Day cut-off*.

## Personal data

The DPDP Act 2023 and the DPDP Rules 2025, for every business: a shop's customers (every type's members, hirers, lodgers and patients are its customers) and a restaurant's guests. The business is the data fiduciary for the people it serves; the platform holds their data for it. The data fiduciary duties apply from 13 May 2027. The screens are in [ADMIN_GUIDE.md › Personal data](ADMIN_GUIDE.md#personal-data); what is left (the Consent Manager rule, verifiable parental consent, how long tax records are kept, a legal adviser's review) is in [BACKLOG.md §10](BACKLOG.md#10-new-business-types).

### A phone number is never a condition of a sale

- **Rule:** no bill, order, booking, membership, repair, warranty, stay or other intake needs the customer's phone number, at the counter or on the server: a name is enough wherever a customer is named, and a walk-in needs neither. A phone is asked for only where the person asks for something that needs one, and the screen says why there: a delivery, a reminder they agreed to, the ready message for a repair or a pre-order, and the guests' site's order updates (an online order and a table booking take a mobile for that). A phone typed with only spaces counts as none.
- **Why:** the Department of Consumer Affairs said in 2023 that making a mobile number a condition of a sale is an unfair trade practice.
- **Change it:** nothing to set.

### Consent per purpose and per business

- **Rule:** a person agrees, or not, to each of three purposes on its own: *bills on WhatsApp or SMS*, *reminders* (dues, appointments, renewals and service due, on WhatsApp, SMS or a call) and *offers*. Each consent records the purpose, when it was given and when it was withdrawn, where (at the counter, on the guests' site, on the phone), how (said yes, signed a form, ticked it online), the version of the privacy notice it was given on, and who recorded it. A consent belongs to one business: another business of the same owner never sees it. It is given in one tap where the customer is taken (the customer's form, Quick bill, a type's own intake, a restaurant's guest form and till) and withdrawn on the customer's record or from Personal data; a new yes after a withdrawal is a new record. A consent is kept as given: only its withdrawal is recorded, once, with the reason; nothing deletes it. Recording one needs the right to take customers (`contacts.create` or `contacts.edit`, a clinic's `patients.create` or `patients.edit`; a restaurant's `customers.manage`).
- **Why:** the DPDP Rules ask for a separate, clear consent notice for each specific purpose, and consent is given to one data fiduciary, the business.
- **Change it:** nothing to set; the consent notices' words, in the privacy notice (below).

### Every message checks its purpose's consent

- **Rule:** every button that opens a message to a customer checks the consent of its purpose first: a bill or a quotation on WhatsApp (*bills on WhatsApp or SMS*); a dues, renewal, recall, service-due, appointment, package, gold-scheme or site-dues reminder on WhatsApp or SMS, and a reminder call (*reminders*); the guest book's WhatsApp chat, a call from Guest insights' lists (except to an unhappy guest about their complaint) and the mobiles copied for a broadcast (*offers*). Without the consent the button says why it cannot go and asks the person first: the staff read them the notice's own line for that purpose and record their yes in one tap, and the message goes. Someone with no record (a walk-in) is saved as a customer or guest first, as a consent is kept on the person's record. The server refuses to record a reminder on WhatsApp, by SMS or by a call without it (409, *consent_required*); a visit is not a message. A message about what the person asked for (their order or repair is ready, their booking is confirmed, a delivery is on its way) needs no consent.
- **Why:** a consent stands for its purpose only, and a message sent without one is processing without consent.
- **Change it:** nothing to set.

### The privacy notice and its contact

- **Rule:** each business publishes a privacy notice in versions under *Settings › Personal data*: in plain words, item by item, what is collected and why, what is sent only with a yes, how to see, correct or erase it, how to complain, and whom to contact; with a short consent notice for each purpose and a privacy contact (a name, and a phone or an e-mail). It starts from a starter text the owner edits; the starter states no period of keeping. A published version never changes: a change is a new version, and each consent keeps the version it was given on. No consent is recorded before the first version is published (409, *no_privacy_notice*), except what came from earlier records and a clinic patient's consents on the clinic's own notice. Every bill and receipt prints one line with the contact (*Your personal data: …*): a shop's invoices and till receipts, collection, refund and deposit receipts, credit vouchers, quotations and its types' slips and cards, and a restaurant's bills, credit notes and advance receipts. The guests' site shows the notice where it takes a guest's name and number. The bell asks the owner to publish it until it is.
- **Why:** the DPDP Rules ask for an itemised, plain-language notice with a contact for personal-data queries, displayed. How long tax law keeps a bill was not verified, so no period is stated.
- **Change it:** the notice and the contact: *Settings › Personal data › Notice & contact* (`privacy.manage`).

### A child is never sent offers

- **Rule:** a person can be marked as a child, with the parent or guardian who gives consent for them, their relation, how they gave it and how they were seen to be the guardian. Marking a child stops any consent to offers, and no consent to offers is taken for a child, at the counter, on the guests' site or by any other way; what the guardian agrees to (bills, reminders) is recorded as given by them. The mark ends with a reason (they turned 18). A child is left out of every broadcast of offers.
- **Why:** a child's data needs verifiable parental consent, and offers aimed at children are barred. Gyms, coaching, clinics and laundries meet children most. What "verifiable" asks of a shop is open ([BACKLOG.md §10](BACKLOG.md#10-new-business-types)).
- **Change it:** the mark, on the customer's form (*Mark as a child*) or from a request in Personal data.

### A request is answered within 90 days of the day it came

- **Rule:** a person's request to see, correct or erase their data, and a grievance, is logged in *Settings › Personal data › Requests* with the day it was received (today unless told otherwise, never a day still to come) on the business's own clock, and is due 90 days after it. An access request is answered with the file of everything held about them; a correction is made on the normal screens; an erasure is carried out from the request. A request is closed once, answered or refused with the reason, and is then kept as it was. The bell warns from 15 days before the due date and once it has passed.
- **Why:** the DPDP Rules ask that requests and grievances are resolved within 90 days.
- **Change it:** nothing to set.

### The file of a person's data

- **Rule:** seeing or exporting everything held about one person is its own permission (`privacy.export`), given to the owner and the Manager role (a restaurant's owner and manager). The file holds their record and every record of theirs across the business's modules (bills and their lines, money received, reminders, memberships, garment orders, bookings, stays, job cards, prescriptions and the rest; a restaurant's orders, bookings, advances, feedback and bills), their consents, a child's mark and their requests. Each view and each export is written to the activity log.
- **Why:** a person may ask to see the data held about them; seeing all of it at once is more than any one screen shows.
- **Change it:** who holds `privacy.export`, in *Roles & permissions*.

### An erasure keeps the tax records, the consents and the request

- **Rule:** an erasure, done from an erasure request, removes the person's name, phone, e-mail, address, GSTIN and PAN from their record (it becomes *Erased customer #id*, or *Erased guest #id*, and no longer changes), and their copies on the records that hold them, closed ones included: job cards, repair jobs, warranties, garment orders, rental bookings with the ID and licence, stays, spectacle orders, gold schemes, quotations, book and pickup orders, salon notes and the client card, a farmer's details and a site. Bills and other tax records keep what tax law needs (the name, GSTIN, address and PAN they were made out to), and so do money received, returns, the old gold voucher's ID and the lodging guest register; what is kept, and why, is written on the request for the accountant. Points left are cancelled with an entry. Their consents are withdrawn and kept, and so is the request, as the record. The activity log is kept at least a year. A restaurant guest's erasure from the guest book is kept in the register as an erasure request received and done that day.
- **Why:** the DPDP Act erases data no law requires keeping; tax law requires bills (how long was not verified: it is for the accountant), and the Rules keep processing logs at least a year.
- **Change it:** nothing to set.

### An erasure waits for what is still open

- **Rule:** an erasure is refused, with the list, while anything still ties the person to the business: money they owe or money of theirs held (an advance, a credit, a credit voucher, old gold not paid out), and an order, booking, stay, job card, repair, membership, gold scheme, salon package, appointment, quotation or sales order still open; a restaurant guest's dues on account, an advance left or a pre-order to collect. A clinic's registered patient is not erased: medical records are kept for the clinic's years, with the patient's details.
- **Why:** erasing a person while money or goods are still between them and the business would lose track of both.
- **Change it:** settle or close each item, then erase; a request that cannot be done is refused with the reason.

### The breach register and the Board's 72 hours

- **Rule:** a breach is recorded under *Settings › Personal data › Breaches* with when it was found (never in the future), what happened, the impact and the steps taken, and the people affected: chosen by search, or every customer. It shows the time left for the Data Protection Board's detailed report, 72 hours from when it was found; the bell warns until the report is recorded. The notice to the people affected is filled from the record with the privacy contact, can be edited, and each notice sent is recorded (by WhatsApp, SMS, e-mail, letter, a call or in person), with its words; someone a notice went to stays on the breach. A breach closes only once the report to the Board is recorded, and is then kept as it was. Recording, each notice sent and closing are written to the activity log. The register files nothing itself: the business tells the Board and the people.
- **Why:** the DPDP Rules ask that the people affected and the Board are told without delay, in plain language (what happened, the impact, the steps taken, a contact), and that the Board gets a detailed report within 72 hours.
- **Change it:** nothing to set; the register is kept by `privacy.manage`.

### Who keeps the registers

- **Rule:** reading the requests and breaches is `privacy.view`, keeping them and erasing is `privacy.manage`, and seeing or exporting a person's data is `privacy.export`; the three are given to the owner and the Manager role in every business, and in a restaurant to the owner, the manager and any role that already manages users and roles. Any member reads the notice in force, which the counter shows when it asks for a consent.
- **Change it:** *Roles & permissions*.

### The guest book's consent to offers, and the guests' site

- **Rule:** a restaurant guest's consent to offers is a consent like any other: the guest book's earlier yes was brought over as one, and the *Offers* column and WhatsApp chat in the guest book follow it. The mobiles copied from Guest insights for a broadcast are only the guests who agreed to offers and are not marked as a child; the rest are counted as left out. A call from its lists asks for that consent first, except to an unhappy guest about their complaint. On the guests' site an online order can tick *my bill on WhatsApp* and *offers*, on the notice the page shows; they are recorded, given online, when the restaurant accepts the order. The site says the guest's details are kept on their phone for the next order, with a way to forget them.
- **Why:** one record per purpose: a consent kept in two places would drift apart.
- **Change it:** nothing to set.

## An owner's GST thresholds

For every business and the restaurant. What applies to a taxpayer's invoices in a financial year follows its aggregate turnover in the year before: e-invoicing and 6-digit HSN / SAC codes above ₹5 crore, and, from 1 April 2025, at ₹10 crore or more no invoice or credit note reported to the IRP more than 30 days after its date. The researchers read aggregate turnover as counting every GSTIN under one PAN, so several small businesses of one owner can cross ₹5 crore together; a platform holding all of them can see that coming. The screens are in [ADMIN_GUIDE.md › GST thresholds across your businesses](ADMIN_GUIDE.md#gst-thresholds-across-your-businesses); what is left, with the accountant's check of that reading, is in [BACKLOG.md §10](BACKLOG.md#10-new-business-types).

### A business's PAN comes from its GSTIN, and is never guessed

- **Rule:** a business trades under the PAN its GSTIN carries (characters 3 to 12): its own GSTIN and its locations' (a restaurant: its GST number and its outlets'), a branch registered in another state included. A business with no GSTIN counts under the PAN its owner records for it on *GST thresholds*, and only its owner records or clears it; while it has a GSTIN none can be recorded. A business whose GSTINs carry different PANs, or that has neither a GSTIN nor a recorded PAN (a GST number that is not a valid GSTIN is none), is listed as not linked, with the reason, and counts under no PAN. Recording, changing and clearing a PAN are written to the activity log with the PAN masked.
- **Why:** a PAN guessed from a name or a phone would add up businesses that are not one taxpayer's, or leave out one that is.
- **Change it:** the business's GSTIN, in its settings (a restaurant: *Settings › GST and invoice*); a recorded PAN, on *GST thresholds*.

### One owner's businesses add up under one PAN

- **Rule:** a PAN's turnover is the sum of the businesses one owner login owns under it (the Owner role of each, in an active business; a restaurant once it is linked to the platform). Each owner's view adds up their own businesses only: another login that typed a GSTIN of the same PAN on a business of theirs never adds to it, and never sees it. A business's bell takes the more serious of its owners' sums.
- **Why:** a GSTIN is typed, not checked with the GST portal, so adding up every business on the platform under a PAN would show one owner's turnover to anyone who typed their GSTIN.
- **Change it:** nothing to set. An owner who wants businesses counted together owns them with one login.

### Turnover is sales less returns before GST, on each business's own dates

- **Rule:** a business's turnover is its sales less what came back, at their value before GST: a shop's sale bills (every line, nil-rated and exempt ones included) less its sale returns, each on its own posting date in the business's time zone, as Reports count them; a restaurant's bills (not voided) at their value of supply (the dishes after discounts, the service and delivery charges) less its credit notes, each on its business day (else its date on the restaurant's clock), as the GST pack counts them. Purchases, advances, deposits and the money taken are not sales. Only what is billed on the platform counts: a business's sales from before it came onto the platform, and those of a GSTIN under the PAN that is not on the platform, are not in the sums. The financial year runs from 1 April to 31 March: a bill at 23:30 on 31 March is last year's, one at 00:30 on 1 April this year's, and a restaurant's bill on the night of 31 March's business day still open is last year's. *At this pace* is each business's turnover this year so far, from 1 April (or the day it came onto the platform, if later), spread over the whole year to 31 March.
- **Why:** GST is the government's money, not a sale; and each business's day ends on its own clock, not the server's. Whether this is how the law counts turnover is part of the accountant's check.
- **Change it:** nothing to set.

### Exempt and non-taxable supplies count, fuel included

- **Rule:** sales on the GST nil slab count like any other, and so do a fuel station's walk-in and fleet fuel bills, which are outside GST, at the price billed (state VAT included).
- **Why:** the researchers read aggregate turnover as including exempt and non-taxable supplies, a fuel station's petrol and diesel among them. They did not re-verify that reading: an accountant checks it ([BACKLOG.md §10](BACKLOG.md#10-new-business-types)).
- **Change it:** a code change, once the accountant has said otherwise.

### The figures are the platform's, with their sources

- **Rule:** each figure (₹5 crore, ₹10 crore, the 30 days, the 6 digits) is a row of the platform's reference data, with what applies at it, how it is measured (above it, or at it and above), the date it applies from and its source, and every screen and bell reads it from there: none is written in the code. A figure applies from its date; a later one for the same rule takes over on its own date. *GST thresholds* lists them with their sources.
- **Why:** the figures change with notifications, and each needs its source for the accountant who checks it.
- **Change it:** the platform changes a figure, or adds one from a later date, by a migration (`platform_gst_thresholds`), after an accountant's check. No screen changes them.

### The warnings, at the owner's own level

- **Rule:** a figure applies for a financial year when the year before passed it (above ₹5 crore; ₹10 crore or more). So for each figure a PAN is *nearing* it once this year's turnover so far reaches the owner's warning level (80% of it until the owner changes it, a whole percent from 50 to 99); what applies there *applies from* the next 1 April once this year's turnover so far has passed it, and *applies now*, for this year, once the whole of last year's had. The owner sees each figure's standing on *GST thresholds*, with the year at this pace; the bell of each business under the PAN shows a warning for each figure nearing, and a critical line for each one passed (*Applies now*, or *Applies from* the next 1 April), a restaurant's on its own bell. A bell's standing may be up to five minutes old: a PAN recorded or cleared, or a warning level saved, shows at once.
- **Why:** the research reads the notifications so: e-invoicing applies from 1 April 2026 to a taxpayer whose turnover passed ₹5 crore in 2025-26, and the 6-digit codes and the IRP's 30 days are measured on the year's turnover too. The warning comes before a figure is passed, and passing it this year is the moment to prepare for 1 April. The researcher's own unverified understanding that any year since 2017-18 counts, not only the last, is not built: it is part of the accountant's check. The bells' standing is kept because each sums two years of every business under the PAN, and the bells ask every minute.
- **Change it:** the warning level, under *GST thresholds › When to warn*, by the owner.

### Who sees the warning, the sums and the PAN

- **Rule:** a business's bell shows the warning to whoever may see its money (reports: the Owner, Manager, Accountant and Viewer roles, and a restaurant's roles with reports). The sums are shown only to someone who may see the money of every business they add up; anyone else is told where the PAN stands, without them. The PAN shows in full to the business's owners only, and to everyone else as its last four characters (••••••234K); a restaurant's bell, which everyone there shares, always masks it. *GST thresholds* is the owner's alone: anyone else is told so.
- **Why:** a manager of one business may not see another business's turnover; and where the owner is a person, the PAN is their personal data.
- **Change it:** who holds reports, in *Roles & permissions*.

### Once 6-digit codes apply, the catalogue lists the codes to fix

- **Rule:** once 6-digit HSN / SAC codes apply to a business's PAN, now or from the next 1 April, its catalogue lists its items whose code is shorter, or missing (active items billed under their own code: not a kit, whose parts are billed, nor an item kept for use in services), to fix one by one, and says which: *now*, or *from 1 April*; a restaurant's *Tax rates* names its rates with a shorter code and a dish on them, since a dish prints its rate's code. Whoever may see the catalogue sees the list, never the turnover. *GST thresholds* counts them business by business.
- **Why:** above ₹5 crore the HSN on invoices runs to 6 digits, and a bill copies its item's code; listed before 1 April, the codes are fixed before the first invoice that needs them.
- **Change it:** each item's *HSN / SAC* code in its edit form; a restaurant's on its tax rate.

### Nothing files or makes an e-invoice

- **Rule:** the warnings say when e-invoicing and the IRP's 30 days apply; the platform makes no e-invoice, reports nothing to an IRP and files no return. E-invoices are made outside the platform.
- **Why:** e-invoicing goes through an IRP, an outside integration ([BACKLOG.md §1](BACKLOG.md#1-outside-integrations)).
- **Change it:** nothing to set.

## Shops and the shared core

These rules apply to every business type but the restaurant. The goods rules apply to the shops that sell goods: grocery and kirana, supermarket, books & stationery, pharmacy, fashion, electronics, meat and other weight-based shops, general stores, hardware and building materials, seeds and fertilisers, optical shops, garages and auto parts, jewellers and fuel stations.

### Branch and member prices

- **Rule:** a branch can sell an item at its own price; a branch without one sells at the item's price. With *Loyalty points* on, a customer named on the bill pays the item's member price when that is lower. Offers still apply.
- **Change it:** the item's *Member price*, and *Branch prices* on its row.

### MRP, GST and the shelf price

- **Rule:** a new goods shop starts with prices that include GST and with totals rounded to the rupee. Each item can carry an MRP (GST included) and an HSN or SAC code. An item is never priced above its MRP, never given a new shelf price above it on a receipt, and never billed above it. When prices are before GST, the GST is added before comparing. The HSN code and the MRP are copied onto each bill line, and a posted bill keeps the tax mode it was made with.
- **Why:** in a goods shop, what the shelf says is what the customer pays.
- **Change it:** *Business settings › Prices, totals and numbering* (*Selling prices*, *Round sale totals*); each item's *MRP* and *HSN / SAC* code in its edit form.

### GST rates by date

- **Rule:** a GST rate change moves items to another of the business's GST slabs from a date, entered ahead under *Products & services › GST rate changes* by someone who may edit the catalogue (`catalog.edit`): from tomorrow, within two years, with a reason, for the items picked by their slab, category, HSN / SAC code or a search. It is scheduled once (the same request sent again is the same change) and can be cancelled before its date, whole or item by item, with a reason. On its date, on the business's own clock, it takes effect with nothing running: the first request or bill of that day moves the items, and from then on every sale, preview, quotation, type's own bill and price shown uses the new slab. A bill posted before keeps the rates its lines were posted at. A price that includes GST keeps its total, and the GST inside it is worked out again, unless the change keeps the price before GST: then the item's price, member price and branch prices move with the rate (customer and slab prices on price lists stay). A price before GST never moves. An order priced before the date (a garment order, a spectacle order, a job card, a hire, a sales order) is billed at the rate of its bill's day the same way: a price that includes GST keeps its total, one before GST its taxable value; a quotation must be revised before it is billed. Around midnight, a bill whose figures were worked out before a change took effect is refused with *GST rates changed a moment ago* and is sent again. Once its date has come a change is kept for good, with who entered it and why, in the item's GST history and the activity log. Refused when entered: an item a type keeps on its rate (a fuel on the nil slab, a jewellery item at 3%, a room type, whose nights take the slab their value decides), a kit (it takes the highest rate of its parts by itself), an item already moving that day, one already at that slab then, and one that would sell above its MRP. An item the database still refuses on the day (made a fuel since) stays where it was, and the change says why.
- **Why:** from the 57th GST Council (8 October 2026) GST rates change once a year, announced ahead and in force from 1 April. A bill must use the rate in force on its own date, and nobody should have to change every item at midnight. The time of supply when an advance or a supply runs across a change (CGST Act, section 14) is not worked out: a bill uses the rate of its own date ([BACKLOG.md](BACKLOG.md#10-new-business-types)).
- **Change it:** the changes, under *Products & services › GST rate changes*; an item's slab from today, on the item itself. A slab items are to move to stays on until their date.

### GST rates kept in settings, by date

- **Rule:** three GST rates are kept in settings, not on an item: a fashion shop's *GST by price* (the price per piece and its two rates), a lodge's two room-night slabs and the limit between them, and a restaurant's default GST rate (its advances' GST is worked out at it). Each changes by date as an item does: entered ahead in its own card on *GST rate changes* by whoever may change the business's settings (`settings.edit`; a restaurant's `restaurant.settings.manage`), from tomorrow, within two years, with a reason, at most once a day for each rate; sent twice, it is still one change; cancelled before its date with a reason. On its date, on the business's own clock (a restaurant's trading day), it takes effect with nothing running, in the same step that moves the items, and from then on it is kept for good with what the rate was before. It is refused while the rate is not set up yet (*GST by price* never saved, the two room-night slabs not chosen), when it sets what will be in force the day before anyway, and, for room nights, when its lower slab's rate is not below its higher's. A slab room nights are to move to stays on until then. A rate can still be changed by hand from today, where it is kept. A restaurant's advances are split for the GST return at the default rate of the day each was received, so a period across a change shows both rates. A jewellery item's 3% and a fuel's nil slab are rules of GST law kept by the software, not settings: no change moves them, and the screen says so.
- **Why:** the yearly change can move these rates too (the apparel threshold and the room-night slabs moved with the rates on 22 September 2025), and they must move on the same day as the items, on the business's own date, not by someone at midnight.
- **Change it:** the rate's card on *Products & services › GST rate changes* (a restaurant's on *Menu › GST rate changes*); from today, where each is kept. A new rule for jewellery or fuel is a code change.

### A notification's list of HSN codes

- **Rule:** a change can be made from a GST notification's list: HSN / SAC codes each with its new rate, pasted or read from a CSV file, up to 5,000 lines. A code of 4 or 6 digits stands for every item whose code starts with it, one of 8 digits for itself; a restaurant's dish is found by its tax rate's code. Each rate must be one of the business's slabs (a restaurant's tax rates). The preview shows what each line finds, the codes that find nothing, the items that stay where they are and why (at that rate already then, moving that day, a fuel, a jewellery item, above its MRP), and the items two lines give different rates. The list is refused until those are put right, and while a line whose rate has no slab finds items. Scheduled, it becomes one change for each new rate, or several of up to 2,000 items each when a rate moves more, all at once and named by the list; each is then a change like any other, and is cancelled the same way. Sent twice, it is still one list.
- **Why:** a notification lists hundreds of codes; picking the items by hand for each is slow and easy to get wrong, and an item given two rates must be decided by a person, not by the order of the lines.
- **Change it:** the list itself.

### A reminder before a GST rate change

- **Rule:** the bell of those who manage GST rates (`catalog.edit`; a restaurant's `menu.manage`) shows a change still to come from 7 days before its date, saying what moves (how many items, to which slab, from which slabs) and why, and again on the day before, as new. A change of a rate kept in settings is shown the same way.
- **Why:** prices, shelf labels and open quotations are checked before the day, not after.
- **Change it:** nothing to set.

### Open quotations and sales orders before a GST rate change

- **Rule:** a change's preview, and the change while it is still to come, lists the open quotations and sales orders holding an item it moves (a kit's part too; a quotation's line not yet billed, an order's line not yet sent). Each of them shows a notice until the date: "From <date> these items move from x% to y%. A quotation billed after the date asks to be revised first; a sales order is invoiced at the rate of its invoice's day." Nothing on the documents themselves changes.
- **Why:** the customer was told a price; the shop should know before the date which promises the change touches.
- **Change it:** nothing to set.

### The counter discount and walk-in customers

- **Rule:** at Quick bill, someone whose role holds `sales.discount` (the Manager role by default) can take a small discount off the bill, in ₹ or %, with a reason. It comes after offers and before points. It is capped at *Most discount at the counter* (10 % of the bill by default); the owner is not limited. A walk-in pays the whole bill, on the screen and on the server: udhaar needs a named customer, unless *Walk-in customers* is set to *May leave a bill unpaid*.
- **Why:** udhaar is money a named customer owes.
- **Change it:** *Business settings › Prices, totals and numbering* (*Most discount at the counter*, *Walk-in customers*); who holds `sales.discount` in *Roles & permissions*.

### Cash of ₹2,00,000 or more

- **Rule:** no bill takes ₹2,00,000 or more in cash, counting every cash payment on it whenever it is paid, and no customer pays ₹2,00,000 or more in cash in one business day, counting the cash on their bills and their collection receipts. The payment or receipt that would reach the limit is refused, with what to do: take the rest by UPI, card, bank transfer or cheque. Every screen that takes money goes through this rule, and so does anything that writes a payment to the database. A fuel station's walk-in fuel bill sums the fills of a shift's many walk-in buyers, each paying for their own: it is the one bill the limit does not count ([Fuel stations](#fuel-stations)). A restaurant keeps the same limit on its own bills and advances ([The cash limit at a restaurant](#the-cash-limit-at-a-restaurant)).
- **Why:** the Income-tax Act 2025 (section 186; section 269ST of the 1961 Act until April 2026) forbids receiving that much in cash from one person in a day or for one transaction, and the penalty equals the cash received.
- **Change it:** only when the law changes: the limit is in the database triggers `business_payments_cash_limit` and `business_collections_cash_limit`, and a restaurant's in `trg_payments_cash_limit` and `trg_customer_advances_cash_limit`.

### PAN on a bill over ₹2,00,000

- **Rule:** a sale over ₹2,00,000 records the buyer's PAN: typed on the bill, saved with the customer (*Customers › the customer › PAN*), or read from the customer's GSTIN or wholesale details. A buyer who has no PAN signs a declaration (Form 97); the bill then records that it was taken. Without either the bill is refused. The PAN, or the declaration, prints under the buyer on the invoice. A restaurant's bill over ₹2,00,000 records it too, before it takes a payment ([The buyer's PAN at a restaurant](#the-buyers-pan-at-a-restaurant)).
- **Why:** the income-tax rules make the buyer quote their PAN on a purchase over ₹2,00,000, and the shop must keep it.
- **Change it:** a code change (`PAN_ABOVE_PAISE` in `business.service.js`, and for a restaurant the database trigger `trg_payments_buyer_pan`) when the rules change.

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

- **Rule:** a top-level category belongs to one department. A person tied to a department sees and changes only its products and stock, and still bills every item. In *Staff & access* they see only that department's people: the list, its count and its search are filtered by the server, and the staff pickers that read the list (a bill list's staff filter, a clinic's signatories) with them.
- **Why:** a counter sells across departments; the owner's rule is that a department manager sees only their own department's people.
- **Change it:** each category's department in *Products & services › Categories*; the person's department in *Staff & access*.

### Who a manager can change in Staff & access

- **Rule:** *Give access* changes someone, and *Password* sets them a new password, only when the person doing it manages them. A manager tied to a location manages the people tied to that same location, and one tied to a department the people of that department; neither manages someone who works at every location or in every department. Nobody manages the owner, themselves, or someone whose role can do anything theirs cannot. The owner manages everyone else. *Password* is for a login used in this business alone: one also used in another business or a restaurant is refused (409), and the list does not offer it.
- **Why:** a manager must not demote or lock out someone above them or outside their part of the business; and whoever sets a password can sign in as that person and do whatever they may do, in every business their login opens.
- **Change it:** nothing to set. It follows each person's *Works at*, department and role in *Staff & access*, and the roles in *Roles & permissions*.

### Who owns a business

- **Rule:** a business is part of its owner's subscription with the platform (a basic plan, plus the modules and applications chosen). The platform's super admin creates it with its owner's login and switches its modules and applications on; the owner then gives their staff access in *Staff & access*. The Owner role is given only then, and is never handed out or changed from the admin application: only the super admin changes who owns a business.
- **Why:** the owner is the platform's customer for that business; handing it over is a change to the subscription, not a staff matter.
- **Change it:** the super admin, from the platform; not built yet ([BACKLOG.md › The platform layer](BACKLOG.md#3-the-platform-layer)).

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

- **Rule:** a quotation is priced by the server exactly as a sale of the same lines would be at that moment: customer and slab prices, the branch's price, running offers, a manager's discount within the counter limit, GST and round-off. Never above an item's MRP. A kit is one line, priced as on a bill: its price, split over its parts by their list prices, each part at its own GST and HSN; the quotation keeps each part's share. A revision prices every line again at that day's prices.
- **Why:** what the customer is told must be what the bill says.
- **Change it:** nothing to set; the prices themselves are set on the items and price lists.

### A quotation holds its prices until its date

- **Rule:** an open quotation may be billed, or made into a sales order, only up to its *Valid until* date, on the business's own calendar (at most 180 days ahead). After it, it shows as *Expired* and must be revised first. Bills are posted at the quoted prices: every line that is left at once, or the lines and quantities chosen now, up to what is left of each (a line quoted in packs in its packs, a kit in whole kits); the rest stays open. Each bill takes each line's cumulative share of its quoted taxable value and GST, so a line billed in parts, or taken from two batches, still adds up to the quotation to the paisa; a bill of the whole quotation must equal its total. A kit goes on the bill as its parts, at their quoted shares, from their own stock and at their own GST, exactly as if added there directly (*Part of* the kit). It is refused, with the reason, while an item's (or a kit part's) GST rate or pack size differs from the quotation, while a kit's parts changed, while the quoted rate (GST included) is above the MRP now, or when the business rounds totals differently now. Two people billing the same quotation at once are counted one after the other: no line is ever billed beyond what it holds (the database refuses it too).
- **Why:** cement and steel prices move every week; a shop holds a price only for as long as it promised to, and never bills against the law (MRP) or at a GST rate that is no longer the item's.
- **Change it:** the date on each quotation (when making or revising it).

### A quotation that is billed or cancelled

- **Rule:** a billed, ordered or cancelled quotation never changes: its lines, totals, customer and site stay as they were (the database refuses any change). A quotation part billed stays open for what is left, shows what each line has billed and has left, and is *Billed* once nothing is left; it is not revised (cancel what is left and quote it again). What is left can be billed, made into a sales order (a kit as its parts, at what is left of their shares) or cancelled; an open quotation is cancelled with a reason, and what was billed stays billed. Nothing is deleted. Undoing a sale is a return on its bill. A customer who is not saved pays a goods shop's bill in full when it is made; only a saved customer's quotation becomes a sales order, and only for goods. A sales order from a quotation for a customer on credit hold is let through as on *Sales orders*: by someone with credit control, or with a manager's PIN and a reason, kept with the order and in the activity log.
- **Why:** the quotation is the record of what was offered and accepted.
- **Change it:** nothing to set.

### A quotation's terms and conditions

- **Rule:** the business's terms and conditions for quotations are kept in *Business settings › Prices, totals and numbering* (*Terms and conditions on quotations*, up to 2,000 characters). A quotation takes them when it is made, prints them under its totals and on WhatsApp, and keeps them for good: a revision keeps them, and the database refuses a change. Changing the setting changes only the quotations made after.
- **Why:** the terms the customer accepted are the ones printed on what they were given.
- **Change it:** the setting.

### A licence belongs to one location

- **Rule:** with *Licences & registrations* on, each licence is kept for the one location that holds it, with its kind, number, issuing authority and the dates it is valid (no end date: it does not run out). It keeps its location and kind for good, and one number is kept once for a kind of licence in the business. A licence is renewed by changing its *Valid until*, and switched off once surrendered or cancelled; it is never deleted (the database refuses both). The activity log keeps each change with the values before and after. A licence is *in force* on a day when it is on, that day is on or after *Valid from*, and on or before *Valid until*, or past *Valid until* while a renewal applied for keeps it in force ([A renewal applied for](#a-renewal-applied-for)). A licence that covers fertilisers, seeds or insecticides is for retail sales, wholesale sales or both: a new one takes its kind's usual mark (a fertiliser authorisation retail, a seed or an insecticide licence both), and the shop changes it to what the licence says.
- **Why:** the licences a shop must show are issued for each place of business, and an inspector asks for the one held on a given day.
- **Change it:** the licence itself, under *Settings › Licences*; who may change licences is the role's `licences.edit`. The kinds of licence and their usual marks are platform data (`platform_licence_kinds`), changed by a migration.

### A renewal applied for

- **Rule:** a licence with an end date may be marked *renewal applied for*, with the date it was applied for (not ahead of the business's today) and the application's reference. What the mark does once the licence is past its date is its kind's rule, kept as platform data: an insecticide sale licence stays in force while the renewal is pending, from the day it was applied for (Insecticides Rules 1971, rule 11); a fertiliser authorisation stays in force only when the renewal was applied for within one month of its date (Fertiliser (Control) Order 1985, clause 11), and lapses otherwise; every other kind lapses on its date, a seed licence too (the Seeds (Control) Order 1983 allows a late renewal within a month, but the sources read say nothing of the licence staying in force meanwhile). A licence in force only through its renewal bills with a warning at the counter, and the bell warns about it until the renewed date is typed; typing a later *Valid until* ends the mark. A licence past its date that the mark does not keep in force refuses the bill as before, saying why.
- **Why:** a licence whose renewal is pending must not stop a lawful sale, nor keep an unlawful one going; the rules differ by licence and are kept where they can change without code.
- **Change it:** the mark on the licence, under *Settings › Licences*; the rule of a kind is platform data, changed by a migration.

### A licence's scanned copies

- **Rule:** a licence keeps its scanned copies (a PDF or a photo, up to 5 MB, as the platform's other private files), each kept with the dates the licence had when it was added, so a renewal's copy is added beside the earlier ones. The bytes are checked: a renamed file is refused. A copy is opened only through the API, by someone who may see licences, at the licence's own location; only someone who may change licences adds one; a copy is never changed or deleted.
- **Why:** an inspector asks to see the licence held on a day, and the shop must display the current one.
- **Change it:** nothing to set.

### A licence names its qualified person, as written

- **Rule:** a licence may name the qualified person it was granted on: their name, with their qualification and its certificate's number, or the reason they are exempt. A name needs one or the other. Nothing checks which qualification is valid.
- **Why:** the rules on who qualifies to deal in fertilisers and insecticides change often and the sources disagree (a six-month or a 15-day course; exemptions for older dealers), so they are kept as data, not as code.
- **Change it:** the licence itself.

### The bell before a licence runs out

- **Rule:** the bell warns about an active licence 60 days before its *Valid until*, and again, as critical, once that date has passed; a licence past its date that stays in force while its renewal is pending warns (not critical), with the renewal's date and reference, until the renewed date is typed. A licence switched off is not warned about.
- **Why:** a renewal takes weeks; a shop selling under a lapsed licence sells without one.
- **Change it:** the 60 days is a code change (`WARN_DAYS` in `businessLicences.service.js`).

### Products, customers and suppliers from a spreadsheet

- **Rule:** a file is an Excel workbook (`.xlsx`: its first sheet with rows, or the sheet chosen) or a CSV file, read in the browser into the same rows either way: a number as written, a date as its day, a formula as the value Excel worked out. An Excel 97-2003 workbook (`.xls`) is not read. It is checked before anything is saved: each row is new, finds a record already here, or is refused with its reason in words. A problem with the whole file (no column to find items by) stops it; a problem in a row refuses that row only, and the rest may go in. What goes in, goes in as one transaction, exactly as checked (a record changed in between sends the file back to be checked), and through the same service functions and permissions as by hand: adding products needs `catalog.create`, customers and suppliers `contacts.create`. The same import sent again (its request key with the same rows) is done once. Up to 5,000 rows and 5 MB a file.
- **Why:** a shop moving from another system brings thousands of records at once; one bad row should not stop the rest, and nothing should go in that the person has not seen. Most shops keep their lists in Excel, so saving as CSV first is a step they need not take.
- **Change it:** the row limit is a code change (`MAX_ROWS` in `businessImports.service.js`), with the 5 MB a request may carry (`app.js`) and a file may be (`MAX_FILE_BYTES` in the staff app's `services/spreadsheet.js`).

### How an import finds a record already here

- **Rule:** an item is found by its code, then its barcode; a customer or a supplier by GSTIN, then phone (a mobile however it is written; a phone several share finds the one of the row's name), and a row with neither by its name. A record found is left as it is, unless the person chose to update matching records and may change them (`catalog.edit`, `contacts.edit`): then only what the file gives changes, and an empty cell keeps what is there. An item's kind, unit and stock tracking never change from a file. The same record on two rows of one file refuses the second. A phone is never needed.
- **Why:** the same file imported twice must change nothing, and a record must never be made twice: the codes, barcodes, GSTINs and phones are what the shop's old system and the platform share.
- **Change it:** nothing to set; in the file, an empty cell keeps what is there.

### Opening stock and opening balances from a file

- **Rule:** opening stock goes in through the item's own opening-stock path (a lot at the purchase price, *Opening stock* in the stock movements, needing `inventory.edit`), and only for a new item or one with no stock on record: an item with stock keeps it. A serial-numbered item's stock comes in through a purchase. An opening balance is the contact's own, as on its form, dated as the file says (today when empty, never later), and is set only on a contact that has none; Tally's Dr and Cr are read the right way round for a customer and for a supplier. Units and GST slabs are only the business's own (a new item without a rate takes the default slab); a GSTIN is checked as on the contact form, a State must be the GSTIN's and a PAN the one inside it; without a GSTIN the state ends the address.
- **Why:** stock already on record is corrected by a count, which keeps the difference with its reason; a balance changed by a file could double what is owed. A slab or a unit the business does not keep would bill or count wrongly, and a GSTIN with a typing mistake costs the customer their input credit.
- **Change it:** a stock count corrects stock; a contact's form changes its opening balance; a new slab or unit is added in *Settings › Tax rates* or *Settings › Units & pack sizes* before the import.

### What a type keeps its own details for is not imported

- **Rule:** a fuel, a jewellery piece with its purity, a rental item (or a hire counted in days), a laundry's priced services, a room type (or room nights) and a membership plan are made on their own screens: a row of one is refused with that screen's name, and such an item already here is not changed from a file. A pharmacy's goods come in kept by batch and expiry, and their drug details are added in the Drug master after; a farm-input shop's items say what kind of input they are on their item form.
- **Why:** those items carry details and prices a file cannot (a fuel's price at each outlet, a piece's weight and purity, a plan's terms), and a plain catalogue item in their place would be sold around the type's own checks.
- **Change it:** a code change (`OWN` in `businessImportProducts.js`).

### A style and its variants from a file

- **Rule:** with *Variants* on, a *Style* column makes the rows of one style (its name however it is written) one product with its variants, as the item form's *Variant of* makes them: each row an item of its own with its own code, barcode, price, size, colour, fabric and opening stock; a row with no name is named for its style, colour and size ("Oxford shirt · Blue / M"). A style's rows share one kind, unit, stock tracking, GST rate, HSN / SAC code and category: a row that leaves one empty takes it from the style's other rows, and a style whose rows give two of one is refused, every row of it, with the rows named. A product of the style's name already here is the style: its new rows take its items' unit, stock tracking, GST rate and HSN where they leave them empty, keep its kind, unit and stock tracking, and are in its category; a variant it already has (the same size, colour and fabric) is refused. An item already here never changes its style, size, colour or fabric from a file. Without *Variants* the columns are not read.
- **Why:** a garment or footwear shop's list is a style per row group, and each size and colour is a separate item to stock, scan and bill; variants of one style that disagree on their GST or unit would bill and count wrongly.
- **Change it:** *Variants* in *Settings › Business tools*; the rules themselves are a code change (`planStyles` in `businessImportProducts.js`).

### Pack sizes from a file

- **Rule:** a *Pack unit* with its *Units in pack* (how many of the item's own unit a pack holds) is made as *Settings › Units & pack sizes* makes it, on a new item or one already here: the pack is one of the business's units other than the item's own, holds a whole number of a whole-unit item, and is not for a service. An item that has the pack with the same quantity is left as it is; another quantity changes it where the person chose to update matching records. Pack sizes from a file need `catalog.edit`, as on that screen. A pack is billed at the price of what it holds: it keeps no barcode or price of its own.
- **Why:** a wholesaler or a grocery buys and sells by the case and the box; the pack's quantity is what converts an order in cases to stock in pieces.
- **Change it:** *Settings › Units & pack sizes* for a pack after the import; who may add them is the role's `catalog.edit`.

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

- **Rule:** a scheme gives free goods of the same item ("buy 10 cases, get 1 free") or of another item ("buy 5 cases of A, get 1 case of B"), a discount %, or both. The free goods go on the order and on the tax invoice as their own line at ₹0, named after the scheme ("Free · scheme name"), and leave stock at dispatch like any line, oldest expiry first. The scheme applies after the price is chosen (customer price, price group, case slab, list price), so by default it stacks on a slab price. A scheme marked *Don't combine with slab prices* prices the line without quantity slabs when it applies: a slab for all customers gives way to the list price, and only a price group's base price (from 1 unit or 1 pack) is used. A customer's own negotiated price still applies. The biggest scheme the line reaches wins, and a line takes one scheme. A return of scheme goods settles the free goods that came with them ([Free goods on a return](#free-goods-on-a-return)).
- **Why:** FMCG companies run "10 + 1" and cross-brand schemes on top of the distributor's trade slabs, but some schemes are funded only at the base rate. The distributor must be able to say which.
- **Change it:** *Price groups & schemes › Schemes › Add a scheme* (the free item, its pack, and the *Don't combine with slab prices* tick). *Wholesale reports › Schemes by retailer* shows, per retailer, the orders that earned a scheme, what was bought and sent, the free goods sent with their value at list price, and the discount given.

### Free goods on a return

- **Rule:** when paid goods that came with free goods (a scheme's, or given by hand) come back on an invoice, the free goods that belong to them are worked out in proportion: free × paid returned ÷ paid bought, over every return of the invoice so far, in the free goods' unit to the thousandth (as quantities are kept). The return may take them back: they are the invoice's free lines, coming back into stock like the paid ones, at no value, in the unit's own steps (whole for a count unit), so a part of a unit that belongs is kept. What belongs and is not back is kept, and charged: at one unit's value before GST (what one unit of the paid line cost after its discounts, for free goods of the same item; the free item's price on the order, before GST, for another item), with GST at the paid line's rate, off the credit note, as a line of its own ("Free goods kept: 24 × ₹9.80"). Free goods kept and brought back on a later return give that back, once. Never more is kept than belongs to the paid goods returned and did not come back, and nothing is given back that was not kept: the database checks both. A return whose free goods kept would come to more than it gives back is refused until some of them come back with it. Reports and the owner's turnover count a credit note less the free goods kept on it.
- **Why:** the owner's rule: the free goods were given for buying the paid goods, so a customer who returns the paid goods and keeps the free ones pays for what they keep.
- **Change it:** a code change (`businessWholesaleFreeGoods.service.js`, `freeGoodsMaths.js`, and the check `wholesale_free_goods_kept_check`).

### Bounced cheques

- **Rule:** marking a cheque bounced (credit control, `receivables.approve`) reverses exactly the bill settlements that receipt made: the invoices it settled open again with those amounts, and the receipt stops counting. The bank charge is added to the retailer's account as a debit, an open item from the day the cheque bounced, shown on the statement as "Bank charge for cheque …". The charge comes from the business setting (₹500 by default), filled in and editable on each bounce (0 for none). The second bounce within 90 days puts the retailer on credit hold: new orders and order increases are refused, unless a manager lets one through with a reason (and their PIN when someone else is taking the order), exactly as with the overdue hold. Customers marked *never hold* are exempt. The hold lifts by itself once the older bounce falls outside the window. Each bounce is written to the activity log.
- **Why:** Indian banks charge ₹300–₹750 for a returned cheque, and distributors pass it on. Two returns in a quarter is the usual trigger for cash-only or a hold (and a Section 138 notice). A rolling window releases a customer who pays on time again, without anyone having to remember to.
- **Change it:** *Outstanding › More › Credit hold rules*: the bank charge, how many bounces (empty: never hold for bounces) and the window in days (7–365).

## Electronics

### EMI sales

- **Rule:** at Quick bill, *EMI* takes the financier, the loan or agreement number, an optional DO number and number of months, and the down payment (cash, UPI or card, which may be split). A new electronics shop starts with Bajaj Finserv, HDFC Bank, ICICI Bank and Home Credit; the owner adds others. The rest of the bill is the financed amount. It is a payment of method `finance` on the bill, so the customer owes nothing for it, and an EMI case owed by the financier. The customer must be named (a saved customer, or a buyer's name; a phone is optional). A loan number is used once per financier. A payout is recorded on *EMI & financiers*: tick the cases it covers and the subvention the financier kept on each (by default its *dealer subvention %*). The amount received must equal the financed amount less the subvention, to the paisa. It counts as money in (bank, UPI or cheque) on the day it is recorded. If the financier cancels after the goods come back, the case is cancelled and the financed part reversed on the bill; the customer gets back only what they paid themselves.
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

### An order for pickup's advance is held for its bill

- **Rule:** an order for pickup takes one advance, when it is taken or later while it is open, from someone who may take payments (*sales.edit*): a numbered collection receipt in the order's saved customer's name (a walk-in's order takes none), by cash, UPI, card or bank, up to what the order comes to at today's rates (each weight at its item's shelf price, each "₹ worth" as it is). The order keeps it for good. While the order is open, the receivables' *Apply advance* leaves it alone. The bill that closes the order is made at Quick bill with the order on it, in the customer's name: the advance pays it first (after a credit voucher), as a payment from the receipt, and the rest is taken as usual; the bill and the order's closing are one posting. Once the order is closed, what is left of the advance (a cancelled order's, or a bill smaller than it) is the customer's money: it can go on their other bills, or go back by cash, UPI or bank with a reason and a manager's PIN (*sales.refund*), as a numbered refund of the receipt. An order with an advance is not closed by marking another bill.
- **Why:** a phone order paid partly in advance must have its advance on record and taken off its own bill, never applied by itself to another bill or lost in a note.
- **Change it:** nothing to set.

### Offcuts and what they recover

- **Rule:** a cut is an offcut when its price for a kilo, before GST, is below what its whole item cost a kilo, as both stood when it was cut (bones, skin, fish heads; a cut priced ₹0 is one). The batch marks each cut when it is saved. What offcuts recovered is worked out from the bills, never typed in: each sale line of an item whose latest cut at the bill's location, before the bill, was an offcut, at its value before GST less what was returned of it; by the day billed (the business's clock) and by item, with what was cut as offcuts in the dates.
- **Why:** offcuts sold cheap bring back some of what the whole item cost; the figure shows how much, next to the cutting loss.
- **Change it:** nothing to set: a cut is priced as the shop prices it on the rate board, and its price when cut decides.

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

- **Rule:** registering a patient needs consent for "treatment and medical records", recorded with the version of the notice shown, how it was given (signed form, verbal, digital) and by whom. Reports on WhatsApp or e-mail, and reminders, are separate and optional consents. A withdrawal is recorded once, with the reason. Withdrawing treatment consent stops new visits and lab orders, while the record is kept for the retention period. A changed notice becomes a new version. These are the business's consents of [Personal data](#personal-data), given on the clinic's own consent notice: bills on WhatsApp and offers are given on the business's privacy notice.
- **Why:** the DPDP Act asks for consent for a stated purpose after a clear notice, and for withdrawal as easy as giving it. Medical records must still be kept.
- **Change it:** *Clinic & lab settings › Consent notice* and *Clinical records kept for (years)* (3).

#### Who sees clinical data

- **Rule:** two permissions guard clinical data: `patients.view_clinical` (vitals, complaints, diagnoses, prescriptions, referrals, lab results, the clinical card) and `patients.edit_clinical` (writing them). Only the Doctor role and the Owner have them. The front desk (Cashier) sees the patient's details, consent, appointments, visits, bills and "report ready", and where each sample is; never how many results are out of range or why a signed report was reopened. Lab technicians and pathologists see results through `lab.edit` and `lab.approve`. Every read of clinical data is written to the activity log (`patient.clinical_viewed`, with what was seen). The Manager role gets no clinical access.
- **Why:** the DPDP Act's "reasonable security safeguards": access only for those who need it, with a log of access.
- **Change it:** *Roles & permissions* (the columns *See clinical* and *Write clinical*).

#### Consultation records

- **Rule:** once a consultation is completed, the database keeps it as it is; a correction is a dated note added below it. The prescription is written by generic name and printed (A5) with the doctor's registration number and council; an ICD-10 code is optional. A referral names whom the patient is referred to (a reason needs someone to refer to) and prints as a referral letter (A5) with the patient's findings, medicines and approved results, signed like the prescription. A visit opened from an appointment completes that appointment.
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

#### The clinic and lab workspaces

- **Rule:** the clinic workspace (`/clinic`) opens for a role that sees patients (`patients.view`) at a clinic with the business tool *Patient records* on; the lab workspace (`/lab`), for a role that sees lab orders (`lab.view`) with *Laboratory* on. Business Admin's menu shows each only to those it opens for. In them each person does what their role allows in Business Admin: the front desk registers, gives tokens and follows samples without clinical data; a doctor with a calendar of their own sees their queue first and consults beside it.
- **Why:** one screen for each person's day, with the same safeguards as Business Admin.
- **Change it:** *Roles & permissions* (*See* on *Patient records* and on *Laboratory*); *Settings › Business tools*.

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

#### Lab departments

- **Rule:** every clinic starts with eight departments: Haematology, Biochemistry, Microbiology, Serology / immunology, Clinical pathology, Histopathology, Imaging and Other. The lab adds its own, renames any, and switches one off once no test in use is in it. Other stays on. Each test and profile is in one department: a new test starts in Other unless another is chosen, as did every test kept before departments. The lab workspace's worklist is gathered by department, with how many tests wait in each. Someone tied to a department (a lab technician) finds their own departments first: this decides nothing about what they may do.
- **Why:** a lab works bench by bench; a technician finds their bench's work without searching the whole list.
- **Change it:** *Lab orders › Tests & panels* (a test's department, and the *Departments* card: add, rename, switch off, who works in each), by roles with `lab.edit`.

#### Billing the tests ordered

- **Rule:** an ordered test is billed once, as its service at its price, through the core's sale: as it is ordered (by someone who bills), later from its order (*Bill these tests*: all that is left, or some of it), or with the visit's bill (the consultation and the visit's tests not billed yet, on one bill). Each test billed keeps its bill line, and the database refuses a second one. A profile's tests are billed as the profile, one line, while none of them is billed; after that, or when the profile has no service, each by its own. A test with no service (*Billed as*) is not billed from its order. Part of an order can be billed now and the rest later. A test is cancelled on its own while its order is open and none of its results is typed: one not billed needs nothing more; one billed is returned on its bill (*Sales*), as any line is. Cancelling the last test cancels the order. A referral commission is worked out on what the order's tests were billed at, not on the whole of a visit's bill. Billing needs `sales.create`, and taking the money then `sales.edit`, as every bill.
- **Why:** a doctor's role does not bill, so the desk bills the tests a doctor orders, whenever the patient pays; a bill linked to each test means none is billed twice or forgotten.
- **Change it:** *Lab orders › Tests & panels* (*Billed as*: each test's and profile's service and so its price).

#### The clinic's drug list

- **Rule:** each clinic keeps its own drug list: a medicine's generic name, brand names, strength, form, route, the usual dose and how often, the most a day (an amount in mg, g, mcg, ml, IU, units, tablets, capsules, puffs, drops or sachets) and its allergy group. One entry per generic name, strength and form; a medicine is switched off, never deleted. The doctors keep it (`patients.edit_clinical`), and it can be imported from a spreadsheet, checked first and taken all or nothing. The prescription picks from it, filling the strength and the usual dose and timing; a medicine written by hand is still allowed and is marked as not on the list. A pharmacy's drug master stays its own.
- **Why:** the owner's rule: each clinic keeps its own list. A licensed drug database can come later.
- **Change it:** *Today's patients › Drug list*.

#### Prescription warnings

- **Rule:** each line of a prescription is checked as it is written, when it is saved and again when the consultation is completed: a known allergy of the patient (as written on the clinical card) meeting the medicine's generic name, a brand name or its allergy group, or the allergy group of a medicine on the list the allergy names (an allergy to aspirin, an NSAID on the list, warns for ibuprofen too); the same medicine, or two medicines of one allergy group, on one prescription (the later line); a day's dose over the medicine's most. A day's dose is the line's dose (one of the form when none is written) times how often: a pattern adds up its numbers (1-0-1 is two), OD and HS are one, BD two, TDS three, QID four, every N hours 24 ÷ N; it goes through the strength (650 mg a tablet, 125 mg in 5 ml) into the unit of the most a day. A dose taken as needed (SOS), or one written so that no figure follows, is not checked, nor is the dose of a line written by hand. The doctor may go on, giving a reason for each warning: a save without one is refused, and the warnings and the reasons are kept with the line. They are clinical data, kept with the consultation under the patient's record.
- **Why:** a safety net for the doctor, who decides; what was warned and why the doctor went on stays in the medical record.
- **Change it:** the drug list's allergy groups and most a day. The checks themselves are code, for a doctor's review (see [BACKLOG.md › At a glance](BACKLOG.md#at-a-glance), expert review).

### Roles by business type

- **Rule:** some roles belong to one type of business: Pharmacist to a pharmacy; Doctor, Lab technician and Pathologist to a clinic & lab; Optometrist to an optical shop; Mechanic to a garage; Trainer to a gym, studio or coaching centre; Karigar / goldsmith to a jeweller; Pump attendant (DSM) to a fuel station; Front desk and Housekeeping to a hotel, lodge or guest house. A business of that type starts with them, and other types do not get them.
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

- **Rule:** a bill names at most one fitter, when it is posted (Quick bill, New sale, or the bill made from a quotation), or afterwards ([A fitter named afterwards](#a-fitter-named-afterwards)); a fitter switched off cannot be named. Each line earns by one rule: the item's own, else the nearest category's up the tree, else the rule for every item; one rule of each is on at a time. A percent is of the line's value before GST, after discounts; an amount per unit is for each stock unit of that one item, and never more than the line's value. The commission is worked out in paise when the bill is posted and kept with it: changing or switching off a rule later never changes it, and the database refuses any change to it. Goods taken back on the bill take back the line's commission in proportion to what has come back so far, so a line returned in parts gives back exactly what it earned.
- **Why:** a fitter is owed what the bill earned when it was made; rates change, the bills behind them do not. A return undoes the sale it belongs to, and the commission with it.
- **Change it:** the rules on *Customers & contractors › Fitters › Commission rules*; who may change them is the role's `fitter_commission.edit`.

### A fitter named afterwards

- **Rule:** a posted bill made without a fitter may have one named afterwards by someone who may change commission rules (`fitter_commission.edit`): its lines earn by the rules in force then, and goods already back take back their share, as a return afterwards would. Its fitter may be changed, with an activity log row, until the commission on it is paid; payouts settle a fitter's commission oldest bill first (less what returns took back), and a bill whose commission they cover keeps its fitter (the database refuses the change). A sales order may name a fitter while it is still to send: every invoice its dispatches raise earns them their commission as a bill naming them would, and naming one then names them on the order's invoices already raised without a fitter, for someone who may also name a fitter afterwards.
- **Why:** a painter often comes for his commission after the bill was made; once paid, the commission must stay with the fitter who was paid it.
- **Change it:** who may name a fitter afterwards is the role's `fitter_commission.edit`.

### A fitter is paid what is due, through the expense book

- **Rule:** what a fitter is due is what their bills earned, less what returns took back, less what they were paid. A payout is never more than that. Each payout is a paid expense of the shop, dated today at the location that paid, so the day's money counts it; reversing that expense takes the payout back and the amount is due again. Paying needs both `fitter_commission.approve` and `expenses.create`. Commission records and payouts are never edited or deleted.
- **Why:** money paid to a fitter leaves the drawer or the bank like any other expense, and the books must show it once.
- **Change it:** who may pay is the role's `fitter_commission.approve`.

### A tinted line is made to order

- **Rule:** with *Paint tinting* on, a bill or quotation line of a base item kept in stock (by quantity or batch) may be tinted to a shade that is on; an item that says which base it is takes only shades needing that base. The tinting charge is a service item of the shop's, billed at its own GST slab, one for each tin. Each tinted line of a bill is a job on the tinting board: queued, then tinted (the base leaves stock then, through the core, from the line's own batch), then handed over, one step at a time. Billing keeps the base free: what is in stock at the location, less what waits on the board, must cover the line. A tinted line is never taken back on a return (the database refuses it): it is taken back from the board, whole, on the PIN of someone who may take goods back (`sales.refund`), as a return that puts nothing back in stock, with the activity log row naming who approved it; its money goes back by a refund on the bill. A quotation's tinted line is billed tinted, from one batch; a quotation with a tinted line is not made into a sales order. Nothing here drives the tinting machine: the maker's own software does.
- **Why:** a tinted tin has no second buyer, and its base is in stock until the tinter takes it.
- **Change it:** the tinting charge under *Sales history › Paint tinting*; who may take a tinted tin back is the role's `sales.refund`.

### Shades are kept per maker

- **Rule:** a shade is kept once for its maker and code, with its name, card, the base it needs and an optional formula (colourants and their millilitres for one litre of base). Shades are typed, or imported from a spreadsheet with the platform's import safety: a check first, all or nothing, only what the file says changes, the same file twice changes nothing. A shade is switched off, never deleted; a job keeps its shade.
- **Why:** each maker numbers its own shades, and a shop keeps hundreds.
- **Change it:** the shades under *Sales history › Paint tinting* (the role's `hardware_tinting.edit`).

### The calculators give estimates, and keep their workings

- **Rule:** the material calculators work out, on the server, bricks and mortar for a wall (its size and thickness, less openings), cement, sand and aggregate for concrete or plaster (an area and a thickness, or a volume, and a mix), and steel by bar diameter and length, as well as tiles and paint. Every assumption is shown and may be changed for the job: the brick size and joint, the mix and its dry-volume factor, the wastage, a bag's kilograms and cement's density, steel's weight of one metre (diameter² ÷ 162 kg, from steel's density) and a bar's length. Results are rounded up to what a shop sells: whole bags, bricks and kilograms, whole cubic feet; an item's own unit then takes the quantity where it can (a quintal of steel, a cubic foot of sand), and says where it cannot (sand sold by the tonne). The working (what was typed, the assumptions and the result) is kept with the quotation, with the revision it was added in, or with the bill, and printed on the quotation. These are estimates for the customer, not engineering.
- **Why:** a contractor buys by the job; the shop shows how it arrived at the quantities.
- **Change it:** the assumptions in the calculator, for each job.

### The rate board keeps each item's history

- **Rule:** the rate board lists each item's earlier rate changes, newest first, as the activity log keeps every price change from any screen (the board, the item, a purchase that set a new selling price): the day and time, the rate before and after, who changed it, and the purchase that set it. A change of the MRP alone is not a rate change.
- **Why:** a customer or the owner asks what cement cost last week.
- **Change it:** nothing to set.

## Seeds, fertilisers & pesticides

A farm-input shop sells as every goods shop does ([Shops and the shared core](#shops-and-the-shared-core)), and with its tools on (*Seeds, fertilisers & pesticides*) each item says what kind of farm input it is: fertiliser (subsidised or not), seed, pesticide, bio-input or another item. These rules follow from that. Each is checked by the server before the bill is saved, and again by the database where the bill's farm-input lines are kept. Review them with an agriculture officer of the state before trading: licence validity and dealer rules differ by state.

### A fertiliser, seed or pesticide sells only under a licence in force

- **Rule:** while *Licences & registrations* is on, a bill line of a fertiliser, a seed or a pesticide is refused unless the selling location holds, that day, a licence in force that covers fertilisers, seeds or insecticides respectively, for the kind of sale: a sale to a buyer with a GSTIN (a B2B invoice) is a wholesale sale and needs a licence for wholesale sales; any other sale needs one for retail sales. The refusal says which licence is missing, switched off, run out (and when, and why a renewal applied for did not keep it), not yet valid, or for the other kind of sale. A licence in force only while its renewal is pending bills with a warning ([A renewal applied for](#a-renewal-applied-for)). With *Licences & registrations* off, bills are not checked against licences, and *Settings › Farm input checks* says so. Bio-inputs and other items need no licence here. The counter asks the same checks ahead as the lines are typed.
- **Why:** the Fertiliser (Control) Order 1985, the Seeds (Control) Order 1983 and the Insecticides Rules 1971 each require the dealer to hold an authorisation or licence for each place of business; selling without one is selling unlicensed.
- **Change it:** keep each location's licences under *Settings › Licences*; switch the check off by switching *Licences & registrations* off in *Settings › Business tools*.

### An insecticide needs its endorsement and its principal's certificate

- **Rule:** at the counter, a pesticide whose item (or its brand) is not endorsed on the location's insecticide licence in force, or whose manufacturer (the item's manufacturer, else its brand) has no principal certificate on that licence in force that day (none, withdrawn on or before the day, not yet valid or run out), is billed with a warning that says which, or refused with that reason, as the shop's setting says: warn, to start with. The warning is kept with the bill in the activity log. The database does not repeat this check.
- **Why:** the Insecticides Rules 1971 allow a dealer to sell only the insecticides endorsed on the licence (rule 10(4)), each backed by its manufacturer's principal certificate (rule 10(4A)), which the manufacturer can withdraw.
- **Change it:** the endorsements and certificates on the licence, under *Settings › Licences*; warn or stop under *Settings › Farm input checks* (the role's `licences.edit`).

### Fertiliser from a source without Form O warns

- **Rule:** a purchase of fertiliser at a location is received with a warning, kept in the activity log, when the location's fertiliser authorisation in force has no certificate of source (Form O) that is on and names that supplier (by the supplier chosen on it, or by the source's name as on the certificate); or when the location holds no authorisation in force. The purchase is not refused.
- **Why:** the Fertiliser (Control) Order 1985 asks for a Form O from each source the fertiliser comes from (clause 8); a missing one is for the shop to obtain, not a reason to leave stock unrecorded.
- **Change it:** the certificates on the authorisation, under *Settings › Licences*.

### A banned molecule is never sold

- **Rule:** a pesticide's active molecules are kept with the item, by name. An item made of a molecule the molecule list marks *banned* cannot be added or given that molecule, and is never billed, even if the molecule was banned after the item was made. The database refuses both.
- **Why:** a molecule banned for use in India must not reach a farmer from the shop.
- **Change it:** nothing to set: the list is the platform's (below).

### A molecule barred on some crops is never sold for them

- **Rule:** a pesticide made of a molecule barred on some crops (for example chlorpyrifos on ber, citrus and tobacco) is billed only with the crop the farmer is buying it for: the line's own, or the bill's. The crop is matched to the crops the shop knows, by name or another name (jowar is sorghum): the platform's crops, with the other names and groups the shop added to them, and the shop's own crops. A molecule barred on a group (vegetables; fruits; pulses; cereals and millets; oilseeds; fruits and vegetables eaten raw) is barred on each crop in it, so tomato stops a molecule barred on vegetables, and the refusal says so ("… must not be used on vegetables (tomato is one)"). A crop the shop does not know is kept with the line as it was said.
- **Why:** S.O. 4294(E) of 3 October 2023 bars some molecules on named crops, and some on whole groups of crops, while allowing them on others; only the crop tells them apart.
- **Change it:** the shop's own crops, their other names and their groups under *Farm inputs › Crops*; the platform's crops and groups only by a migration.

### The molecule list is the platform's, and only what is cited

- **Rule:** the molecule list (*Farm inputs › Molecules*) is platform data, the same for every shop and changed only by the platform. Each entry has its status (banned, restricted use or barred on some crops), the crops it must not be used on, its rule in words and the order it comes from. It holds only entries with a cited source: six banned molecules, five restricted ones and seven barred on named crops. A restricted-use molecule (aluminium phosphide, methyl bromide, DDT, the smoke generator of cypermethrin) is sold only to a tagged buyer, and carbofuran is kept for sale only as its 3% CG (below).
- **Why:** a list a shop could edit would not protect anyone, and an entry without its source cannot be checked.
- **Change it:** the platform adds and corrects entries with a migration as orders change ([BACKLOG.md › Left inside built modules](BACKLOG.md#7-left-inside-built-modules)).

### A seed lot is sold only while valid

- **Rule:** a seed is kept by batch, and a seed lot's expiry is its validity date. A receipt of seed, or a seed's opening stock, needs that date. The lot's tag is kept under *Stock › Seed lots*: the date of test, germination, physical purity, the tag number and the SATHI QR texts scanned for it. The lot is then valid until 9 months after its test; each passing retest makes it valid 6 months longer, from the date it was valid until; a failed retest is kept and changes nothing; every retest is kept as entered. The lot's expiry, at every location that holds it and on transfers in transit, follows the validity, so the counter sells it until then and not after: the bill is refused, naming the lot and the date. A receipt of a lot whose tag is kept takes the tag's date (another date is refused). The test is corrected only until the lot is retested. A pesticide is kept by batch too, and a batch past its expiry is refused the same way, to be kept apart ([Stock kept apart is never sold](#stock-kept-apart-is-never-sold)).
- **Why:** the Seeds (Control) Order and seed certification fix a lot's validity from its test date and allow its extension by retesting; the Insecticides Rules forbid selling expired stock.
- **Change it:** nothing to set; the tag and its retests under *Stock › Seed lots*.

### A subsidised fertiliser carries its PoS receipt

- **Rule:** a fertiliser marked *subsidised* is billed only with the receipt number the government's PoS device printed for the sale (letters, digits, - and /): one for the bill, or one on each line. It is kept with each subsidised line and printed on the bill. No Aadhaar number is ever asked for or kept; the Farmer ID kept with a farmer is the Agri Stack one. A PoS receipt on any other line is refused.
- **Why:** every subsidised fertiliser sale goes through the Aadhaar-checked PoS device, and the company is paid the subsidy only on those; with no link to the PoS, the receipt number is what ties the bill to the PoS sale.
- **Change it:** the item's *Subsidised* box.

### The PoS stock is typed in, never changed

- **Rule:** *Type the PoS stock* keeps, for each subsidised fertiliser at a location, what the PoS device shows and the shop's own stock at that moment, under the business's date. The reconciliation shows, by day and fertiliser, the bags billed, the bills and PoS receipts, what came back, and the last entry of the day with its difference. Entries are never changed or deleted; a mistake is put right by typing it again.
- **Why:** the shop's stock and the PoS's must agree; the difference is what the company and the inspector look at.
- **Change it:** nothing to set.

### Season credit is due at the harvest, within its limit

- **Rule:** a customer's credit for a season (kharif, rabi or zaid, of the year before, this year or the next) is kept once under *Farm inputs › Season credit*, given by a manager (`agri.approve`): the harvest date it falls due (today or later, at most 400 days away), a limit (or none), its interest on overdue, a guarantor and the crop pledged. A bill left on udhaar for the customer may go on it, at the counter or from a quotation; naming a season with its year and date at the counter opens the customer's credit for it (no limit, no interest) when there is none. The season's date is the bill's due date, so the bell, Udhaar and the dues by village count it as overdue only after it. A bill is refused on a season that is closed, past its due date (new credit goes on a new season), with another due date, or that its unpaid part would take over the season's limit. A walk-in's bill, or one paid in full, carries no season. The season is kept with the bill and never changed. Once a bill is on it, its due date and interest stay as they were given; its limit, guarantor and crop pledged may change. A season's credit is never deleted: it is closed.
- **Why:** farmers buy on credit for a crop and pay when it is harvested; the limit, the guarantor and the crop pledged are what the shop gives the credit on.
- **Change it:** the terms under *Farm inputs › Season credit* (`agri.approve`).

### Season interest is worked out to the paisa, and billed only when confirmed

- **Rule:** a season carries no interest, a % a month after its due date, or a % a month from each bill's date (0.01% to 10%). It is simple interest, never on interest: each day after the start, up to and including today on the business's clock, earns a thirtieth of the month's % on what was still owed on the bill at the end of that day (its total less returns and payments, plus refunds, from the day each happened); each bill's interest is rounded to the paisa, half up, once. Nothing is charged until someone confirms it: *Bill the interest* (`agri.approve` and `sales.create`) posts, through the core, a bill of the shop's interest item for the interest due (worked out less what was billed before) on the season, due at once, at the item's GST slab and the shop's price terms and rounding; it is never held to a credit limit, and a bill of interest earns none. The interest seen must still be the interest due (a payment in between refuses it). The workings, bill by bill and day by day, are kept with it.
- **Why:** interest the shop may charge is what was agreed and confirmed, worked out the same way every time; charging it as a bill puts it in the books and in GST as any other supply.
- **Change it:** the season's interest when it is given; the interest item under *Settings › Farm input checks*.

### Produce taken pays the season's bills, and no money moves

- **Rule:** produce taken from a farmer against their season (crop, quantity in quintals, kilos, bags or tonnes, rate) is valued at quantity × rate, half up to the paisa, numbered PR-1, PR-2… for the business, and pays the season's bills oldest due first, as core payments on the bills named *Produce* (a credit-note method): no money moves, so the drawer and the day's takings do not count it. It is never worth more than is owed on the season. The produce is not taken into stock.
- **Why:** a farmer often settles season credit with the crop; recording it as a payment on the bills keeps their dues and the shop's books right without inventing cash.
- **Change it:** nothing to set; taken by a role with `receivables.create`.

### The registers come from the transactions

- **Rule:** the stock and price board (each fertiliser's and seed's opening stock on a day, and its closing stock once the day is over), the monthly seed stock return (Form D), the insecticide sale register, the monthly return of insecticides (Form XIV), Form XIII (insecticides sold to dealers, a bill to a GSTIN, and to customers tagged bulk consumers) and the register of sulphur buyers are worked out from the bills, purchases, returns and stock movements of the location, on the business's own clock; nothing is typed twice. The board shows today's price and MRP now, and a day gone by at that day's prices, as they stood at its end (every price an item and a branch had is kept, from when). The seed return gives quintals where an item's unit is a weight or its weight of one is given; other changes are corrections, counts, stock kept apart and transfers. The seed return is due by the 5th of the next month and Form XIV by the 15th; each is marked sent once, and the bell reminds until it is (critical after its date).
- **Why:** the Fertiliser (Control) Order and the Seeds (Control) Order require a daily display of stock and prices, the Seeds (Control) Order a monthly return, and the Insecticides Rules a record of insecticide sales with their batches, Forms XIII and XIV and a register of sulphur's buyers; working them out from the same records keeps them true to the books.
- **Change it:** nothing to set.

### A restricted-use pesticide goes only to a tagged buyer

- **Rule:** a pesticide made of a restricted-use molecule (aluminium phosphide, methyl bromide, DDT; cypermethrin only as its smoke generator) is sold only to a customer tagged a pest-control operator (with their licence number) or a government body (with the order or authority it buys under), the tag on and not past its date. Anyone else, a walk-in too, is refused; where the shop chooses *Stop it unless a manager allows it*, a manager's override lets that one bill through. The tag the line was sold under is kept with it and shows in the insecticide register. Tagging an operator or a government body is a manager's (`agri.approve`); a tag is switched off, never deleted.
- **Why:** the registration of these molecules confines their use to government bodies and approved pest-control operators.
- **Change it:** the tags on *Farm inputs › Farmers & village dues*, Tagged buyers; stop or allow an override under *Settings › Farm input checks*.

### A molecule allowed in one formulation is kept only in it

- **Rule:** an item made of a molecule the list allows in one formulation only (carbofuran: 3% CG) is refused when it is added or given another (or no) formulation, and never billed in another. The formulation is kept with each pesticide line.
- **Why:** carbofuran's other formulations are banned; only its 3% CG remains registered.
- **Change it:** nothing to set.

### A crop not on the label is billed with a warning

- **Rule:** a pesticide may name the crops or groups on its label. Billed for a crop not among them (by name, other name or group), the bill goes through with a warning, and the line is kept as *not on its label* in the insecticide register.
- **Why:** using a pesticide on a crop it is not registered for is the farmer's risk; the shop says so and keeps a record, but the label is the company's, not a ban.
- **Change it:** the crops on the item's label (Products).

### A manager's override is for one bill

- **Rule:** an override (a restricted-use pesticide for a buyer not tagged, or subsidised bags over the limit) is given before the bill, at that till, with the reason and the PIN of a member whose role holds `agri.approve` (none for a manager allowing their own bill; the PIN is never kept). It is for that day, that till, the customer it names (bags: always a customer) and, for restricted use, the items it names; one bill uses it up. It is offered only where the shop's setting allows it. The bill keeps it, and the activity log keeps who allowed what and why.
- **Why:** an exception needs someone answerable for it, and must not be reused for another sale.
- **Change it:** *Settings › Farm input checks*: stop outright, or allow a manager's override, for each.

### A farmer's subsidised bags are held to the month's limit

- **Rule:** a named customer's subsidised fertiliser in a month (on the business's own calendar, in each fertiliser's stock unit, less what came back on those bills) is held to the limit of the state the selling location is in: 50 bags a month unless the shop sets its state's. From 80% of it the counter warns; a bill that would take the farmer over it is refused, or, where the shop allows, let through by a manager's override. A walk-in's bags are not counted.
- **Why:** states cap the subsidised fertiliser one farmer may take in a month, to stop diversion; the cap differs by state and season.
- **Change it:** the limit of each state and stop-or-override under *Settings › Farm input checks* (`settings.edit`).

### Stock kept apart is never sold

- **Rule:** stock is kept apart under *Stock › Kept apart* as expired (a batch past its expiry: segregated, marked not for sale, until it is disposed of as the Central Government specifies; this is the register of expired stock), seized by an inspector (with their name and the seizure receipt) or sampled (with the sample slip). Each takes the quantity out of saleable stock by a core stock adjustment, so none of it can be billed; each is closed once, with the date and how it was disposed of or what came of it. Seized stock released goes back into the batch it came from by another stock adjustment. Entries are never changed or deleted.
- **Why:** the Insecticides Rules 1971 require expired stock to be kept apart, marked and recorded until disposal (rule 10A), and an inspector's seizure or sample to be accounted for.
- **Change it:** nothing to set.

### Insecticides are not kept with food or feed

- **Rule:** a location may be marked as also storing or selling food or animal feed. An insecticide other than a registered household one received there comes in with a warning, and while it holds any, the bell says so. Nothing is refused.
- **Why:** the Insecticides Rules 1971 forbid storing or displaying insecticides with food or feed (rule 10C); the shop is the one to put it right.
- **Change it:** the locations under *Settings › Farm input checks*.

### Sulphur is sold with its buyer's name and address

- **Rule:** a bill with an item made of sulphur needs its buyer: a walk-in's name and village, or a customer with an address or a village as a farmer. Each sale goes in the register of sulphur buyers.
- **Why:** the Insecticides Rules 1971 require a register of sulphur's buyers with their names and addresses (rule 10B).
- **Change it:** nothing to set.

### A company scheme's ledger comes from the purchases

- **Rule:** a supplier's scheme for a season names its items (in one unit), its dates and what reaching each quantity earns: a rebate on every unit at the slab reached, a target rebate, free goods, a gift; of each kind, the highest tier reached counts. What it counts is worked out from the receipts of those items from that supplier in its dates (on the business's clock), the units paid for (free units on the bill are not), less what went back. The claims made and what came back on each set what is still due. The ledger keeps account only: a credit note or free goods from the company are entered as any other purchase.
- **Why:** the shop must know what it is owed by each company and chase it; the purchases already say what was bought.
- **Change it:** the schemes under *Purchases › Company schemes* (`purchasing.edit`).

### The advice line is printed when switched on

- **Rule:** with *Advice on the bill* on, each pesticide line on the bill carries a line of advice from the item's details: its dose an acre, the days to wait before harvest and the protection to wear. It is kept with the line as it was billed.
- **Why:** the safe use of a pesticide is told best on the bill the farmer takes home.
- **Change it:** *Settings › Farm input checks*.

## Optical shops

An optical shop sells as every goods shop does ([Shops and the shared core](#shops-and-the-shared-core)); with *Prescriptions & spectacle orders* on it also keeps its customers' prescriptions, makes spectacles to order through a lab or its own workshop, and looks after its contact-lens customers. Each rule below is checked by the server, and the ones about records that must not change are held by the database too.

### A prescription's powers are checked as they are written

- **Rule:** a prescription is for spectacles or for contact lenses, and keeps its kind. A spectacle prescription has, for each eye, at most one row for distance, near and intermediate vision: SPH and CYL in steps of 0.25 from -30 to +30 (plano is 0.00); AXIS a whole number of degrees from 1 to 180, given with a CYL other than 0 and only then; ADD from +0.25 to +4.00, on the near or intermediate row only; a horizontal prism with its base in or out, and a vertical prism with its base up or down (each 0.25 to 20 prism dioptres, in steps of 0.25); and the visual acuity. A row needs at least one of them, and a prescription at least one row. The PD is of both eyes together or of each eye, never both; the vertex distance is 5 to 25 mm. A contact-lens prescription has, for each eye fitted, its lens: the power (0.00 for plano), the base curve (6 to 10 mm) and the diameter (8 to 25 mm), a CYL (not 0) with its AXIS for a toric lens, an ADD for a multifocal one, and its colour, brand, how often it is replaced and the wearing schedule; it has no PD or vertex distance. The test is never on a day still to come. A refusal names the eye, the vision or lens and the power.
- **Why:** a prescription is written per eye in quarter-dioptre steps, with the axis of a cylinder; a contact lens is fitted by its curve and width as well as its power, and is kept apart from the spectacle prescription. A power typed wrong makes the wrong lenses. How the prism's base is written is not settled for India, so it is a choice from a list.
- **Change it:** nothing to set.

### The examiner is named, with their registration

- **Rule:** a prescription is examined by a member of the business, named as they are, or by an outside doctor or optometrist, named with the registration number on their prescription (required). A member's registration number is optional; the form offers the one on their latest prescription, with the council it is with and the day it is valid until, which may be given only with a number. A registration that ran out before the day of the test is warned of: the prescription is kept, with the warning, and the list marks it.
- **Why:** optometrists are a listed profession under the National Commission for Allied and Healthcare Professions Act, 2021, so who examined, and their registration, belongs with the powers; a registration that has run out is the shop's to put right, not a reason to lose the test.
- **Change it:** nothing to set.

### A prescription on a spectacle order never changes

- **Rule:** a prescription can be corrected, its customer included, until a spectacle order uses it; its kind never changes, and one recorded from an eye-test booking stays with that booking's customer. The activity log keeps what was and what is. From then on it and its powers never change, and the database refuses it: a correction is a new prescription. A spectacle order is made from a spectacle prescription, never a contact-lens one, and keeps a copy of it as it was when booked. A prescription is never deleted.
- **Why:** the spectacles were made from those powers; what the lab was given must stay as it was.
- **Change it:** nothing to set.

### An eye test done opens its prescription

- **Rule:** an eye-test booking marked done offers its prescription for the booking's customer, kept with the booking. A booking gives at most one spectacle prescription and one contact-lens prescription; a prescription is kept with a booking only once the booking is done, and only for its own customer.
- **Why:** the prescription is what the eye test was for; linking the two keeps one test from being recorded twice.
- **Change it:** nothing to set.

### Valid a year, due for a test after the recall months

- **Rule:** a prescription is valid until a year after its test unless another day is given (on or after the test, at most five years after it). The recall list holds every active customer whose latest test was their recall months ago or more: the shop's months (12 to start with, any whole number from 1 to 60), or a group's own when the shop sets one: children (under 18 by the age given at their latest test that gives one, counting the years since), contact-lens wearers (a contact-lens prescription here) and progressive wearers (a spectacle order with a progressive lens, not cancelled). A customer in several groups is due after the shortest of their groups' months; a group with no months of its own follows the shop's.
- **Why:** no rule was found that sets how long a prescription stays valid or how often to test again, so the year is a starting value each shop changes; children's eyes, contact-lens wearers and progressive wearers are usually seen more often.
- **Change it:** *Valid until* on each prescription; the months on *Customers › Recall list*, by a role that holds `settings.edit`.

### An order is priced at booking, and billed with the day's GST

- **Rule:** an order's items (the frame from stock, the lens items, other items) are priced when it is booked exactly as a sale of them would be then: customer and slab prices, branch prices, running offers, the discount (with its reason, within the counter's limit), GST and round-off. Booked from a quotation, its lines and prices are the quotation's (one open, valid on the business's day, priced in the terms the business prices now, for the prescription's customer and from the order's location): the frame and each lens are lines of one unit, every other line goes on the order, and the quotation closes as booked. The order keeps those prices. Delivery posts the bill at them, with GST at each item's rate on the day of the bill: a price that includes GST keeps its total and its GST is worked out again from it; a price before GST keeps its taxable value. Delivery is refused when an item is switched off, its pack size changed, or what the bill would charge for one unit is above its MRP now.
- **Why:** the customer agreed the price when they ordered; GST is the rate of the day of the invoice, and nothing is sold above its MRP.
- **Change it:** nothing to set; GST is each item's slab (spectacles, frames, spectacle and contact lenses 5%, sunglasses 18%).

### A lens item's details are the order's

- **Rule:** a lens billed as a lens item that keeps its details (its design, index, material, coatings and tint) takes them onto the order; one typed that differs from the item's is refused. A lens with no item, or an item without them, takes what is typed, and needs its type. An item is a spectacle lens or a contact lens, never both.
- **Why:** the lens billed is the lens made: picking it rather than typing it keeps the job card and the bill the same.
- **Change it:** the details on the item (*Frames, lenses & products*).

### A booked order can be changed until it goes to the lab or the workshop

- **Rule:** while an order is booked, someone who holds `optical.manage` (and `sales.create`) may change its frame, lenses, other items, discount and measurements: the lines are priced again as at booking, the change is kept in the activity log with what was and what is, and the history notes it without amounts. The advances taken never come to more than the new total. Once the order goes to the lab or the workshop, its frame, lenses and prices never change, and the database refuses it; its customer, prescription, remake and booking advance never change at all.
- **Why:** a customer often changes their mind before anything is made; once lenses are cut or ordered, the job is what was sent.
- **Change it:** who may change a booked order is the role's `optical.manage` (the owner and a manager by default).

### Stock leaves at delivery; a frame can be held

- **Rule:** nothing leaves stock when an order is booked. The frame and the other goods leave stock at delivery, from the order's location: a batch item oldest expiry first, and an item not in usable stock there (or past its expiry) stops the delivery until it is received. A frame from stock can be held for an order, at booking or later (one unit, in a usable lot of the order's location with one not held by another order): its lot never goes below what is held, whatever takes it (a bill, a transfer, a count, an adjustment), and the database refuses it with the order's number. A hold is released by hand, when the frame changes or the order is cancelled, or delivered, once; a held frame is billed from its own lot.
- **Why:** the bill and the stock move together, when the customer takes the spectacles; a frame chosen for an order must still be there when the lenses come.
- **Change it:** hold or release the frame on the order (`optical.edit`).

### The advances are the customer's money on account

- **Rule:** an advance taken at booking, and each taken later while the order is open, is a numbered collection receipt in the customer's name, by cash, UPI, card or bank; together they never pass the order's total. A remake the shop or the lab bears takes none. They pay first when the order is billed, oldest first. On a cancelled order they stay the customer's: each is handed back from the order (all that is left of it, or part, by cash, UPI or bank, with a reason and a manager's PIN), or stays on their account for a later bill. The cash limit counts them like any collection.
- **Why:** until the spectacles are billed the money is the customer's; money leaving the drawer needs a second person's say-so.
- **Change it:** who may take an advance is the role's `sales.edit`; who may approve handing it back, `sales.refund`.

### The work goes one step at a time, and the quality check is signed

- **Rule:** an order goes from booked to the lab or the workshop, between the two, to the quality check, and from the quality check to ready (passed) or back to the lab or the workshop (failed, with what was wrong); ready spectacles found wrong go back the same way, with the reason; ready goes to delivered. In the workshop, cutting, edging and fitting are kept, each with who did it and when, in that order: a step may be left out (the lab did it) but none is done after a later one, and a step done already on this visit is not kept twice. From the workshop, the quality check needs the fitting done on this visit (each time the order comes back, it is fitted again). Steps are never skipped and the database refuses any other move. Passing or failing the quality check needs `optical.approve`, and a pass is stamped with who and when; an order is ready only after a pass. Cancelling needs a reason. A delivered or cancelled order never changes, and nothing about an order is deleted; every step is kept with who made it.
- **Why:** finished spectacles are checked against the prescription before the customer gets them, and the job's history shows who did what.
- **Change it:** who passes the quality check is the role's `optical.approve` (the owner, a manager and the optometrist by default).

### A lens needs its fitting, and a multifocal its near power

- **Rule:** each lens on an order needs powers for its eye on the prescription and that eye's fitting PD. A bifocal or progressive lens also needs the near power (an ADD, or a near SPH) for its eye on the prescription and that eye's fitting height. The frame's size is kept with the order: A (20 to 80 mm), B (10 to 70 mm) and DBL (10 to 30 mm).
- **Why:** a lens is centred on the eye's PD, and a bifocal or progressive lens is placed by its fitting height and made with the reading power; the lab cuts the lens to the frame's size.
- **Change it:** nothing to set.

### Lenses carry a warranty from delivery

- **Rule:** when the shop sets warranty months (1 to 60; none until set), each lens on an order delivered is under warranty until the day of delivery plus the lens months, and its coatings (when it has any) until the day of delivery plus the coating months; the dates are written once, at delivery, and never change.
- **Why:** lens and coating warranties are the shop's own promise; the periods were not found in any rule, so each shop sets its own.
- **Change it:** *Warranty on lenses* on *Spectacle orders*, by a role that holds `settings.edit`.

### A remake is linked to its order, and costs the customer nothing unless they bear it

- **Rule:** only a delivered order is made again, for its own customer: a new order linked to it, with the reason and who bears the cost (the lab, the shop or the customer). When the lab or the shop bears it, the order costs the customer nothing (the database holds its total at 0): no discount, no advance, and a bill of 0 when it takes stock at delivery. When the customer bears it, it is priced as any order. A remake for a lab defect or a breakage while the original's lens warranty runs, or for a peeled coating while its coating warranty runs, is under warranty (kept with the remake); when the shop's rule makes remakes under warranty free, the customer cannot be named to bear it.
- **Why:** a lab's mistake, a breakage under the shop's promise or a customer who cannot get used to the lenses is not the customer's cost, and the link keeps the job's whole story.
- **Change it:** the warranty months and *A remake under warranty* (free or charged) on *Spectacle orders*.

### The referring doctor is kept, and reported

- **Rule:** a prescription and a spectacle order may name the doctor who referred the customer, as written; an order takes its prescription's unless another is given. The referral report counts, for the dates chosen on the business's clock, each doctor's spectacle and contact-lens prescriptions (by the day of the test), customers and orders booked and delivered (by the day booked), the same name in any case or spacing counting once; what the orders come to and what was billed only for a role that holds `sales.view`.
- **Why:** hospital-attached opticals and shops working with eye doctors account for the customers each doctor sends.
- **Change it:** nothing to set.

### Each contact-lens power is an item

- **Rule:** with Variants on, the power grid makes one item for each power of the ranges given (from -20.00 to +20.00, in steps of 0.25 or 0.50), all of one product with one base curve (7 to 10 mm) and one diameter (12 to 16 mm), each keeping its power, base curve and diameter, and how often it is replaced and the lenses one unit holds when given. A toric lens's items are each power with each cylinder (up to 12, not 0) and axis (up to 36) given; a multifocal's each power with each ADD (up to 8); a coloured lens's each power in each colour (up to 12); these combine. At most 600 items are made at a time and 2,400 for one product. A power the product already has is left as it is; another base curve or diameter is another product, and so is another kind (toric, multifocal or coloured, or not). Each power then has its own price, stock and batches like any item.
- **Why:** contact lenses are stocked and sold power by power, and a toric's or a multifocal's variants are as many.
- **Change it:** each power's price and details on the item.

### Contact lenses are sold under the MD-42 registration, and checked against the prescription

- **Rule:** a bill with contact lenses (items that keep a base curve) is refused unless the location holds a medical device sale registration (MD-42) in force on the business's day, kept under *Settings › Licences*; so is a free trial of them. Each lens on such a bill is checked against the named customer's contact-lens prescription in force on the day: a lens whose power, base curve, diameter, CYL and AXIS, ADD or colour matches no eye of it, a customer with no such prescription, or a bill with no customer named, is posted with a warning, kept in the activity log with the bill. The batch of each unit sold stays on its bill line.
- **Why:** anyone selling contact lenses without a licence for them needs the MD-42 registration (G.S.R. 754(E) of 30 September 2022), which asks for purchase and sale records kept at least two years; a lens that does not match the prescription may be a mistake, but the optometrist may have changed it since, so it is warned of, not stopped.
- **Change it:** *Settings › Licences*.

### Contact lenses run out by the lenses sold

- **Rule:** a customer's contact lenses run out on the day of their latest bill with contact lenses that say how often they are replaced, plus the lenses kept on it (less those returned) ÷ 2 eyes × the days one lens lasts (daily 1, fortnightly 14, monthly 30, three-monthly 90, six-monthly 180, yearly 365; the shortest when a bill has several), whole days, on the business's clock. The due list holds those running out within 14 days or run out. A reminder needs the customer's consent to reminders, and is kept.
- **Why:** contact lenses are replaced on a schedule; the box sold tells when the next is needed.
- **Change it:** how often a lens is replaced and how many lenses a unit holds, on the power grid.

### A free trial is converted on payment, or lapses

- **Rule:** a free trial gives a customer contact lenses for 1 to 60 days (7 unless given): they leave stock by an adjustment, from a usable batch (the oldest expiry first unless named), and the trial keeps the batch. It converts by itself when the same customer pays for lenses of the same product (the trial names the bill), or by hand on a bill of that customer's with contact lenses; or it is marked lapsed. A trial closes once and is never deleted.
- **Why:** trial lenses are medical devices given out, so their batch is kept like a sale's; a trial that turns into a sale shows what trials are worth.
- **Change it:** nothing to set.

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

### Parts are priced as a sale would be, and leave stock once: when issued, or when the job is billed

- **Rule:** a part is an item kept in stock; labour and outside work are service items, and outside work needs its charge and the workshop that did it. A part is priced at the customer's price for it (their price list, the branch's price or the item's price) unless a rate is typed: a lower rate is a discount and needs `sales.discount`, and no part is charged above its MRP. A garage that does not issue parts takes nothing out of stock until the job is billed; then each part leaves stock at the job card's location (a serial-numbered part by its numbers, a batch by the oldest expiry first), and a part not in usable stock there stops the billing until it is received. A garage that issues parts (*Issue parts to mechanics*) has the store issue each part line's parts to a mechanic: they leave stock then, by a stock correction naming the job card and the mechanic, and are held for the job; parts not used are brought back the same way; the bill takes the parts held, at the cost they were issued at, and takes nothing out of stock again; a part line is billed only once it is issued in full (serial-numbered parts still leave stock on the bill, by their numbers). A line with parts held is not taken off the estimate or lowered below them, a job card with parts held is not cancelled, and issuing is not switched off while parts are held for an open job card. The bill keeps the job card's prices with GST at each item's rate on the day of the bill: a price that includes GST keeps its total, a price before GST its taxable value; a part charged above its MRP that day stops the billing.
- **Why:** the stock and the bill move together, so a part leaves stock once; a job card cancelled before it is billed leaves the stock as it was, or has its parts brought back; the customer agreed the estimate's prices, and GST is the rate of the day of the invoice.
- **Change it:** *Issue parts to mechanics* in *Settings › Garage settings*, by a role that holds `settings.edit`; who issues and brings back parts is a role holding `inventory.edit` with `garage.view` (the owner, a manager and a stock keeper by default). GST is each item's slab (parts and labour 18%, the tractor parts the GST Council listed 5%).

### Parts that fit a vehicle, and what to offer when one is out of stock

- **Rule:** a part (an item kept in stock) fits a make, and optionally a model, a variant, a fuel, years from and to, and an engine code; a field left empty fits any. The same fitment is kept once. A vehicle's parts are those whose fitment matches it, in stock first; where the vehicle's own variant, fuel, year or engine code is not known, a part that names one is listed to be checked. A part may be replaced by a newer one (an old number superseded by a new number), and the chain is never followed back to a part already in it; parts that do the same job are kept as a group. A part's substitutes are its newer and older numbers and its group's other parts, in stock first; the parts counter, the estimate, the parts used and a vehicle's parts offer them when a part is out of stock. Fitment can be imported from a CSV file, checked first, with fitment already kept left as it is. No catalogue of parts is shipped: the data is the shop's own.
- **Why:** a counter hand finds the part for a customer's vehicle from the registration on file, and a part out of stock does not lose the sale or stop the job when another one fits.
- **Change it:** *Parts & services › Parts fitment*, by a role that holds `catalog.edit` (the owner, a manager and a stock keeper by default).

### A job card's steps

- **Rule:** a job card goes from received to estimate sent, approved, in progress, waiting for parts and ready in the order the work needs (a received job card may start straight away); *Estimate sent* waits for the owner's approval of the version sent; a ready vehicle goes back to work only with the reason; *Ready* goes to delivered by billing the job. The database refuses any other move. A job card with lines is delivered only with its bill. Cancelling needs a reason. A delivered or cancelled job card never changes, nor do its lines, mechanics, claim, inspection, photos, parts issued and road tests. Every step is kept in the history with who made it.
- **Why:** the board shows where every vehicle is, and the history who did what.
- **Change it:** who cancels is the role's `garage.cancel` (the owner and a manager by default).

### The road test, and the gate pass

- **Rule:** a road test records who drove the vehicle (a member whose role works on job cards), how far (0.1 to 500 km), whether it passed and remarks (a test not passed says what it found); it is kept as recorded. A garage that asks for one marks a job ready only after a passed road test since the job last went back to work. Billing the job makes the vehicle's gate pass; the vehicle leaving is recorded once, with who saw it out and a note, and never changed.
- **Why:** a vehicle is handed back only once it was driven and found right, and the gate knows which vehicles may leave.
- **Change it:** *A passed road test before a job is marked ready* in *Settings › Garage settings*.

### The inspection keeps photos

- **Rule:** the inspection is a list of areas checked, each with what was found and its photos; a mechanic's photos of the work are kept on the job card too. A photo is a JPG, PNG or WebP of up to 5 MB, its bytes checked (a renamed file is refused), up to 60 a job card, kept in the server's private files and sent only to someone who sees the job card (the desk, and a mechanic on it). Photos are added while the job card is open and are never changed or deleted; an area with photos stays on the job card.
- **Why:** the photos show the vehicle's state when it came in, settle a dispute about a dent, and go in an insurer's claim file.
- **Change it:** nothing to set.

### A mechanic works on the job cards assigned to them

- **Rule:** someone whose role holds `garage.edit` but not `garage.view` (the Mechanic) sees only the job cards they are put on, on a screen of their own made for a phone (*Job cards*): the complaints, the parts and what was issued for them, the labour to tick done, the next step, the road test, and a note or a photo. They record the work done, add the parts they used (at the customer's price, as a new version), add notes, photos and inspection items, record road tests and move the job along (in progress, waiting for parts, ready), and print its copies. They see no prices, totals, bills or advances unless their role also holds `sales.view`. Sending the estimate, recording approvals and claims, taking an advance, and billing and delivering are the desk's. Only active members whose role holds `garage.edit` (or full access) can be put on a job card.
- **Why:** the mechanic does the work; the money and the owner's say-so are the desk's.
- **Change it:** *Roles & permissions*.

### A cashless claim is two bills that add up to the job

- **Rule:** a job card's claim names the insurer (a customer, never the job card's own), cashless or reimbursement, the day it was intimated (today or earlier), the policy number, the claim number, the surveyor, the amount the insurer approved (more than 0; in whole rupees where the business rounds its bills to the rupee), the deductible and the depreciation. Each line is paid by the customer or, on a claim, by the insurer. A cashless claim is billed as two bills: one to the insurer for exactly the approved amount, spread over its lines in proportion to their value and rounded on the running total so the parts add up to the paisa; and one to the customer for their own lines and the owner's share of the claim (the insurer's lines less the approved amount: the deductible, the depreciation and what was not allowed). The owner's share is split by the GST slabs of the insurer's lines: each insurer's line carries its value less its part of the approved amount, and these are added up by slab and billed as one line of the claim-share item at each slab (the tractor parts' share at 5%, the labour's at 18%), with GST taken out of each to the paisa. The two bills come to the job's total exactly. Billing waits until the approved amount and the claim number are in, the approved amount (and the approved amount with the deductible and the depreciation) is not more than the insurer's lines, and the claim-share item is set. A reimbursement claim is billed to the customer for the whole job, naming the claim; or, when it is to be billed in the insurer's name, it is billed as a cashless claim is and the customer pays the bill in the insurer's name in full at delivery (bill to the insurer, collect from the customer), with a claim file to print for them to claim with (the estimate, the bills with their GST, the photos and the payments). The claim is taken off only by making its lines the customer's (*Take the claim off* does both), and only while it is intimated; the claim of a delivered job card never changes. The deductible and the depreciation are typed on each claim.
- **Why:** CBIC Circular 217/11/2024-GST describes the garage issuing two invoices on a claim, one to the insurance company for the approved claim cost and one to the customer for the repair in excess of it (the compulsory deductible, depreciation, what the cover leaves out); the insurer may take input tax credit on the invoice in its own name, up to the approved claim cost. On reimbursement the insured pays the garage and the insurer repays them up to the approved claim cost; the invoice in the insurer's name lets it take that credit. The owner's share comes from the insurer's lines, so it keeps their slabs.
- **Change it:** the claim-share item in *Settings › Garage settings*; its HSN / SAC is printed on the share lines at each slab. Have an accountant confirm the share lines' HSN for parts at another slab.

### A claim's progress, the insurer's payments and what it did not pay

- **Rule:** a claim moves intimated (the day on the claim), surveyed, approved (once the approved amount is in), work done and re-inspected (each recorded by the desk with its date and a note), invoiced (when the job is billed) and settled; forward only, a step may be skipped, each on or after the one before and never after today, and kept as recorded. A claim that has moved past intimated stays on the job card. The insurer's payments are recorded against its bill (by bank, cheque, UPI, cash or card, with the UTR or cheque number), never more than is due on it; paid in full, the claim is settled. Once the insurer has paid what it will, what it did not pay is settled once: written off, with a manager's say-so (their PIN, or a manager's own reason), or billed to the customer by the desk. Either way a credit note on the insurer's bill takes it off its lines in proportion, each with its own GST (nothing comes back into stock), so the insurer's bill and its input tax credit follow what it paid; billed to the customer, a bill in their name carries it as lines of the claim-share item at the same slabs. The settlement, its credit note and bill, the reason and who approved are kept, with an audit row. A reimbursement claim billed in the insurer's name is settled when the customer pays it at delivery.
- **Why:** insurers often pay less than the approved amount after the work; the garage then either accepts it or recovers it from the owner, and the bill to the insurer should say what it paid for.

### The old parts (salvage)

- **Rule:** each part line records what became of the part it replaced: handed back to the customer, kept for the insurer's surveyor, or sold as scrap (or not recorded). Only a part line has one; it is recorded while the job card is open, by the desk or the mechanic on it, kept in the history and printed in the claim file; a line changed into labour loses it.
- **Why:** a surveyor may keep the damaged parts as salvage, and the owner may ask for theirs back; the record settles who has them.
- **Change it:** nothing to set.
- **Change it:** who writes off is a role holding `garage.approve` (the owner and a manager by default); who records the insurer's payments, `sales.edit` with `garage.view` (and an accountant). The depreciation schedules and the compulsory deductibles are not kept as tables: they are typed on each claim.

### The advance is the customer's money on account

- **Rule:** an advance on an open job card (one, when it is opened or later) is a numbered collection receipt in the customer's name, by cash, UPI, card or bank, and never more than the job's total once there is an estimate. It pays first when the job is billed. On a cancelled job card it stays the customer's: it is handed back from the job card (all that is left, or part, by cash, UPI or bank, with a reason and a manager's PIN), or it stays on their account for a later bill. The cash limit counts it like any collection.
- **Why:** until the job is billed the money is the customer's; money leaving the drawer needs a second person's say-so.
- **Change it:** who may take an advance is a role holding `garage.view`, `garage.edit` and `sales.edit` (the owner, a manager and a cashier by default); who may approve handing it back, `sales.refund`.

### The next service, and who is due

- **Rule:** billing a job sets the vehicle's next service: by date, the garage's months after the bill, and by reading, its kilometres after the reading out (or in), to start with; or the day and reading typed (a day after today within five years, a reading above the vehicle's), or none. A job card with nothing on it, delivered with no bill, leaves the vehicle's next service as it was. *Service due* holds every vehicle in use whose next service falls within 7 days, by its date or by the day its kilometres a day will take it to the reading due, and every one whose insurance or PUC runs out within 30 days or has run out. Each reminder given (WhatsApp, a call) is kept; one in the last 30 days counts as recent.
- **Why:** a service falls due by months or by kilometres, whichever comes first; the reading is projected from the odometer log, so the reminder goes before the reading is reached.
- **Change it:** the months (1 to 36, 6 to start with) and kilometres (500 to 100,000, 5,000 to start with) in *Settings › Garage settings*, by a role that holds `settings.edit`; each job's own on its bill.

### Service plans by model or engine

- **Rule:** a service plan names a make and its model, its engine code, or both, with the kilometres (500 to 100,000) and days (30 to 1,100) to the next service, whichever comes first; one plan for each make, model and engine. When a job is billed, the plan in use that fits the vehicle sets its next service, in place of the garage's months and kilometres: the plan naming the model and the engine first, then the engine, then the model. A plan is switched off, never deleted. The day and reading typed on the bill still win.
- **Why:** makers set different intervals for different models and engines (a diesel engine at 10,000 km, a scooter at 3,000), and the reminder should follow the vehicle's own.
- **Change it:** *Service plans by model* in *Settings › Garage settings*, by a role that holds `settings.edit`.

### Mechanics' commission on labour

- **Rule:** a labour line earns commission when the job is billed: its value before GST as billed, at its labour item's rate, or else at its mechanic's own rate; with neither, none. The line's mechanic is who ticked it done, when they are on the job card; otherwise the job card's mechanics share its value equally, to the paisa. Outside work and parts earn none. What was earned is kept as worked out, with the bill line that carries the labour. When that bill line is credited (a return, or a credit by value such as an insurer's short payment written off), the commission it earned is taken back in proportion to the labour credited so far against the labour line's whole value billed, to the paisa, as an entry of its own dated the credit's day; crediting all of it takes back exactly what was earned. A short payment billed to the owner instead takes nothing back: the labour is still billed. A payout already made stays: what is taken back comes off what is due next, and what is due may go below nothing (the mechanic owes it, and nothing is paid until it is earned back). A payout is an expense of the day (the expense book, so the drawer and the day's money see it), never more than is due; a payout reversed in the expense book is due again. The report gives each mechanic's labour billed, commission earned, taken back and paid in the dates, and what is due now.
- **Why:** workshops pay mechanics a share of the labour they do; labour the customer did not pay for, in the end, earns nothing. Paying through the expense book keeps the cash right.
- **Change it:** the rates in *Settings › Garage settings* (`settings.edit`); payouts by a role holding `garage.approve` and `expenses.create`; the report needs `reports.view`. Commission earned before bill lines were kept with it (`garage_commissions.document_line_id`) is not taken back.

### A service booking or a quotation becomes a job card

- **Rule:** a job card may be opened from a service booking that is booked, on today or a day before (within the last week on the list), for the job card's customer or the vehicle's owner, and not already on a job card: the booking is marked done and the job card names it. An open quotation of the customer's (or the vehicle owner's), still valid and priced in the same terms, becomes the estimate of a job card with none yet, at the quotation's prices (each line's value for one unit): parts as parts and services as labour, as a new version from the quotation; the quotation is then closed, naming the job card, and is never billed on its own.
- **Why:** the vehicle that comes in for its booking, or for the work quoted, starts its job card with what was agreed, and is never billed twice.
- **Change it:** nothing to set; the bookings need *Appointments* on, and the quotations *Quotations*.

## Gyms, studios & coaching

A gym, a studio or a coaching centre sells its plans as services on bills of the shared core ([Shops and the shared core](#shops-and-the-shared-core)); with *Plans & memberships* on it also keeps each member's memberships, checks members in at the desk and splits fees into instalments. Each rule below is checked by the server, and the ones about records that must not change are held by the database too.

### A plan is its own service item, and its GST is the item's

- **Rule:** a plan is sold as a service item of the catalogue, its own (no other plan's, and never a joining fee), made with the plan from the price, GST slab and SAC typed, or an existing service chosen. A joining fee is another service item. The bill takes each line's GST from its item's slab. A plan keeps its item for good (its price changes on the item) and is switched off, never deleted.
- **Why:** from 22 September 2025, the services of a gym, health club, fitness centre or yoga centre (SAC group 99972) are at 5% without input tax credit, and the 5% is mandatory: CBIC says the provider cannot charge 18% with credit instead. Coaching and tuition (999293) and dance, music and art classes (999291) stay at 18%. A studio selling both bills each plan under its own slab.
- **Change it:** each plan's slab and SAC on the plan (*Settings › Membership plans*) or on its item; have an accountant confirm them.

### A membership keeps its terms as sold

- **Rule:** a membership keeps, from the day it is sold: the plan's name and kind, its days or months and sessions, the price as billed (the plan's line: its taxable value, GST and rate), the joining fee billed with it, the refund policy's version, the freezes and days it may be frozen, its grace days and whether it can be passed on, and the plan's options: its visits, branches and hours, seats, classes, whether it is personal training, its freeze and transfer fees, a freeze's notice, the late fee on an instalment and how much of the joining fee can come back. Its first day and its last day as sold never change, but for a renewal not yet begun that moves with a freeze of the membership before it; its last day moves only by its freezes. A later change to the plan applies to memberships sold from then on. The database refuses any other change, and a membership is never deleted.
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

- **Rule:** a membership with a last day is frozen from today or a day within 60 days (and after the plan's days of notice, when it asks for notice), between its first and its last day, for at most the days and in at most the freezes its plan allowed when it was sold (both or neither); freezes of a membership never overlap. Its last day moves on by the days frozen, and a renewal that follows it end to end (not yet begun) moves on by the same days, its start and last day both; ended early or called off, the days come back and the renewal moves back. A renewal with a freeze planned of its own does not move, so the freeze is refused until that one is called off. When the member comes back early, the freeze ends that day and counts only the days up to it; a freeze ended before it began (called off) counts no days and no freeze. A frozen membership lets no one in. The plan's freeze fee is billed with each freeze (see [Fees on a membership are bills of the core](#fees-on-a-membership-are-bills-of-the-core)). Freezes are never deleted.
- **Why:** a member away for a while keeps the days they paid for, within what the plan promised; a renewal already sold keeps following on without a gap or an overlap. Notice lets the gym plan its batches.
- **Change it:** the freezes, days, fee and days of notice on the plan; who freezes is the role's `member_plans.edit` (the owner, a manager and a cashier by default).

### Who is let in at the desk

- **Rule:** a member is found by their code (typed or scanned from the QR on their slip) or by a search, and let in on a membership of theirs (or a seat of a shared one) that runs that day: started, not closed, not frozen, within its last day or its grace days after it, with a session left on a pack, at a branch and an hour its plan allows, and within its visits. Otherwise they are turned away with the reason: no membership, not started yet, over (grace days past), frozen, no sessions left, another branch, outside its hours, visits used up, or fees overdue. A pack loses one session a day: a second visit the same day uses none, and a day with a class booked on it uses none at the desk (the class takes it). The membership used is the one asked for, else one by time before a pack (no session is used then), the pack ending first before the others. Every check-in is kept, let in or not, on the business's date and time, and never changed; the database itself refuses one let in against these rules.
- **Why:** the desk knows at once whether to let a member in and why not; the record shows who came, when and on what.
- **Change it:** the grace days on the plan; who checks members in is the role's `member_plans.create` (the owner, a manager, a cashier and a trainer by default).

### Fees overdue turn a member away

- **Rule:** a member whose fees are overdue by more than the business's days is turned away at check-in, even with a membership running: a bill past its due day, or for a fee in instalments an instalment past its own, not yet paid. The desk sees how much; a trainer does not.
- **Why:** a member with fees long unpaid is asked to pay before training on.
- **Change it:** *Fees overdue at check-in* in *Settings › Membership plans* (7 days to start with; 0 to 365, or *Never turn a member away for fees*), by a role that holds `settings.edit`.

### What a cancellation gives back

- **Rule:** a running membership is cancelled with a reason. Its days used are counted from its first day to the day of cancelling, both counted, less the days frozen (none when it has not begun); a pack's are its sessions used. What may come back is the part not used of the price as billed: the days left over the days sold, the sessions left over the sessions sold, or for sessions within a time the smaller of the two, worked out to the paisa (halves up). Less may be given back. The joining fee may come back too, up to the plan's share of it as sold (its percentage, to the paisa), or a part of that share; a plan whose share is 0% keeps it. What comes back is a credit note on the membership's bill (its GST in the line's own proportion, adding up exactly); what the member paid beyond what is then due on the bill is refunded by cash, UPI, card or bank, on the day or on a later day within 90 (a refund due: it stays on the bell and the refunds-due list until it is paid through the core's refund), and what they had not paid is simply owed less. Anything given back needs `member_plans.refund` and a manager's approval with their PIN (`member_plans.approve`; their own PIN when they cancel it themselves). A membership passed on by another member, one brought in from another system, or a trial pass gives nothing back: it has no bill of its own here. The bill lines that sold a membership come back only on its own credit note: the database refuses a return of them made any other way.
- **Why:** the member pays for what they used; the coaching-centre guidelines (2024, as reported) ask for a pro-rata refund within 10 days when a student leaves midway, so a refund paid later carries its day and stays in sight until paid. Money leaving the drawer needs a second person's say-so. Many gyms keep the joining fee, or part of it: the plan's share says how much, and is on the slip.
- **Change it:** who cancels is the role's `member_plans.cancel`, who gives back `member_plans.refund`, and who approves `member_plans.approve` (the owner and a manager by default).

### A change of plan's credit pays the new bill first

- **Rule:** a running membership moves to another plan from today, dearer or cheaper; its last day counted is yesterday (the day before its first day when it has not begun). The part not used, worked out as for a cancellation, comes back as a credit note on its bill, and what the member paid beyond what is now due on it pays the new plan's bill first: a refund by credit note on the old bill and a payment by credit note on the new one, so no money moves. On a cheaper plan the credit pays the whole new bill and what is left over either stays with the member as credit on the credit note, or goes back to them, now or on a later day (a refund due), with `member_plans.refund` and a manager's approval with their PIN. A membership passed on by another member, brought in from another system or a trial pass is not moved: the new plan is sold instead.
- **Why:** the member keeps the value of what they did not use, to the paisa, and the bills add up to what they paid; a move down is no longer a cancellation and a new sale.
- **Change it:** who moves a plan is a role holding `member_plans.edit` and `sales.create` (the owner, a manager and a cashier by default); who gives money back as for a cancellation.

### A membership passed on keeps its bill

- **Rule:** a membership is passed on to another member only when its plan allows it, it is not frozen and has no freeze to come, nothing is left to pay on its bill, and it is a single member's membership sold here (a shared one changes its seats instead). It closes as transferred, and the other member's membership carries on from today (or its first day, when it has not begun) to its last day, with its sessions and freezes left, on the same bill and policy version. The plan's transfer fee is billed to the member passing it on. Nothing comes back from it later: the bill is the first member's.
- **Why:** the first member paid for it; what is left passes on, not the money.
- **Change it:** *Can be passed on* on the plan.

### Instalments add up to the bill

- **Rule:** a fee in instalments has 2 to 36 of them, each with its due day (the first today or later, the last within three years, each after the one before) and amount, adding up to the bill exactly; they are set with the sale, and the bill falls due on the last of them. A manager (`member_plans.approve`) may change the schedule later (due days and amounts, 2 to 36, none due before the day of the sale) without changing its total: the change is the schedule's next version, the one before is kept as it was, and the change is audited with its reason. The bill's own due day stays as sold. Payments on the bill, less refunds, cover the instalments in force in order; one past its day not fully covered is overdue. A cancelled or upgraded membership's instalments no longer fall due.
- **Why:** a coaching fee paid in parts has its days agreed at enrolment, and each payment is a numbered receipt; a family that needs another schedule gets one without the fee changing (the coaching-centre guidelines ask that a course's fee is not raised while it runs).
- **Change it:** who changes a schedule is the role's `member_plans.approve`.

### An overdue instalment's late fee is the plan's, told at the sale

- **Rule:** a plan may carry a late fee on an instalment overdue by more than some days. The sale's figures show it before the bill is posted, and the membership keeps it as sold. When an instalment is overdue by more than those days, the desk confirms the late fee and it is billed as a service at the plan's slab (see [Fees on a membership are bills of the core](#fees-on-a-membership-are-bills-of-the-core)); once per instalment.
- **Why:** a late fee is fair only when the member was told of it beforehand; billing it only when someone confirms it leaves room for a word with the member first.
- **Change it:** *Late fee on an instalment* and *Days overdue before the late fee* on the plan; who bills it is the role's `member_plans.edit` with `sales.create`.

### A plan's item is sold only with its membership

- **Rule:** a bill with a plan's item is posted only by Members & plans, which writes the membership with it; the core refuses that item on any other bill of the business while the tool is on.
- **Why:** every plan sold has its membership, so the desk, the renewals and the dues agree with the bills.
- **Change it:** nothing to set.

### A trainer sees no money

- **Rule:** the Trainer sees members, their plans and check-ins, checks members in, books members into classes and marks their attendance, and sees personal-training sessions and marks them done or missed. Memberships show without prices, bills, fees or dues to anyone whose role does not hold `sales.view`, and the fees due and refunds due lists are for those who do. Selling a membership also needs `sales.create`. Trainers' pay is for `member_plans.manage`.
- **Why:** the floor staff train members; the money is the desk's and the manager's.
- **Change it:** *Roles & permissions*.

### A plan's visits, branches and hours

- **Rule:** a plan may allow so many visits a day, a week, a month or in all (each check-in let in is a visit, counted for each member on their own); a week runs Monday to Sunday and a month from its first day, on the business's calendar. It may let a member in only at some branches, and only between two times of day on the business's clock. A check-in outside them is turned away with the reason, and a class outside them is not booked.
- **Why:** off-peak plans, three-days-a-week plans and single-branch plans are sold cheaper; the desk sees at once why a member is turned away.
- **Change it:** *Visits allowed*, *Let in from* and *until*, and the branches on the plan (*Settings › Membership plans*).

### Seats of a shared membership

- **Rule:** a plan may have seats: 2 for a couple, more for a family or a company. The member who holds the membership pays; the members given its seats (the holder takes the first unless the seats name others) each get a member code and check in on their own, with their own visits. A seat is given up, never deleted, and a membership never has more members using it than its seats. A shared membership is not passed on.
- **Why:** a couple or a family pays once, and each person's visits are their own record.
- **Change it:** *Seats* on the plan; who changes seats is the role's `member_plans.edit`.

### Add-ons end with the membership

- **Rule:** an add-on (a locker with its number, a towel, a diet plan, a personal-training pack or another service item that is not a plan's own item or joining fee) is sold with a membership on its bill, or after it on a bill of its own. It ends with the membership: its last day as frozen days move it, or the day it is closed. A locker number is held by one running membership at a time.
- **Why:** a locker is given back when the membership ends, and two members never share one.
- **Change it:** nothing to set.

### Fees on a membership are bills of the core

- **Rule:** a freeze fee, a transfer fee, an instalment's late fee and a class's late-cancel or no-show fee are each billed to the member on a bill of their own, through the core, on the plan's own service item with the fee's words on the line: a service at the plan's slab and SAC. The fee is typed as the business's prices are (with or without GST, as its settings say); what is not paid at once stays on the member's dues. A trial pass takes no freeze fee.
- **Why:** a fee is a supply of the same service, so it takes the plan's rate; a bill of the core keeps GST, the dues and the day's money right.
- **Change it:** the fees on the plan; the penalty fee in *Settings › Membership plans*.

### Classes: places, the waitlist and penalties

- **Rule:** a class on the timetable is made for each of its weekdays on the business's calendar, up to four weeks ahead, with the terms of its timetable entry then (room, instructor, places, booking window, cut-off, waitlist); a change to the entry makes again the classes to come that nobody has booked. A member books a class from when its booking window opens until it begins, on a membership that runs that day, books that class, lets them in at its branch and hour, is not frozen, and on a pack has a session left beyond those already booked on it. A class never holds more than its places, and its waitlist never more than its size: two asking for the last place at once are one in and one waitlisted, as the class is locked first. A place that frees before the class begins promotes the first on the waitlist. A cancel before the cut-off is free; after it (until the class begins) it is a late cancel, and once the class has begun a booking is marked attended or a no-show. A late cancel and a no-show take the shop's penalty: none, a session off the pack (while one is left), or the penalty fee. A pack loses a session for each class attended. Attendance is marked on the class list, or at check-in for a class starting within the hour or begun up to half an hour before. A class called off cancels its bookings without a penalty. A booking is never deleted and moves only forward.
- **Why:** studios fill their classes and keep places for those who come; no norm for windows and penalties was found for Indian studios, so they are the shop's own.
- **Change it:** each class's places, window, cut-off and waitlist on the timetable (*Check-in › Classes*, Timetable); the penalties and the penalty fee in *Settings › Membership plans*.

### Trainers' pay and commission

- **Rule:** a trainer (of Trainers & studios) earns, by the rate in force for the month: a fixed sum, an amount per class taken (a class of theirs not called off with someone attending), an amount per personal-training session given (an appointment of theirs marked done), and a share of the personal-training plans and of the other plans sold for them. A salesperson earns a share of the plans they sold. A plan's value is its line before GST, less what was credited back on it; memberships brought in, trial passes and memberships passed on are never sales. Shares are worked out to the paisa (halves up). A month is paid once per person through the expense book (as wages), with its figures kept; a payout is undone by reversing its expense.
- **Why:** gyms pay trainers a mix of a fixed sum, per class or session, and a share of what they sell; the rates differ by gym, so they are the shop's own. Paying through the expense book keeps the drawer and the day's money right.
- **Change it:** the rates in *Reports › Trainer pay* (a new rate from a month replaces the one before; rates are kept as written), by `member_plans.manage` (the owner and a manager by default); paying also needs `expenses.create`.

### Memberships brought in from another system

- **Rule:** a membership running in another system is entered with its first day (today or before), its last day (today or later) or the sessions left, and what was paid there. No bill is made: it is marked as brought in, audited, never counted as a sale or in anyone's commission, and gives nothing back on a cancellation. It checks in, freezes and renews like any other.
- **Why:** a gym moving to this system keeps its running members without billing them again.
- **Change it:** who brings one in is the role's `member_plans.edit`.

### Enquiries and trial passes

- **Rule:** an enquiry keeps who asked, how they came, what they want and the day to follow up; the follow-up list is the open enquiries due today or before. A trial pass of 1 to 30 days (and as many visits, if given) checks in like a membership of its plan, has no bill and never asks for a mandate or a card; it is one per person (someone who has held a membership or a trial gets none). A membership sold from the enquiry closes it as the member they became, for the same person; the trial never counts as their first membership, so the joining fee comes with it.
- **Why:** a free trial is how gyms win members; the CCPA's 2023 guidelines on dark patterns forbid forcing a payment mandate on a free trial, and cancellation stays plain.
- **Change it:** nothing to set.

### Students' details, guardians and results

- **Rule:** a member's date of birth (the age shown, the birthday list) and a student's school and class are kept on their page; a student may have up to six guardians, each with a phone and whether they agreed to messages on WhatsApp (a guardian who agreed gives a phone); test results keep the test, its day (today or before), the marks out of what (never more) and remarks, shown in order as the student's progress. These are personal data: an erasure blanks them.
- **Why:** a coaching centre talks to the parents, and a student's progress is the centre's report to them.
- **Change it:** nothing to set.

### Reminders are lists with messages ready

- **Rule:** the renewal calls are joined by birthdays in the next seven days, packs with few sessions left (as few as the business's setting, 2 to start with) and memberships in their grace days, each with a WhatsApp message ready; a birthday wish needs the member's consent to offers, the others their consent to reminders. Each reminder given is kept. No message is sent by itself.
- **Why:** the desk calls the members who need a word, and only with their consent.
- **Change it:** *Sessions left that count as running low* in *Settings › Membership plans*.

### The member signs the refund policy

- **Rule:** besides the printed slip, the member (or a member using a seat) may sign on the screen to accept the refund policy of their membership as sold; the signature is kept privately with the policy's version and never changed.
- **Why:** an acceptance kept with the version signed is the business's answer if the terms are disputed.
- **Change it:** nothing to set.

## Laundry & dry cleaning

A laundry or dry cleaner bills its services on bills of the shared core ([Shops and the shared core](#shops-and-the-shared-core)); with *Garment orders* on it also takes garments in on orders with a tag on each, moves them through the work to the racks, hands them over with their bills, keeps the orders not collected and settles damage claims. Each rule below is checked by the server, and the ones about records that must not change are held by the database too. Every day the rules count (today, overdue, the promised day, days ready) is the business's own date, in its time zone.

### A service is a service item, and its GST is the item's

- **Rule:** each service on the price list is billed as a service item of the catalogue (never goods or a kit): an existing one chosen, or one made with the service from the name, GST slab and SAC typed (its own price stays nil: the price list prices it by garment). The bill takes each line's name, GST slab and SAC from the item. A service keeps its item for good and is switched off, never deleted.
- **Why:** laundry, dry cleaning, pressing and dyeing are in SAC group 99971 (dry cleaning 999712), at 18% with input tax credit, unchanged since GST began; the cut to 5% without credit from 22 September 2025 is for group 99972 (beauty and physical well-being), not for laundry. The price list warns about a service at another slab.
- **Change it:** each service's slab and SAC on its item (*Services & items*); have an accountant confirm them.

### A garment's price, and the express surcharge

- **Rule:** a garment kind is counted as a piece, a pair (two pieces) or a set of 2 to 20 pieces, and its name is used once (whatever the capitals). A garment and a service have one price, above nil: for each one (as the garment is counted) or by the kilo. A garment is priced at its price times how many (whole), or its price a kilo times the kilos (to three places), rounded to the paisa, halves up. An express order adds the business's express surcharge to every garment: that percentage of its price, rounded to the paisa, halves up. GST goes on each garment's price (prices before GST) or comes out of it (prices including GST), as on any bill; the order's total rounds to the rupee when the business rounds its bills. An order keeps every garment's price, surcharge and GST as taken in, and the express percentage as it was then; a later change to the price list applies to orders taken in after it. Every price change, and a price taken off the list, is in the activity log. A garment kind is switched off, never deleted.
- **Why:** the customer agreed the price at the counter, and the receipt shows it; a weighed bundle is priced exactly by its weight.
- **Change it:** the prices and the express surcharge (0 to 200%, none to start with) on *Services & items › Price list*; the surcharge by a role that holds `settings.edit`, the prices by one that holds `catalog.edit`.

### One tag, one garment in the shop

- **Rule:** every garment (or several of a kind under one tag, or a bundle by the kilo) has a tag: the next number of the business's own count, or one typed (capital letters, digits, `/` and `-`, up to 20, starting with a letter or a digit). No two garments in the shop (received, in process or ready) hold the same tag; a tag is free again once its garment is delivered or cancelled. A garment is re-tagged only while it is in the shop, or when a delivered one is taken back in for reprocessing. Each piece gets its own tag label.
- **Why:** the tag finds the garment on the racks and at the handover; numbers reused only once the garment has left keep every tag in the shop unique.
- **Change it:** nothing to set.

### What was noted at intake stays on the garment

- **Rule:** at intake a garment may have its defects (stain, tear, hole, missing button, colour bleed, fading, shrinkage, burn mark, worn, loose threads) and a note on them, the customer's instructions, what the customer was told about the risk to it, whether they acknowledged it (only when something is noted), and a value they declared. All of it, and the garment, service and price, is kept as taken in: the database refuses any change but a manager's change before the work starts (below), and a garment is never deleted. The acknowledgement records what the customer was told; it never limits a claim, and nothing here caps what a claim may be.
- **Why:** consumer commissions hold a laundry liable for its own negligence even when its receipt says it takes no responsibility, and claims turn on proof: what was noted and acknowledged at intake is that proof.
- **Change it:** nothing to set; the shop's own terms on *Services & items › Price list* print on every receipt.

### A garment's steps, and the order's status

- **Rule:** a garment goes from received into the work (in process), to its quality check and packed (when the shop asks for them, below), and to ready on a rack, or straight from received to ready (a quick press); a packed or ready one goes back into the work only with the reason, or a ready one is handed over. A garment in the shop is cancelled with a reason. A delivered garment comes back only for reprocessing under a damage claim decided at that moment. The database refuses any other move, and a cancelled garment never changes. The order's status is worked out from its garments: received, in process, partly ready, ready to collect, partly delivered, delivered (nothing left in the shop), or cancelled (every garment cancelled). An order is late when its promised day has passed with garments not ready. Garments go on an order when it is taken in, or are added to it while it has garments in the shop (below). An order keeps its number, customer, rules, discount and terms; its promised day (not one that has passed, within 90 days) and notes change, and its figures follow its garments when one is added, changed or cancelled. Every step is kept in the history, with who made it, and never changed.
- **Why:** the board shows where every garment is, and the history who did what.
- **Change it:** who moves garments is the role's `laundry.edit` (the owner, a manager, a cashier and a stock keeper by default); who cancels, `laundry.cancel` (the owner and a manager).

### Billed at intake or at delivery

- **Rule:** an order is billed as the business's rule says when it is taken in, and keeps that rule. Billed at delivery: nothing is billed at intake; an advance may be taken, a numbered collection receipt in the customer's name, at most the order's total; each handover posts a bill through the core, one line a garment at the price taken in with GST at its service item's rate of the day, and the advance pays it first. Billed at intake: the bill is posted with the order, one line a garment, paid then or later. Each bill line names the service, the garment (with the kilos and pieces of a bundle), express when it carried the surcharge, and the tag. A garment is delivered only with its bill line.
- **Why:** most shops bill when the customer collects, against the advance taken; some bill at the counter. GST is worked out at the rate of the day of the invoice.
- **Change it:** *Billed* in the order settings (*Services & items › Price list*; at delivery to start with), by a role that holds `settings.edit`.

### Garments are held until paid

- **Rule:** a handover is refused while money is owed as the order's rule says: the whole order (what is due on all its bills, after this handover's bill and payment) or, when each handover pays for its own, the garments handed over. A customer with an account with the shop (credit days or a credit limit on their customer record) may take them with money still owed, on the account; the handover records it. Someone else may collect them, named on the handover.
- **Why:** a bailee who has done work on goods (labour or skill) may keep them until paid, unless agreed otherwise (Indian Contract Act, section 170); credit agreed with the customer sets that aside.
- **Change it:** *Part of an order handed over* in the order settings (the whole order to start with); the customer's credit days and credit limit on their record.

### Cancelling gives a credit note, and money back with a PIN

- **Rule:** cancelling garments still in the shop needs a reason. A garment not billed is simply cancelled. A billed one is credited in full: one credit note on each bill (its GST in the line's own proportion), and what the customer paid beyond what is then due on the bill is refunded only when asked, with `laundry.refund` and a manager's PIN; otherwise it stays to their credit on the bill. A garment with a damage claim waiting, or one already credited on a claim, is not cancelled. An advance on an order billed at delivery is handed back from the order (all that is left or part, by cash, UPI or bank, with a reason and a manager's PIN for `sales.refund`) only once nothing is left on it to bill; otherwise it pays the next bill. A bill line that charges a garment is credited only from its order: the database refuses a credit note on it made any other way.
- **Why:** the bill, the order and the garments agree; money leaving the drawer needs a second person's say-so.
- **Change it:** who cancels is the role's `laundry.cancel`, who gives money back `laundry.refund`, and who approves handing an advance back `sales.refund` (the owner and a manager by default).

### Damage claims are decided once, within the garment's charge

- **Rule:** a claim is recorded on a garment of the order that is not cancelled: what is wrong, what the customer says and an amount they ask for. It keeps when it was reported (and how many days after the handover), and one claim at a time waits on a garment. A manager decides it once, and it never changes after: money back (a credit note on the garment's bill line for the amount given, and what the customer paid beyond what is then due refunded with the manager's PIN), a credit note only, reprocessing at no charge (a ready garment goes back into the work; a delivered one is taken back in under its tag or a new one), or rejected with a note why. Money back and a credit note need the garment billed, are at most its charge on the bill, and are given once. Claims are never deleted.
- **Why:** a credit note can only take back what was billed; compensation beyond the charge (the garment's value) is agreed and paid outside the bill. A customer who collects and pays without protest weakens a later claim, so the claim keeps when it was reported.
- **Change it:** who records claims is the role's `laundry.edit`; who decides them `laundry.refund` (the owner and a manager by default).

### Orders not collected are kept, not disposed of

- **Rule:** an order whose garments still in the shop are all ready, the last of them for the business's days or more, is listed as unclaimed, the longest waiting first. Each reminder sent (WhatsApp or a call) is kept, with how many. The garments stay held until paid; nothing here disposes of a garment.
- **Why:** no Indian rule was found that lets a shop dispose of garments not collected; the reminders sent are the shop's record.
- **Change it:** *Unclaimed after (days ready)* in the order settings (30 to start with; 1 to 365).

### Someone who does not see sales sees no money

- **Rule:** orders, garments, handovers and claims show without prices, totals, bills or dues to anyone whose role does not hold `sales.view` (a stock keeper pressing the garments, say), and the order's history names bills and receipts, never amounts. Taking orders in needs `laundry.create` (with `sales.create` when they are billed at intake), and taking money `sales.edit`.
- **Why:** the work is the floor's; the money is the counter's.
- **Change it:** *Roles & permissions*.

### A price of its own for a counter, a group or a customer, from a date

- **Rule:** besides the price list, a garment and service may have a price of its own for one counter (location), one group of customers or one customer, from a day (today or later) to a day or open. A garment is priced at the customer's own price in force on the business's date, else their group's, else the counter's, else the list's; one of its own counts only in the list's unit for that garment and service. A new one for the same garment, service and party ends the one in force the day before it starts; one starting on or after that day must be ended first. One is ended (a price not yet in force ends the day before it starts), never deleted or changed, and never two for the same party on the same day: the database holds it. A customer is in one group at a time; a group is switched off, never deleted. The garment keeps its price and where it came from.
- **Why:** a housing society or a hotel is quoted its own rates, a counter in a dearer area charges more, and a price agreed from a date must not change orders already taken in.
- **Change it:** *Services & items › Price list*, *Prices of their own* and *Customer groups*, by a role that holds `catalog.edit`.

### Carpets and curtains by the square foot

- **Rule:** a garment may be priced by the square foot: its length and width are typed in feet (to two places) at intake, and the area is rounded as the shop sets: to the hundredth of a square foot (halves up), to the nearest whole one, or up to the next whole one. Its price is the rate times the area, to the paisa, halves up; the bill line names its size and area.
- **Why:** carpets and curtains are charged by their size, not by the piece.
- **Change it:** *Area by the square foot, rounded* in the order settings (to the hundredth to start with).

### The promised day from the slowest garment

- **Rule:** each service may have its own days to the promised day, and for express its own (at most its ordinary days); a service without them takes the shop's. An order's promised day is suggested from its slowest garment: that many days the shop is open after the business's date, skipping the weekdays the shop is closed (never all seven). The counter may promise another day, from today to 90 days ahead.
- **Why:** a silk saree dry cleaned takes longer than a shirt pressed; a day the shop is shut does not count.
- **Change it:** *Days* on each service and *Closed each week* in the order settings (*Services & items › Price list*).

### Discounts and offers are kept as taken in

- **Rule:** a discount may be given on a garment and on the whole order (a percentage, or an amount off what the customer pays, spread over the garments by what each pays), with a reason, by a role that holds `sales.discount`; together they are at most the business's most discount on a bill (*Business settings*), the owner any. An offer of a percentage off a service's item running now (*Offers & discounts*, when switched on: its dates, days and hours, its least bill and its most a bill) comes off at intake, the best one for each garment. Each comes off the garment's price after what a package pays, and before GST; the garment keeps its offer and discount as taken in, and its bill line names them.
- **Why:** as at the counter's bills: a discount is given at the time of supply, so GST follows it, and a second person's permission keeps it honest.
- **Change it:** the most discount in *Business settings*; offers in *Offers & discounts*.

### Prepaid kilo and piece packages

- **Rule:** a package plan holds so many kilos (for bundles washed by the kilo) or pieces (for garments by the piece) of the services it covers, for so many days. It is sold as the salon sells its packages: a bill of the plan's own service item, with GST at that item's slab, and the customer's package is made with it, keeping the plan as it was then; the plan's item goes on no other bill. A garment taken in draws on a package of its customer's in force on the business's date, of its unit and covering its service: the package pays its share of the price for what it still holds, and the bill line charges the rest (a line it paid in full charges nothing). A garment cancelled gives back what it drew. When the customer buys the next package of the same unit within the plan's days of the old one's end, what was left of it is carried in as its plan says: nothing, all, or up to a quantity. A package never gives more than it holds, is cancelled only while unused (then its bill line can be credited), and its line is credited only after it is cancelled. A money wallet with bonus value is not offered.
- **Why:** customers on a monthly wash prepay; GST on a prepaid service is due when it is paid for, as with a salon's packages.
- **Change it:** *Customers › Packages*: the plans (by a role that holds `catalog.edit`; the price on the plan's item), selling one (`laundry.create` with `sales.create`), cancelling (`laundry.cancel`).

### Photos and the customer's signature

- **Rule:** a garment may be photographed at intake (while it is received) and at its quality check (while it is in the work, at QC, packed or ready), up to six at each stage, and the customer may sign on the screen at intake, once an order. Each picture (JPG, PNG or WebP, checked by its bytes, up to 5 MB) is kept privately with the order and read only by someone who sees the order; none is changed or deleted. The receipt prints how many photos were kept and that the customer signed on the screen.
- **Why:** claims turn on proof of the garment's state when it came in and when it was checked; a signature drawn at the counter sits beside the tick and the printed receipt.
- **Change it:** nothing to set.

### The quality check and packing before the rack

- **Rule:** a garment may go to its quality check after the work; there it passes (packed next when the shop packs garments, else ready on a rack) or goes back to be washed again with the reason, counted. When the shop requires a quality check, a garment is packed or ready only once it has passed one; when it requires packing, it goes on the rack only once packed. Each step keeps who made it and when; the database refuses the rest.
- **Why:** a stain missed reaches the customer; a second look before the rack catches it, and the history shows who looked.
- **Change it:** *A quality check before the rack* and *Packed before the rack* in the order settings (neither to start with); taking the steps is the role's `laundry.edit`.

### A garment changed before its work starts, and garments added

- **Rule:** while a garment is received, a manager (`laundry.cancel`) may change its service, its price (one typed in place of the list's) or its quantity, with a reason; what it was and became is kept. A billed garment's old line is credited in full on a credit note, it is billed again on a bill of its own, and what the customer paid on the old bill beyond what is due there pays the new one first, with no money moving. Garments may be added to an order with garments still in the shop, priced as at intake (the customer's prices, the order's express percentage, a package, the offers running now, a discount), each with its tag; billed at intake, on a bill of their own.
- **Why:** customers change their minds at the counter, and a second bag arrives the next day; the bills stay right without cancelling the order.
- **Change it:** who changes garments is the role's `laundry.cancel` (the owner and a manager); who adds them, `laundry.create`.

### Pieces under one tag leave one by one

- **Rule:** a garment of several pieces under one tag (three shirts, a three-piece suit, a bundle) may be handed over piece by piece: the pieces handed over are counted, and the garment is delivered with its last piece. It is billed, and paid for as the order's rule says, with its first piece; a garment with pieces handed over is not cancelled or sent back into the work.
- **Why:** a customer collects the suit's jacket for tonight and the trousers later.
- **Change it:** nothing to set.

### Claims added up

- **Rule:** the claims of a period (the days they were reported, on the business's clock) are added up by service, by the person who took the garment in (who took the order in, or added the garment), or by month: how many, waiting, and decided each way, with the compensation given (the credit notes, with their GST) and the money refunded of it.
- **Why:** a service or a counter with many claims needs a look.
- **Change it:** nothing to set; the money only for a role that holds `sales.view`.

## Jewellery & gold

A jeweller sells as every goods shop does ([Shops and the shared core](#shops-and-the-shared-core)), with prices before GST rounded to the rupee, and with *Gold rates & jewellery* on it rates its metals by purity every day. Each rule below is checked by the server, and the ones about records that must not change are held by the database too. Every day the rules count (today's rates) is the business's own date, in its time zone.

### The purities a jeweller deals in

- **Rule:** gold is rated, sold and bought at 24 carat (999 fineness), 22 carat (916), 18 carat (750) and 14 carat (585); silver at 999 and 925; platinum at 950. Fineness is the parts of pure metal in a thousand, and a purity is written as a hallmark writes it: 22K916 for gold, 925 for silver.
- **Why:** these are the purities the IBJA rates and the BIS hallmark grades in use cover; the fineness of 23, 20 and 9 carat gold was not confirmed, so they are not offered.
- **Change it:** the list is fixed (a code change).

### A rate sheet is never changed; a bill takes the latest rate of its day

- **Rule:** a manager sets a rate sheet: for each purity, the selling rate per gram (more than nil, to the paisa) and the rate per gram the shop pays for old metal of it (none: the shop does not buy it), the session (morning, evening, or one of up to eight the shop names in Jewellery settings, its name kept on the sheet; the database refuses another) and where the rates come from (the shop's own, the local association's, the IBJA rate typed in). The sheet is for the business's own date when it is set, whatever a client sends. It is never changed or deleted, and a rate goes on its sheet only when the sheet is set. For each purity the latest sheet of the day that rates it is in use, and a purity with no sheet today has no rate: bills and old gold wait for it.
- **Why:** a rate once used on a bill must never change under it; a correction stays in the record as a new sheet beside the one it corrects.
- **Change it:** who sets rates is the role's `jewellery.approve` (the owner and a manager by default); who sees them needs `jewellery.view` with `sales.view` (prices are money); the shop's own sessions on *Settings › Jewellery settings* (`settings.edit`).

### A piece is a serial-numbered unit of a jewellery item, and is sold only on the jewellery bill

- **Rule:** a jewellery item is a catalogue item of goods counted in pieces, with serial numbers, at the 3% slab (the database refuses any other). Each of its pieces is one unit in stock, its tag the unit's serial number: tagged on a unit received on a purchase with that number, or brought into stock with its tag (a stock correction with its reason: opening stock, made by our karigar, other, at its cost), never on a number the item has had in stock before. A tag is letters, digits, / and - (up to 20), one piece each. *Quick bill*, a sale and a quotation's bill refuse a jewellery item's line: its pieces are billed on the jewellery bill, priced by weight at the day's rate. A jewellery item is never deleted (its catalogue item is switched off instead).
- **Why:** a piece's price is its weight at the day's rate, never a fixed price; as a serial-numbered unit it moves through stock, transfers and counts like any other stock, by its tag.
- **Change it:** which items are jewellery items and what a new piece of each starts with, on *Pieces & tags* (`jewellery.edit`; a new catalogue item also `catalog.create`, an existing one `catalog.edit`).

### Weights to the milligram, and what is charged on a piece

- **Rule:** a piece's gross weight is above nil, its stones' (and beads' and thread's) weight is below the gross weight, and its net weight is the gross weight less the stones, to the milligram (three decimals; more are refused). Its wastage is a percentage of the net weight (0 to 100), priced at the day's rate; its making charge is per gram of net weight, a percentage of the metal's value (up to 100%), or flat for the piece. A new piece starts with its item's making charge and wastage, and a hallmarked one with the shop's hallmarking charge; each piece keeps its own. A piece not hallmarked has no hallmarking charge.
- **Why:** the customer may check the weight on the shop's scale; a jeweller prices metal by the gram, with making and wastage on top.
- **Change it:** the item's defaults on *Pieces & tags*; the shop's hallmarking charge on *Settings › Jewellery settings* (`settings.edit`).

### HUIDs and diamonds' words

- **Rule:** a HUID is 6 letters and digits, on a hallmarked piece only, and belongs to one article: no two pieces share one. A set may carry several. A HUID is never changed: it is taken off and the right one given. A man-made diamond is a *laboratory-grown diamond* (or laboratory-created): the words "lab grown", "lab created", "lab diamond" and "LGD" are refused in an item's name, a piece's words and a stone's details (the database refuses them too), and a diamond, natural or laboratory-grown, is never described as fake or artificial. A "diamond" alone is a natural diamond.
- **Why:** the BIS hallmark carries a six-character HUID for each article; IS 19469:2025 allows only "laboratory-grown diamond" and "laboratory-created diamond" for man-made diamonds and disallows the abbreviations.
- **Change it:** fixed (the law and the standard set them).

### Where a piece is, and melting

- **Rule:** a piece starts in stock. From stock it goes on approval on an approval challan, to a karigar on an issue challan, or to the hallmarking centre on a consignment, and comes back into stock only on the same (a return of the challan or a sale from it, the karigar's receipt, the consignment's return); the database refuses any other move. Out of the shop it is not sold, sent anywhere else, moved to another location by a transfer or taken out of stock by a correction. While it is in the shop (in stock or out on a challan) its words, charges, hallmark, HUIDs, stones and design code may be changed, and each change is in its history with what it was; its weights and purity change only in stock, or as it comes back from a karigar weighed again. Its item and tag never change. A manager melts a piece in stock with a reason: its unit leaves stock (a stock correction of one) and its metal (its purity, net weight and fine weight, net weight × fineness ÷ 1,000 to the milligram) joins the shop's own metal at its location. A sold, melted, split, merged or re-tagged piece keeps what it was, and a piece is never deleted.
- **Why:** a piece out of the shop must not be sold twice, and its weight is what the challan that brings it back says; melted metal is the shop's own, for melting and refining, and is never billed.
- **Change it:** who moves and changes pieces is the role's `jewellery.edit` (the owner, a manager, a cashier, a stock keeper and the karigar by default); who melts, `jewellery.approve` (the owner and a manager).

### A jewellery bill's price, to the paisa

- **Rule:** each piece is priced at the latest rate of the business's day for its purity: the metal is the net weight × the rate per gram; the wastage is the net weight × the wastage percentage × the rate (its grams are the net weight × the percentage, to the milligram); the making charge is the net weight × the charge per gram, the metal's value × its percentage, or the flat charge; then the stones' values and the hallmarking charge. Each part is rounded to the paisa once, halves up, and the piece's value is their sum. GST is 3% of it, to the paisa; the bill's total rounds to the rupee when the business rounds its bills. A piece is billed only while it is in stock at the selling location, in the books, and its item is at 3%. The bill is an ordinary sale posted at those prices (the cash limit, the PAN rule, payments, dues and returns are the core's), and keeps every piece's figures, rate and sheet as billed; the database checks each figure and refuses any other rate than the day's latest for the purity.
- **Why:** jewellery of precious metal, with its making and stones, is one supply at 3% (Notification 9/2025, heading 7113); the price a customer is quoted at the counter is the price billed.
- **Change it:** the rates on *Today's rates*; a piece's charges on *Pieces & tags*; rounding in Business settings.

### The HUID check

- **Rule:** a gold piece of 2 g or more is billed only with its BIS hallmark's HUID, unless the article is left out of the hallmarking order (Kundan, Polki or Jadau; a gold watch or fountain pen; gold thread; bullion; a medical, dental, veterinary, scientific or industrial article; semi-finished; for export), the owner marked the business exempt by its turnover, or the owner said the selling location's district is not under mandatory hallmarking. A location the owner has not said about is taken as under mandatory hallmarking. Each bill line keeps why the check let it through, and the bill keeps the rules it was billed under; the database makes the same check on every line. Silver and platinum are not checked (hallmarking them is voluntary).
- **Why:** gold jewellery and artefacts of 2 g or more sold by registered jewellers in the districts notified under the Hallmarking Order must carry the BIS hallmark with a HUID; jewellers with an annual turnover up to ₹40 lakh and the listed articles are left out (BIS).
- **Change it:** *Settings › Jewellery settings* (the districts and the turnover exemption, `settings.edit`); a piece's exemption on the piece.

### Offers on making, and a discount at the counter

- **Rule:** an offer takes a percentage (more than nil, up to 100) off the making charge of the pieces of one metal, or every metal, billed between two days of the business's clock (up to a year); its terms never change and it is switched off, never deleted. Each piece takes the best offer running on the bill's day for its metal (the largest percentage, then the oldest). A discount at the counter (with `sales.discount`, and why) comes off the pieces' making and wastage after their offers, spread over them by what each has of them; it comes off their metal's value too only where Jewellery settings allow it. It stays within the business's most discount on a bill (Business settings; the owner may give more). A gold scheme's discount comes after both. Each discount is kept on the bill's lines and printed as such; the database refuses a line that takes other figures.
- **Why:** a jeweller's bargaining is on making and wastage, not on the day's metal rate; a discount shown as such keeps the invoice's value true for GST.
- **Change it:** offers on *Settings › Jewellery settings* (`jewellery.approve`); whether a counter discount may come off the metal there (`settings.edit`); the most on a bill on *Business settings*.

### Loose stones and coins on the jewellery bill

- **Rule:** catalogue goods that are not tagged pieces (a loose diamond, a gold coin) go on the jewellery bill as lines of their own, at their catalogue price and their own GST slab (0.25% for cut and polished stones, 3% for coins), with a batch or serial number where they keep one, out of stock as on any sale; a jewellery item, an item the jeweller's own purchases are booked under, or a service is refused there.
- **Why:** a customer buying a piece and a coin gets one bill, each line at its own rate.
- **Change it:** each item's price and slab in the catalogue.

### What a jewellery bill's invoice says

- **Rule:** the invoice of a jewellery bill prints, for each article: its description (the line's words), net weight, purity in carat and fineness, its hallmarking charge, its HUID where it has one, and how its price was made; and the statement that the buyer may get the purity of the hallmarked jewellery checked at any BIS-recognised assaying and hallmarking centre, with the location's BIS registration (*Settings › Licences*) while it is in force.
- **Why:** BIS's guidelines of 2 July 2026 ask every invoice for hallmarked articles, retail or between jewellers, to show each article's description, net weight of precious metal, purity in carat and fineness and hallmarking charges, and that statement; the HUID on the invoice is voluntary.
- **Change it:** fixed (the guidelines set it).

### A piece taken back comes back into stock

- **Rule:** a jewellery bill's line is returned on the bill (*Sales history*) only back to stock: the database refuses a return that leaves the piece out of stock, and the piece comes back into stock with its history saying which credit note took it back. It is then billed again at the day's rate. A jewellery bill and its lines are never changed.
- **Why:** a piece is either in stock or sold; a piece that cannot be sold again is melted afterwards.
- **Change it:** fixed.

### Old gold is valued at the day's buy rate for its purity, to the paisa

- **Rule:** an old gold voucher is made for a customer of the shop (the seller), with the photo ID seen (its kind and number; of an Aadhaar card, only its last four digits are kept) and the seller's declaration that the metal is their own to sell. Each article (up to 30 a voucher) is tested (karatmeter (XRF), touchstone, acid test or fire assay), with the fineness found (above nil and below 1,000, to one decimal; its purity's own when none is typed), and weighed: the gross weight is above nil, the stones and dirt taken off are below it, and the net weight is the difference, to the milligram; its fine weight is the net weight × the fineness found ÷ 1,000, to the milligram. It is valued at the latest buy rate of the business's day for the purity it is valued as: the net weight × the buy rate × the fineness found ÷ that purity's fineness, less the deduction (0 to 99.99%), to the paisa, halves up. The deduction is the shop's buy-back rule: an article that is the shop's own piece (named by its tag, or by a HUID on one of its pieces) takes the own-piece deduction where the shop keeps one; outside jewellery takes its purity's deduction where the shop keeps one, else the general deduction. The piece must be one the shop sold, of the article's metal: a tag or HUID of a piece still in the shop is refused. Another deduction on a line needs a manager's approval (a role with `jewellery.approve`: their PIN when someone else asks; a manager changing it themselves gives why alone), and the line keeps the rule, its percentage, who approved and why; the change is written in the activity log in the manager's name. Up to ten photos of what came in are kept with the voucher (JPG, PNG or WebP, private). A purity with no buy rate today is not bought. The voucher's value is its lines' added up, rounded to the rupee when the business rounds its bills; the database checks every figure and the rate. Its metal joins the shop's own metal at the voucher's location when it is made.
- **Why:** old gold is tested, valued at the tested purity × the net weight × the day's buying rate less any deduction, and then paid out or set off against a new bill; the shop keeps its own metal by purity, in grams of metal and of fine metal, for melting and refining.
- **Change it:** the buy rates on *Today's rates*; the buy-back rules (the general deduction, the shop's own pieces, each purity) on *Settings › Jewellery settings* (`settings.edit` with `sales.view`); another deduction on a line with a manager's approval.

### The seller's PAN on old gold over ₹2,00,000

- **Rule:** a voucher worth more than ₹2,00,000 records the seller's PAN (typed, a PAN card's number when that is the ID seen, or the one saved with the customer; a new customer keeps the one they give), or that they have none and signed a declaration (Form 97). The database refuses such a voucher without one.
- **Why:** PAN is quoted for a sale or purchase of goods above ₹2,00,000 a transaction (the Income-tax Rules 2026, Rule 159 item 16, as drafted), the jeweller buying old gold as well as selling; Form 97 is the declaration of someone who has no PAN.
- **Change it:** fixed.

### Old gold paid out: never ₹2,00,000 or more in cash to a seller

- **Rule:** a voucher's value is paid out by UPI, bank transfer or cash, in one payout or several, never more than is left on it. A seller is not paid ₹2,00,000 or more in cash for old gold in one business day (all their vouchers) or for one voucher; the shop may keep a lower limit of its own for cash to one seller in a day. Each payout is written in the expense book at the voucher's location (category Other, "Old gold bought: OG/… from …"), so the day's money and the drawer show it; it is never reversed there. Several of one seller's vouchers (up to ten) are paid out at once, from the voucher, the customer's row in *Customers* or the day's money: each is its own payout and expense, each checked against the limits as it is paid, in the order given; when one would go past them, none is paid. The database holds the same limits.
- **Why:** a seller may not receive ₹2,00,000 or more in cash (Income-tax Act 2025, section 186, counted per person per day, per transaction or per event); UPI or a bank transfer is the better way to pay. A lower limit is the shop's own choice.
- **Change it:** the shop's own limit on *Settings › Jewellery settings* (`settings.edit` with `sales.view`); who pays out is the role's `jewellery.approve` (the owner and a manager by default).

### Old gold on the jewellery bill, and such a bill taken back

- **Rule:** old gold pays only the jewellery bills of the customer who brought it in (who becomes the bill's customer): up to five vouchers on a bill, in the order chosen, each up to what is left on it and what the bill still needs. Each is a payment by *Old gold* on the sale (a credit note: no money moves) with the voucher's number, recorded with the voucher; the money taken is the rest, and the sale keeps its full value. When such a bill is returned, money goes back on it only as far as money was paid on it (the database refuses more), and what old gold paid goes back on its voucher (*Put back*, by someone who may refund: a credit-note refund, no more than old gold paid on that bill or the bill's credit after the return), from where it is paid out or used again.
- **Why:** the old gold is how the customer pays, not a discount on the jewellery; and handing its value back in cash on a returned bill would get round the limits on cash paid out for old gold.
- **Change it:** fixed.

### Old gold's metal next: melted, kept to resell, to a refiner, a bullion dealer or a karigar

- **Rule:** each line of old gold says what becomes of its metal: with the shop's metal to melt (as it comes in), kept to resell as it is (a mark only: the metal is counted where it was), sent on a refinery challan, or issued to a karigar on an issue challan made with it. A manager marks a line to melt or to resell; it goes to a refiner, a dealer or a karigar only on a challan that names it, from the voucher's location, of a purity the challan sends, once. A refinery challan (RF/…) sends the shop's metal, one metal a challan, out of what the location holds: to a refiner (a supplier), who gives it back refined into the shop's metal (no more fine metal than went: the fine metal lost shows against it); or to a bullion dealer (a customer), who buys it on a sale bill of the fine metal sent at the rate per gram typed, at 3% GST, booked under the metal's own item without stock. A challan is closed once, never changed or deleted.
- **Why:** old gold is melted and refined, sold on to a bullion dealer, made into new jewellery or resold as it is; the shop keeps its metal by purity in grams of metal and of fine metal, and a refiner's loss is shown against what went.
- **Change it:** who marks, sends, brings back and sells is `jewellery.approve` (the owner and a manager by default); a refiner's own charges are a purchase from them.

### Cancelling old gold

- **Rule:** a voucher nothing was paid out or used on (or whose use was all put back), and none of whose metal went to a refiner, dealer or karigar, is cancelled with the reason, once; its metal then goes back out of the shop's metal. A voucher is never deleted or changed otherwise, and its lines, uses and payouts are kept as written.
- **Why:** old gold handed back to the customer leaves the shop's metal; a voucher that was paid out or used is part of the money's record.
- **Change it:** who cancels is the role's `jewellery.cancel` (the owner and a manager by default).

### Gold scheme plans: up to 11 instalments, and a discount, never interest

- **Rule:** a plan has 2 to 11 monthly instalments, a smallest monthly amount in whole rupees (at least ₹100), and a discount of 0 to 100% of one instalment given on the jewellery bill that redeems a scheme with every instalment paid, from its maturity, with its terms as printed. The word "interest" is refused in a plan's name and terms (the database refuses it too). A plan's terms never change and it is never deleted: it is switched off, and a new plan made for other terms; a plan switched off takes no one new. Each plan shows its discount as a yearly figure on the money held (the discount × 24 ÷ (n × (n + 1)) % for n instalments, maturity a month after the last).
- **Why:** a scheme's money is an advance against jewellery, and its benefit is described only as a discount; the jewellery trade federation's guidance for companies' schemes (GJF, 2014) also keeps the discount within 12% a year (shown, not refused: it was written for companies).
- **Change it:** plans on *Settings › Gold scheme plans* (`jewellery.approve`).

### A gold scheme: its terms kept, turned into jewellery within the year

- **Rule:** a customer joins an active plan with their monthly amount (in whole rupees, at least the plan's smallest), their acceptance of the terms (with the time), a nominee if they give one, and the first instalment, taken that day. The scheme keeps the plan's terms as they were. It matures the plan's instalments in months after the first instalment (one month after the last falls due) and closes by its day 364. Each instalment is the scheme's monthly amount, taken one at a time while it is active and before it matures, as a collection receipt of the customer's money by cash, UPI, card or bank transfer (not a credit note). Cash into one scheme stays under ₹2,00,000. Every date is the business's own.
- **Why:** the industry guidance is to close a scheme and bill it by day 364, so the money becomes a sale within 365 days (under the Companies (Acceptance of Deposits) Rules 2014 an advance for goods not appropriated within 365 days is a deposit, and under the BUDS Act 2019, which binds proprietors and partnerships too, an advance that becomes refundable is deemed one); a scheme's instalments pay one bill, and one bill takes less than ₹2,00,000 in cash (Income-tax Act 2025, section 186).
- **Change it:** fixed; who enrols and takes instalments is `jewellery.create` with `sales.edit` (the owner, a manager and a cashier by default).

### Redeeming a scheme, and its discount

- **Rule:** a scheme is redeemed once, on a jewellery bill of its own customer, and all that was paid into it pays that bill (each instalment's receipt, as it was paid): the bill must come to at least that. When every instalment was paid, the scheme was not stopped and the bill's day is on or after its maturity, the plan's percentage of one instalment, to the paisa, comes off the pieces before GST, spread over them by their value; otherwise there is no discount. A scheme's instalments pay no other bill, and are never paid back in money: on a returned bill, money goes back only as far as money was paid at the counter. What the scheme paid goes back onto the scheme (*Put back*, by someone who may refund: a credit-note refund, no more than the scheme paid on that bill or the bill's credit after the return) while the scheme is within its tenure (up to its day 364): the scheme is open again as it was (active or stopped), and the money put back pays the next bill that redeems it, as a payment by *Gold scheme*. Past its day 364 it stays on the returned bill as the customer's credit, used on their next jewellery bill (*Credit from returned bills*). The database holds each of these.
- **Why:** a scheme must end in a sale, with no cash returned in any event (GJF guidance); the benefit is a discount on the jewellery.
- **Change it:** fixed.

### A scheme on its day 364: billed as metal, held in the customer's safekeeping

- **Rule:** a scheme not redeemed by its day 364 (the business's date) is closed when a manager confirms it (the bell asks the shop that day and after; nothing runs by itself): all the money it holds (and its discount, when it earned one) is billed on a jewellery bill as gold, silver or platinum of the purity chosen at that day's rate, the fewest milligrams whose bill (with 3% GST, rounded as the business rounds) comes to at least the money; the few rupees the last milligram adds are due when the customer collects. The metal is set aside from the shop's metal at the location (which must hold it) and tagged as a piece of its own (under *Gold, silver or platinum held for gold schemes*, at 3%), held in the customer's safekeeping: never billed, lent, sent or melted for anyone else. The customer collects it later, paying what is still due; it is then theirs, out of the shop. A close is made once, never changed or deleted.
- **Why:** the industry guidance is to bill a scheme by day 364 so its money becomes a sale within 365 days; when the customer does not come, the shop bills the metal the money buys that day and keeps it for them.
- **Change it:** who closes is `jewellery.approve` with `sales.create`; who hands it over is `jewellery.create` with `sales.edit`.

### A company's scheme money against 25% of its net worth

- **Rule:** when the owner gives a company's net worth and the date of the balance sheet it is from (*Settings › Jewellery settings*), the money held for gold schemes not yet redeemed, at every location, shows against 25% of it, with the share used and what is left; the bell warns once it is past.
- **Why:** a company may hold advances such as scheme money within 25% of its net worth (Companies (Acceptance of Deposits) Rules 2014); a proprietor's or partnership's shop leaves it empty.
- **Change it:** the net worth and its date on *Settings › Jewellery settings* (`settings.edit` with `sales.view`).

### Stopping a scheme

- **Rule:** an active scheme is stopped (cancelled) with the reason and a manager's approval (a role with `jewellery.approve`: their PIN when someone else asks; a manager approving their own step gives the reason alone), once. A stopped scheme takes no more instalments and gives no discount; what was paid is still redeemed on a jewellery bill, by its close day. The bell warns of schemes closing within 30 days and of any past the close day.
- **Why:** earlier instalments are not refundable when a customer stops paying, and an amount that becomes refundable can turn into a deposit.
- **Change it:** who stops is `jewellery.cancel` (the owner and a manager by default).

### The cash report: ₹10 lakh in cash with a customer

- **Rule:** the cash report adds up each person's cash with the shop on the business's dates: cash paid on their bills (not through a receipt, which counts itself), their cash receipts (dues, advances, gold scheme instalments), cash refunded to them, advances handed back in cash, and cash paid out for their old gold. Customers are one person when they share a PAN, a phone number (its last ten digits) or a family group the shop sets (a customer is in one group at a time), each linked through the others; a walk-in's bill with the buyer's PAN is that PAN's. Over the rolling month to today (from the day after the same date last month; or any period of up to a year), a person whose cash in and out comes to ₹10 lakh or more is flagged, and one at or above one of the shop's own alert levels (up to five, below ₹10 lakh) is marked with the highest one reached; each shows whether a KYC document is on file. The monthly worksheet lists, for a calendar month, each person whose cash that month was above ₹10 lakh, in one transaction or several, with every cash transaction, and the 15th of the next month as its due day. Nothing is filed. The bell flags a person at ₹10 lakh, those past the shop's level, and, when the owner says the shop is a reporting entity, last month's report until the 15th.
- **Why:** a dealer in precious metals and stones carrying out cash transactions with a customer of ₹10 lakh or more, in one operation or several that appear linked, is a reporting entity under the PMLA (G.S.R. 799(E), 28 December 2020); a reporting entity keeps records of cash transactions above ₹10 lakh and of linked ones within a month adding up to more (PMLR Rule 3) and reports them to FIU-IND monthly, by the 15th of the next month. The filing itself is the shop's officer's, on FIU-IND's own system.
- **Change it:** the shop's alert levels and the reporting entity on *Settings › Jewellery settings* (`settings.edit` with `sales.view`); who sees the report and sets family groups is `jewellery.export` with `sales.view` (the owner, a manager and an accountant by default).

### Customers' KYC, kept five years

- **Rule:** a customer's KYC documents are recorded with the type (one the shop accepts, named in Jewellery settings), the number (of an Aadhaar card, only its last four digits), the name on it, the day it was seen (today or earlier) and a copy (a photo or a PDF, private); a firm's beneficial owners with their role, share and PAN. Numbers, PANs and copies show in full only to those who may see KYC (`jewellery.manage`); everyone else who sees customers sees the last four characters, and the activity log keeps them masked. A record is never changed or deleted: one entered by mistake is set aside with why. It is kept at least five years after the customer's last transaction, whatever an erasure of their personal data does.
- **Why:** a dealer in precious metals that is a reporting entity keeps its customers' identity records for five years after the business relationship ends (PMLA section 12); a customer's documents are personal data, seen only by those who need them.
- **Change it:** the documents the shop accepts on *Settings › Jewellery settings*; who records is `jewellery.create` with `contacts.view`; who sees in full and sets aside is `jewellery.manage` (the owner and a manager by default).

### The suspicious transaction log

- **Rule:** a case is opened for a transaction the shop finds suspicious, whatever its amount: who (a customer, or a name as known), what was seen, the transactions it concerns, notes as it is looked into, and the decision once: reported to FIU-IND (on a day up to today, with the acknowledgement) or not reported, with why. The platform files nothing. The log is seen only by those who keep it (`jewellery.review`, the owner's alone until the owner gives it); it is never shown at the counter, in the bell, in the activity log or in a customer's copy of their personal data, and an erasure neither names nor touches it. Each case keeps its own history: who opened, read, noted and decided it, and when. A case is never deleted or changed otherwise.
- **Why:** a reporting entity reports suspicious transactions to FIU-IND (PMLR Rule 3) and must not tell the customer (tipping off); the record of the decision is kept.
- **Change it:** who keeps the log is the role's `jewellery.review` (*Settings › Roles*).

### The karigar and anyone who does not see sales see no prices

- **Rule:** pieces and items show without making charges, wastage, hallmarking charges, stone values, cost or price to anyone whose role does not hold `sales.view` (a stock keeper, the karigar), and a piece they tag takes its item's making charge and wastage and the shop's hallmarking charge; a stone they change keeps its value. Bringing a new piece into stock needs `inventory.edit` too (the karigar tags units already in stock). Old gold, its values and its payouts, and gold schemes, need `sales.view` too.
- **Why:** the work is the floor's; the prices are the counter's.
- **Change it:** *Roles & permissions*.

### A karigar's challans, receipts and metal in fine weight

- **Rule:** a karigar is one of the shop's suppliers, made a karigar by a manager with the wastage allowed on the pieces they make (0 to 25%). An issue challan (KI/…) takes metal out of the shop's own metal at a location, at its purity's fineness unless another is typed, never below nothing; pieces to repair go out of stock to the karigar; stones go too. A receipt (KR/…) answers a challan of the same karigar or their running account: a piece made is tagged into stock at the receipt's location with its own weights, at its labour's cost; a piece repaired comes back from the karigar it was sent to, weighed again, its weight as sent and as back kept; scrap and metal go into the shop's metal. Every gram is kept in fine weight (net × fineness ÷ 1,000, to the milligram) in the fine-weight book, written by the database: the karigar holds what was issued, less the pieces made, the scrap and metal back, the change in the repaired pieces' weight and the wastage allowed. Challans, receipts and their lines are never changed or deleted.
- **Why:** metal handed to a karigar is the shop's until it comes back as pieces or scrap; fine weight is how the trade counts it whatever the purity.
- **Change it:** `jewellery.approve` makes karigars and sets their wastage and rates (with `purchasing.view`); `jewellery.edit` makes challans and receipts (a piece made needs `inventory.edit` too).

### The wastage allowed, against the actual

- **Rule:** on each piece made, the karigar is allowed their percentage of its net weight and of its fine weight (to the milligram), written off their account as it comes in. What they still hold after the work is the rest of the actual wastage; a manager writes off all they hold of a purity, with the reason. A karigar's account shows, by purity, what was issued, back in pieces and as scrap, the repairs, the wastage allowed, what was written off and what is held, and the actual wastage: the wastage allowed, what was written off and what is still held.
- **Why:** the agreed wastage is the karigar's due; anything beyond it is a loss the shop sees and decides on.
- **Change it:** the wastage on the karigar (*Karigar work*); writing off is `jewellery.approve`.

### A karigar's labour invoice

- **Rule:** the labour on a receipt's line is the karigar's rate for the item (per gram of net weight or per piece) unless someone who sees costs types another; a repair's labour is typed. The labour not invoiced yet is posted as one purchase from the karigar (a service bought: no stock), each line at 5% GST for jewellery work and 1.5% for diamond work when the karigar has a GSTIN, and at no GST when they have none; a line is invoiced once. The database checks each line's rate against the karigar's GSTIN and the work.
- **Why:** job work on another's goods of Chapter 71 is 5% (and was not changed in September 2025), on diamonds 1.5%; a karigar not registered for GST charges none.
- **Change it:** `jewellery.edit` with `purchasing.create` posts it; the slab is the law's.

### The ITC-04 data

- **Rule:** for any period of up to a year, the goods sent to job workers (table 4: each challan's lines, with their weight, fine weight and value) and received back (table 5A: each receipt's lines with the original challan, and the wastage allowed) are listed from the challans and receipts, to download. Nothing is filed.
- **Why:** a principal sending goods to a job worker on a challan reports them on ITC-04; how often it is filed was not checked, so the shop files it from this data.
- **Change it:** `jewellery.export` (the owner, a manager and an accountant).

### A custom order's path and its advances

- **Rule:** an order (CO/…) is booked for a customer, its metal and purity fixed; it goes booked → issued to a karigar → received → at the hallmarking centre → hallmarked → ready → delivered, or is cancelled (never while it is at the centre, nor once delivered). Its pieces are those the karigar makes for it and those in stock made its own, of its purity (a piece made on its challan after it was cancelled, or of another purity, is the shop's own); while it is open they are billed only on its own bill (the database refuses another bill's line). Its advances are core collection receipts (money) or the customer's old gold vouchers with all their value; while it is open they pay only its own bill (the database refuses another bill, a refund of the receipt, a payout or another use of the voucher, and *Apply advance* leaves them out). Cancelled, they are the customer's again. It is delivered on a jewellery bill made with it, which takes its pieces and its customer; its receipts pay first as far as the bill needs them, then its old gold, and what is left stays the customer's.
- **Why:** an advance is given for the order, and must not pay another bill or go back while the piece is being made.
- **Change it:** `jewellery.create` with `sales.edit` books and takes advances; `jewellery.cancel` cancels.

### The rate fixed on an advance (bhav cut)

- **Rule:** an advance may fix the order's rate once: the latest selling rate of the business's day for the order's purity, for the grams the advance buys (the advance ÷ the rate, to the milligram, rounded down), kept on the order with its rate sheet. The order's bill prices those grams at the fixed rate and the rest of its pieces' net weight at the day's rate, in the bill's order of pieces; the database checks each line's grams and rate.
- **Why:** a customer who pays ahead takes the day's rate for what they paid, and the shop knows what it owes in metal.
- **Change it:** *Fix the rate on it* when taking the advance; a rate fixed is never changed.

### An approval (jangad) challan

- **Rule:** pieces in stock at a location go on an approval challan (AP/…) to a customer or another jeweller, due back on a day not before today. Out on approval they are never billed to anyone else; they come back in part or all on a return of the challan, or are sold from it on a jewellery bill to its customer, which closes each one with the sale. The challan shows the days out, and one with pieces out past its day is listed and in the bell; no time limit is enforced.
- **Why:** goods sent on approval stay the sender's until they are taken; the GST time limit for them was not checked, so the days out are shown and nothing is refused for it.
- **Change it:** `jewellery.edit` (with `sales.view`) sends and takes back.

### Hallmarking consignments, and old-mark stock

- **Rule:** gold and silver pieces in stock go to an assaying and hallmarking centre (a supplier) on a consignment (HM/…); a custom order with a piece there is at the centre. A consignment comes back once, every piece hallmarked with its HUIDs (a HUID belongs to one article) or rejected, with each piece's charge (the shop's hallmarking charge unless typed): the charges are posted as a purchase from the centre at the GST on its bill (18% or none), and a hallmarked piece takes its charge, recovered on its bill. A piece with the old hallmark (from before HUIDs) waits to be re-hallmarked: where a HUID is needed it is not billed (and the database refuses its line) until it comes back hallmarked with one; it carries no HUID while it waits.
- **Why:** hallmarking charges are a cost the shop recovers on the sale (BIS asks the invoice to show them); old-mark stock cannot be sold where a HUID is mandatory.
- **Change it:** `jewellery.edit` sends and brings back (with `purchasing.create` to post the charges).

### The HUID list for Manak Online

- **Rule:** every HUID the shop's pieces carry is listed with its piece and its status (in stock, sold to a consumer, sold to a jeweller — a buyer with a GSTIN, returned by the customer, melted) and since when, to download. Nothing is uploaded.
- **Why:** Manak Online's HUID Transfer module takes these statuses; its file format was not checked, so the list is plain.
- **Change it:** `jewellery.export`.

### Splitting, merging and new tags keep the metal and the cost

- **Rule:** a piece in stock is split into 2 to 10 pieces whose gross and stone weights come to its own, each of its HUIDs and stone lines going with one of them, its cost (and a flat making charge) shared by net weight to the paisa's hundredth; 2 to 10 pieces of one metal and purity at one location are merged into one with their weights, HUIDs, stones and cost added up; a piece is given a new tag with everything it had. Each goes through the core's stock (each unit out with its reason, each new one in at the cost), keeps a custom order it was made for, and is checked by the database when the transaction ends: one purity, the same gross and stone weight, the same cost. The old pieces keep their history and links.
- **Why:** reshaping stock must never make or lose metal or value.
- **Change it:** `jewellery.edit` with `inventory.edit`.

### A piece's photo, and a custom order's design

- **Rule:** a photo (JPG, PNG or WebP, up to 5 MB, its bytes checked) is kept in the private uploads, read only through the API by someone who sees the pieces; a piece has one photo and an order one design, a new one taking the old one's place (the old one is kept). A piece given a new tag keeps its photo. Old gold keeps up to ten photos (opened by those who see its money), and a KYC document one copy, a photo or a PDF (opened by those who may see KYC).
- **Why:** a photo shows the piece without handing it round; a design shows the karigar what to make.
- **Change it:** `jewellery.edit` for a piece's photo, `jewellery.create` for an order's design.

### The fine-weight book, and a count against it

- **Rule:** the database writes every change to the metal of each purity, wherever it is (pieces in stock, on approval, at karigars and at the centre; the shop's own metal; metal with karigars; metal with refiners and dealers; customers' metal in safekeeping), as pieces and metal move, so the book for any period reads: what it held at the start, each movement that changed the total (pieces tagged in, sold, taken back, old gold, metal with suppliers, the karigars' wastage allowed and written off, weights corrected), the moves inside the shop that leave it as it was (to karigars and back, pieces made, repairs, moves, melting, splits, merges and new tags), what it holds at the end and where. A count of a location, purity by purity, scans the tags found and weighs the metal, and is kept with the book as it stood: the pieces in the book not found, those found that the book has elsewhere, and the difference in fine weight. A count changes nothing.
- **Why:** a jeweller's stock is its metal: pieces and metal must reconcile in fine weight, and any difference must be explained by a movement.
- **Change it:** `jewellery.edit` counts; the book is written by the database.

### The metal account with suppliers, and fixing the rate

- **Rule:** metal received from a supplier on a metal balance (MV/…) comes into the shop's metal and is owed in grams of its purity; metal given (old gold or scrap against what is owed) goes out of the shop's metal, never below nothing. A manager fixes the rate on the grams owed, all or part of them and never more, at the rate typed or the day's selling rate: a purchase from the supplier of the grams at the rate, at 3% GST, booked under the metal's own item without stock (the metal is in the jeweller's books in grams already). Each step is audited, and the balance shows beside the money owed to the supplier.
- **Why:** bullion bought on a metal balance is owed in grams until its rate is fixed (bhav cut); then it is money owed like any purchase.
- **Change it:** `jewellery.edit` with `purchasing.create` moves metal; `jewellery.approve` with `purchasing.create` fixes the rate.

## Rentals & hire

A rental or hire business bills on bills of the shared core ([Shops and the shared core](#shops-and-the-shared-core)); with *Hire items & bookings* on it also books what it hires out, hands it over and takes it back, bills the hire when it is back, and keeps the deposits it holds apart from sales. Each rule below is checked by the server, and the ones about records that must not change, and about what is free, are held by the database too. Every time the rules count (today, now, overdue, due back) is on the business's own clock, in its time zone: a booking's times are instants, typed and shown on that clock.

### A rental item is a service item, and its GST is the like goods'

- **Rule:** each rental item is billed as a service item of the catalogue counted in services (never goods or a kit): an existing one chosen, or one made with the item from the name, GST slab and SAC typed (its own price stays nil: the item's rates price it). The bill takes each line's GST slab from the item on the day of the bill. A rental item keeps its service item, how it is hired out (one by one or from a pool) and whether it is a vehicle; it is switched off, never deleted. Its service item is billed only from a booking: any other bill (*New sale*, a quotation's bill) refuses it.
- **Why:** renting goods without an operator (heading 9973) is taxed at the rate of a sale of the like goods (entry 17(viia) of Notification 11/2017-CT(R)): from 22 September 2025 renting goods that attract 40% is 40%. A passenger vehicle hired with a driver (heading 9966, fuel included) is 5% with input tax credit only of input services in the same line of business, or 18% with full credit. A hire billed outside its booking would escape its late fee, charges and deposit.
- **Change it:** each item's slab and SAC on its service item; have an accountant confirm them.

### The hire is the cheapest mix of the rates

- **Rule:** an item has rates for one by the hour, the day (24 hours), the week (7 days) and the month (30 days), any of them, at least one. A booking's hours are its time from out to due back, each hour or part of one counted, never less than the item's minimum hire and never less than one. The hire of one is the cheapest mix of months, weeks, days and hours that covers those hours (a mix that runs over is allowed: a day can cover 20 hours); between two mixes at the same price, the one with the larger blocks. The line is that times how many, and the database checks it: the price is the blocks times their rates, the blocks cover the hours charged, and the line is the price times how many. GST goes on each line (prices before GST) or comes out of it (prices including GST); the booking keeps its figures, rates and rules as booked, and a change to the item applies to bookings made after it. Extending a booking or changing its times prices it again at the rates it was booked at.
- **Why:** the hirer is charged no more than the best way to hire for the time asked: ten days as a week and three days when that is cheaper than ten days.
- **Change it:** the rates and the minimum hire on *Rental items* (`catalog.edit`).

### Nothing is booked twice

- **Rule:** a reserved booking holds each unit it books, and how many of each pool, from its out time to its due back time and the item's turnaround time; a booking out holds what is still out until it is due back (or until now, while it is late) and the turnaround time, and what came back until it came back and the turnaround time; maintenance booked ahead holds a unit from its start to its end. A unit is held by one booking (or maintenance) at a time, and a pool never by more than it has at any moment. A quote holds nothing. The server checks it when a booking is made, reserved, changed or extended, and the database checks every booking it saves, one after another for each item, so two counters booking the same unit at the same moment cannot both have it. A retired unit is not booked; a unit in maintenance is booked but not handed over; a unit booked or out is not retired, and a pool is not set below what bookings hold at their busiest.
- **Why:** a unit promised to two hirers fails one of them; the turnaround time keeps a unit free for cleaning and checks between hires.
- **Change it:** the turnaround time on *Rental items*.

### A kit books its parts

- **Rule:** a kit (a shamiana set: poles, cloth, ropes, side walls) lists its parts, each an item from a pool, and how many of each are in one kit. Booking so many kits puts a line on the booking for each part, that many times as many, and each part's line is checked for what is free like any other (the database refuses a part's line that is not as many as the kit has of it, and two bookings saved together cannot take the same pieces). The parts go out and come back by their own lines, each with its own late fee; the kit's own line never comes back. A kit is billed as its own line at its own rates, or by its parts at theirs, as it is set when booked; a booking keeps the parts and the billing it was made with.
- **Why:** a set is hired whole, but its pieces are what the yard counts, lends and loses.
- **Change it:** the kit's parts and billing on *Rental items* (`catalog.edit`); bookings made keep theirs.

### Pools are counted at each location

- **Rule:** a pool's pieces are counted at each location, and a unit is kept at one location. A booking holds what is at its own location: a pool never more than the location has, and only units kept there (the database refuses a unit kept elsewhere). Units and pieces move between locations by a transfer, recorded with when, who and why: a unit not while it is booked or out from now on, and no more pieces than the location keeps beyond what its bookings hold at their busiest from now on. A new pool starts at the first location unless placed elsewhere; pieces that do not come back leave their booking's location's count. The item's total is the locations' counts added up.
- **Why:** a chair at the other branch cannot go to this one's function; a transfer kept with its date says where each thing was.
- **Change it:** *Bookings › Yard & fleet* moves units and pieces (`rentals.edit`); a location's count on *Rental items* (`catalog.edit`).

### A booking's times

- **Rule:** a booking goes out today or later and is due back after it goes out, at most 90 days after; times are kept to the minute. It is a quote, reserved, out, returned or cancelled: a quote is reserved; a reserved booking is handed over (out) once its out time has come and before its due back time; an out booking is returned when the last of it is back. A quote or a reserved booking changes its times and lines; an out booking only its due back time (an extension) and notes. A returned or cancelled booking never changes. Every step is kept in the history, with who made it.
- **Why:** the board shows where each booking is, and the history who did what.
- **Change it:** who books is `rentals.create`, who hands over, takes back and extends `rentals.edit` (the owner, a manager, a cashier and a stock keeper by default), who cancels `rentals.cancel`.

### The hirer's ID and driving licence at the handover

- **Rule:** the handover records the hirer's photo ID (Aadhaar, voter ID, driving licence, passport, PAN card or another), its kind and number; of an Aadhaar card only the last four digits are kept, and the database refuses more. With the business's setting on (on to start with) a handover without it is refused. A self-drive vehicle (a car or a motorcycle hired without the shop's driver) goes out only on the hirer's driving licence, its number and the date it is valid until, refused once that date has passed; and only while the location holds the State Transport Authority's rent-a-cab (cars) or rent-a-motorcycle licence in force, kept with *Licences & registrations*. Each line's condition, meter and a vehicle's fuel (in eighths of a tank) are noted; a meter reading never goes below the unit's last one. An original document the shop holds until the return (a driving licence, a passport) is named at the handover and its return acknowledged once; no copy of an ID document is kept.
- **Why:** the shop must be able to trace the hirer, and keeps no more of an Aadhaar number than the last four digits; a vehicle is not handed to someone without a valid licence; self-drive hire needs the rent-a-cab or rent-a-motorcycle licence; what was noted at the handover is the proof of a later damage charge. Keeping copies of ID documents waits for a legal view under the DPDP Act.
- **Change it:** *Record the hirer's photo ID at every handover* on *Rental items* (`settings.edit`); the location's licences under *Settings › Licences*.

### The hirer register of the rent-a-cab and rent-a-motorcycle schemes

- **Rule:** a self-drive vehicle's handover writes the hirer register as Forms 5 (a cab) and 3 (a motorcycle) list it: the hirer's name, full address and telephone; the driving licence's number, issuing authority, classes of vehicle, and issue and expiry dates; with the return, the hire and return times and the total kilometres; the hirer's signature; remarks. A foreign national's (Forms 6 and 4) adds the passport's number, issuing authority and nation and its issue and expiry dates (in force), the date of birth, the driving permit's number and issue date and the classes it authorises, and the visa. A vehicle keeps its class as a driving licence names it (MCWOG, MCWG, MC50CC, LMV, LMV-NT, TRANS); the handover is refused when none of the licence's or permit's classes is the vehicle's (the database checks it too). The register is kept as written (an erasure at the hirer's request blanks their details only) and printed vehicle by vehicle for any dates.
- **Why:** the Rent a Cab Scheme, 1989 and the Rent a Motor Cycle Scheme, 1997 require the licence holder to keep these registers; a licence that does not cover the vehicle is no licence to drive it.
- **Change it:** each vehicle's class on *Rental items*; the register prints from *Bookings › Hirer register* (`rentals.print`).

### A vehicle's papers and its slab

- **Rule:** a vehicle keeps the dates its registration certificate, permit, insurance, PUC certificate and fitness certificate run until. The bell warns from the shop's warning days before a date (30, until changed), again from its urgent days (7), and once it has run out. A vehicle with a paper run out is not handed over, or is handed over with a warning kept on the booking, as the shop sets it (not handed over, until changed). A vehicle also keeps its engine size, length and fuel; renting it without an operator takes the like goods' rate (an electric vehicle 5%; a motorcycle up to 350 cc, or a car on petrol, LPG or CNG up to 1200 cc or on diesel up to 1500 cc and up to 4000 mm long, 18%; any other car or motorcycle 40%), and a vehicle whose facts make another rate than its item's slab is shown with a warning. The item's slab stays the one billed.
- **Why:** a vehicle without insurance, PUC or fitness must not be on the road; GST on renting goods without an operator follows the rate of a sale of the like goods (from 22 September 2025).
- **Change it:** the dates and facts on *Rental items*; the warning days and whether a vehicle with a paper run out goes out, in its handover settings (`settings.edit`); the item's slab, with an accountant.

### Kilometres and fuel

- **Rule:** an item read by its odometer may have kilometres free (so many a day of the hours charged, each 24 or part of them, or so many a booking) and a rate for each kilometre beyond them; a vehicle may have a fuel charge for each eighth of a tank short of the level it went out with, or for each litre (an eighth of the tank's litres, to the paisa). The booking keeps them as booked; at the return the kilometres beyond the allowance (each one or part of one) and the eighths short are worked out from the readings noted (the database works them out again), and each is a line of the bill at the item's slab, as a late fee is.
- **Why:** a hire's price includes the kilometres and fuel it allows; what goes beyond is part of the hire's value.
- **Change it:** the allowance and the rates on *Rental items* (`catalog.edit`); bookings made keep theirs.

### Checklists, photos and signatures

- **Rule:** a class of items keeps a checklist; at every handover and every return each point is checked for each line of its items, and a point not as it should be says what is wrong (refused without it). Photos of what goes out and comes back, and the signatures drawn on the screen by the hirer and the shop, are kept with the booking at both; they are pictures (the bytes checked), read only through the API by those who see the booking, never changed or deleted, and never of an ID document. A unit's barcode or serial scanned at the handover or the return must be a unit of the booking (still out, at a return).
- **Why:** both parties' acknowledgement of the condition is the proof of a damage charge; scanning stops the wrong unit going out or being taken back.
- **Change it:** a class's checklist on *Rental items* (`catalog.edit`).

### Service schedules and maintenance booked ahead

- **Rule:** a unit may be serviced every so many running hours or kilometres (by its meter) or days, counted from its last service (or from when the schedule was set); the bell says when it is due, and a service done is recorded with its meter. Maintenance booked ahead holds the unit from its start to its end as a booking does: it is booked only over free time, and a booking over it is refused (the database checks both). It is cancelled, never deleted.
- **Why:** a unit due for its service or booked for repairs must not be promised to a hirer.
- **Change it:** the schedule on *Rental items*; maintenance and services on *Bookings › Yard & fleet* (`rentals.edit`).

### A discount on a booking

- **Rule:** a booking may take a percent off the hire of every billed line, with its reason, given by someone with `sales.discount` and within the business's most bill discount (the owner, any). It is kept on the booking with who gave it, priced in the booking and on the bill (each hire line less its share), and changes with the booking until it is back.
- **Why:** the counter's discount limits hold for a hire as for a bill.
- **Change it:** the most bill discount in *Business settings*; who discounts is `sales.discount`.

### A deposit is held apart, not a payment for the hire

- **Rule:** a refundable deposit (for each one hired, as the item says when booked) is a collection receipt in the hirer's name, with no GST, held for its booking. It pays nothing until the booking comes back or is cancelled. Whatever the shop keeps of it (damage, missing pieces, cleaning, fuel, a late fee, a cancellation charge) is billed as a charge with its GST, at the slab of the item it is for, and the deposit then pays that bill as part of its payment; what is left goes back as a numbered refund of the receipt, by cash, UPI or bank, with a reason and a manager's PIN. A deposit is never simply kept. The handover takes the deposit asked; less only with a manager's say-so and the reason (their PIN when someone else asks). The ledger of deposits held (collected, applied to bills, handed back, held) is worked out from the receipts' own payments and refunds.
- **Why:** a deposit is not consideration for the hire until it is applied to it (CGST Act, section 2(31), proviso): the GST is on what the shop keeps, billed as a charge. The shop owes what it holds to its hirers.
- **Change it:** each item's deposit on *Rental items*; who hands money back is `rentals.refund`, who agrees to less deposit `rentals.approve` (the owner and a manager by default).

### An advance is money on account for the hire

- **Rule:** an advance taken on a reserved or out booking is a collection receipt in the hirer's name, at most the hire, and pays the booking's bill before the deposit. A booking's advances and deposits pay only that booking's bill: the customer's dues leave them alone. What is left of an advance goes back as a deposit does.
- **Why:** money taken for a hire belongs to that hire.
- **Change it:** who takes money is the role's `sales.edit`.

### The late fee

- **Rule:** a line back by its due back time and its grace time pays no late fee. After the grace time, each hour or day late (as the item's late fee is set when booked), or part of one, counted from the due back time, at the booked late rate (the item's own, or its hour or day rate), for each one still out. By slabs (the item's own, or its class's): the hours late (each hour or part of one, from the due back time) fall in the slab with the most hours they pass, and that slab's flat amount and its multiple of the hourly rate for each hour price all of them. A cap, when set, is the most for each one. A line returned in parts pays each part's late fee as it comes back; the database works the fee out again from the time it was saved and the due back time. The late fee is billed on the line's own service item, with its GST.
- **Why:** the hirer agreed the late fee with the booking; the shop's clock decides when it was late. Slabs and caps are each shop's own terms: nothing is set for it.
- **Change it:** each item's late fee, slabs, cap and grace time on *Rental items*, or its class's slabs; bookings made keep theirs.

### One bill, when the last of it is back

- **Rule:** things come back in parts; the bill is posted through the core when the last of the booking is back (or will not come back): each billed line's hire (less the booking's discount), the late fees, kilometres, fuel and the charges noted on every part, each at its item's GST slab of the day, the advance paying first, then the deposit; what is not paid stays on the hirer's dues. A unit that will not come back is retired, and pieces of a pool that will not come back leave the pool at the booking's location. Retries give the same return, and the same request with other data is refused.
- **Why:** one tax invoice for the hire; GST is worked out at the rate of the day of the invoice.
- **Change it:** nothing to set.

### Cancelling

- **Rule:** a quote or a reserved booking is cancelled with a reason. With the shop's cancellation slabs set, a reserved booking's charge is worked out, never typed: from the hours left before its out time, the slab with the most hours they reach gives the percent (past the out time and not handed over, a no-show, the no-show percent, or the slab from 0 hours), that share of each billed line's hire less its discount. A manager may waive it, with the reason (their PIN when someone else asks); the charge worked out, what was charged and the waiver are kept with the booking and audited. With no slabs set a charge may be typed. A quote is cancelled with no charge worked out. A charge is billed with its GST at each line's slab, and what is held pays it first; what is left goes back, now or later, with a manager's PIN.
- **Why:** what the shop keeps is billed, as with any deposit; slabs agreed with the hirer leave nothing to argue at the counter. The slabs are each shop's own terms: none are set for it.
- **Change it:** the slabs and the no-show percent in the handover settings on *Rental items* (`settings.edit`); who cancels is `rentals.cancel` (the owner and a manager by default), who waives `rentals.approve`.

### Someone who does not see sales sees no money

- **Rule:** bookings, the board, the lines and the returns show without rates, hire, deposits, charges, bills or money to anyone whose role does not hold `sales.view` (the yard's stock keeper, say), and the deposits held need it. Taking a deposit or an advance needs `sales.edit`, and the return that posts the bill `sales.create`.
- **Why:** the yard hands things over and takes them back; the money is the counter's.
- **Change it:** *Roles & permissions*.

## Fuel stations

A fuel station bills lubricants and its shop's items on bills of the shared core ([Shops and the shared core](#shops-and-the-shared-core)); with *Tanks, nozzles & shifts* on it also keeps the back office of the forecourt: each attendant's shift from the nozzles' totalisers, the fuel bills its close posts, the morning dips, the tanker loads, the stock and density registers, and its fleet customers' credit. Readings are typed in from the totalisers, the dip rod and the hydrometer: nothing controls or talks to a dispenser, a forecourt controller or a tank gauge, which at an automated outlet are the oil company's. Each rule below is checked by the server, and the ones about readings, money and records that must not change are held by the database too. Every day and time the rules count (a shift's readings, a dip's day, today, a price's effect) is on the business's own clock.

### A fuel is outside GST, its price including state VAT

- **Rule:** each fuel (petrol, diesel, a premium grade, CNG) is a goods item counted in litres (CNG in kilos), kept in stock by quantity and on the GST nil slab; the database keeps a fuel's item there. Each fuel bill line names the fuel and says *price includes state VAT*, and a fuel bill has no round-off. A fuel is sold only by a shift's close (any other bill refuses it), and petrol or diesel is bought only by a tanker receipt (CNG, by pipeline, on a purchase). Lubricants and the shop's items are ordinary products at their own GST slab.
- **Why:** petrol, diesel and CNG are outside GST: their retail price carries the state's VAT or sales tax and the central excise (PPAC's statement of state taxes on petroleum products). The meters sell the fuel, not a counter: litres billed outside a shift would be missing from the stock register.
- **Change it:** nothing to set; the proper non-GST fuel invoice and the VAT return are in [BACKLOG.md](BACKLOG.md#7-left-inside-built-modules).

### The price in force

- **Rule:** a fuel's price at an outlet takes effect from a time: now, or one typed within a week before and a month ahead. A price is never changed or deleted; a new one is set. A shift sells each fuel at the price in force when it opened; a shift open when a price changes is closed with the readings taken at the change, and the next one opens at the new price. A new price never takes effect back into a closed shift that sold the fuel.
- **Why:** the oil company revises its prices; a shift's money is reckoned at one price.
- **Change it:** *Settings › Pumps & nozzles › Set the prices* (`catalog.edit`).

### A nozzle opens where it last closed

- **Rule:** a nozzle's totaliser reading moves only when a shift closes (to its closing reading), when a manager reopens a shift (back to its opening) or with a meter change a manager records with the reason; the database checks it. A shift opens each nozzle from its reading, and another opening is refused. A nozzle is on one open shift at a time, an attendant has one open shift at an outlet at a time, and only a unit in use has its nozzles used.
- **Why:** what a nozzle sold is its totaliser's difference; a gap or an overlap between two shifts would hide litres.
- **Change it:** who records a meter change is `fuel.approve` (the owner and a manager by default).

### What a shift sold, to the paisa

- **Rule:** each nozzle sold its closing reading less its opening less the test pumped back; the test is not a sale, and the database checks each figure. Each credit slip and each fill of ₹2,00,000 or more is its quantity at the price, to the paisa; each fuel's walk-in quantity is what its nozzles sold less its credit slips and big fills, at the price. The money expected is the credit, the big fills and the walk-in sales. The attendant's money is the cash counted (by notes and coins when counted so) and the cash dropped during the shift, less the cash the big fills were paid, and the UPI, card and fleet-card takings; their difference is that money less the walk-in fuel sales and the other sales to walk-in buyers: below nothing they are short, above it in excess. The takings are at most the walk-in fuel and other sales, and a fuel's credit slips and big fills at most what its nozzles sold.
- **Why:** sales are measured by the totaliser difference of each nozzle for each shift and settled with each attendant (DSM) across cash, card, UPI, fleet cards and credit slips; every nozzle is tested daily with the stamped 5-litre measure and the test quantity recorded (Marketing Discipline Guidelines 2024, 1.4.2).
- **Change it:** the test measure's litres under *Tolerances* on *Pumps & nozzles* (`settings.edit`).

### The close posts the fuel bills through the core

- **Rule:** closing a shift posts one walk-in fuel bill (a line for each fuel sold to walk-in buyers, with no buyer named), paid by the takings and then the cash, and a fuel bill to each fleet customer billed per shift with a line for each fill (its vehicle and slip number), due by the customer's credit days. What is still short on the walk-in bills is paid from the attendant's account ([The attendant's account](#the-attendants-account)); an excess is held on it. Retries give the same close, and the same request with other data is refused. The bills' lines are credited only by a manager reopening the shift: a return on them is refused. The walk-in bill sums the fills of many buyers, each paying for their own, so it is not counted against the ₹2,00,000 cash limit of one bill or one customer and asks for no PAN ([Cash of ₹2,00,000 or more](#cash-of-200000-or-more)).
- **Why:** the stock and the money stay in the core, with the fuel's own bills.
- **Change it:** nothing to set.

### Credit over a limit needs a manager

- **Rule:** a credit fill over its vehicle's fill limit, or credit that takes a customer over their credit limit (their fills held for the month's invoice counted with what they owe), closes the shift only with a manager's say-so (`fuel.approve`), kept on the close and on its slips. A credit fill over ₹2,00,000 needs the customer's PAN (or a GSTIN that carries it) kept with them. A customer's slip number is entered once.
- **Why:** the fill limit is the fleet owner's control over each vehicle; the buyer quotes their PAN on a purchase over ₹2,00,000 ([PAN on a bill over ₹2,00,000](#pan-on-a-bill-over-200000)).
- **Change it:** each vehicle's fill limit on *Fleet statements*, the customer's credit limit with the customer.

### A closed shift never changes

- **Rule:** a closed shift changes only by a manager reopening it with the reason, and only before another shift has opened on any of its nozzles, while none of its fleet fills is on a month's invoice and while the excess it left was not taken to income. Its bills are credited (the litres and the other sales back in stock until it closes again), what was paid on its walk-in bills and its big fills handed back the way it came (the attendant's account too), the attendant's short or excess reversed on their account, and its nozzles read again from the shift's opening; it is then closed again, as a new close, its cash drops still counted. Every close stays, with who closed it, who reopened it and why.
- **Why:** the next shift opens from the readings it closed with.
- **Change it:** who reopens is `fuel.approve` (the owner and a manager by default).

### The morning dips

- **Rule:** a tank has one dip a day, on the business's day it was taken, typed within a week, never more than the tank holds; a dip of an earlier day needs the time it was taken. It keeps the litres by the dip chart, and may keep the dip read, the water dip, the morning density at 15 °C and the temperature. When the tank's chart is kept ([Dip charts](#dip-charts)), a dip read in cm takes its litres from the chart. A manager corrects a dip with the reason, kept with it; the activity log keeps what it said before.
- **Why:** the guidelines' daily stock register takes the product and water dips of each tank in the morning, and the morning opening density at 15 °C from a nozzle sample before sales (1.3, 1.4.1).
- **Change it:** who corrects a dip is `fuel.approve`.

### A tanker load: the density check and the dips

- **Rule:** for each tank a load goes into: the invoice's litres, value and density at 15 °C, and the lorry's density at 15 °C, within the tolerance of the invoice's either way (3.0 kg/m³ until changed); outside it the load is refused, unless a manager accepts it with a note (shown on the bell for a week). An accepted load needs the dips before and after decanting (what came in by the dips; a short receipt is the invoice's litres less that), never more than the tank holds, and is a purchase of the fuel at the invoice's litres and value, without GST, made by someone who may make purchases. A load is written within a week of its decanting. The density after decanting and 50 litres dispensed is written once. A manager cancels an accepted load entered wrongly, while the stock still holds its litres: its purchase is credited and its litres go out of stock; the purchase's lines are credited only that way.
- **Why:** the guidelines check the density at 15 °C within ±3.0 kg/m³ of the invoice density before decanting, dip every compartment, and record the density after decanting and dispensing at least 50 litres in the density register (1.2, Annexure 1).
- **Change it:** the density tolerance under *Tolerances* (`settings.edit`); who accepts a load outside it is `fuel.approve`.

### A load's compartments and its retention samples

- **Rule:** a tanker receipt may keep each compartment of the lorry as checked before decanting: the tank it went into, its dip, density and temperature, whether the water-finding paste found water (and how much), about 20 litres drawn from its manifold with their density and temperature, and a short dip (water removed included) with what was made up through the pump, never more than it was short. They are written with the load and never changed. A load received may keep its retention samples (the sample's number and its seal's); the samples of the last two loads of a fuel at an outlet are kept, and an older load's are due for disposal (the bell says so): a sample is disposed of only then, once, with who and when.
- **Why:** the guidelines dip each compartment, check it for water with water-finding paste, draw about 20 litres from each manifold for density and temperature, make a short dip up through the pump compartment by compartment, and keep retention samples of the last two loads of each product.
- **Change it:** nothing to set.

### Dip charts

- **Rule:** each tank may keep its calibration (dip) chart, cm and litres a row, typed or pasted, rising with the dip; a chart saved again takes the place of the one before (the activity log keeps the change). A dip read in cm takes its litres by a straight line between the chart's two rows around it, to the millilitre, exact at a row; a dip outside the chart is refused.
- **Why:** the litres in a tank are read off its calibration chart from the dip.
- **Change it:** *Settings › Pumps & nozzles*, a tank's *Dip chart* (`settings.edit`).

### The stock register against the tolerance

- **Rule:** a tank's day runs from its morning dip to the next (Annexure 9). The opening dip (A), plus the loads received (B, accepted, by the invoice's litres), less their shrinkage and temperature variation allowances (C), is D; D less the meters' sales (E, closed shifts, the test pumped back taken out) is the book stock (F). The variation is the next dip (G) less F, also as a share of G. It is within the tolerance from a loss of 4% of the dip plus the allowance on what was sold (petrol 0.75%, diesel 0.25%; 0.60% and 0.20% when the station's annual average is beyond 600 KL) up to a gain of 4% of the dip. The bell names a tank whose latest day is beyond it: a gain as critical, a loss as a warning.
- **Why:** the guidelines allow a normal operational variation of 4% of the tank stock, plus evaporation and handling losses of what was sold; a positive variation beyond the limits leads to sampling and the suspension of sales, a negative one to the dealer explaining it (5.1.11, Annexure 9).
- **Change it:** the variation and the allowances under *Tolerances* (`settings.edit`); a load's shrinkage and TVA on its tanker receipt.

### A load's shrinkage and temperature variation allowance

- **Rule:** each tank line of a tanker receipt may keep the invoice's shrinkage allowance and its temperature variation allowance (TVA, either way) in rupees a kilolitre. Each is turned into a percentage of the load's value at its own cost a kilolitre (allowance ÷ cost a KL), and so into litres of it, to the millilitre: these litres (C) come off the receipts in the stock register.
- **Why:** the shrinkage and TVA are paid as rupees a kilolitre on the invoice; Annexure 9 takes them off the receipts as litres. TVA is generally revised every quarter, so each load keeps its own.
- **Change it:** on each tanker receipt, from its invoice.

### A day of the register posted to the stock

- **Rule:** a manager who may correct stock (`fuel.approve` and `inventory.edit`) posts a tank's day to the stock as a correction through the core, with the reason, once, when its next dip has closed it and no shift is open on the tank. The stock moves by the gap between the next dip and the stock by the meters and the invoices (the variation, and the allowances taken in the book): that gap, the variation, the allowance and the reason are kept, never changed, and audited.
- **Why:** the core's stock moves by the invoices and the meters only; what the dip finds besides is a correction someone answers for.
- **Change it:** who posts is `fuel.approve` with `inventory.edit`.

### Stamping

- **Rule:** each dispensing unit and each measure keeps the date its Weights & Measures stamping falls due; the bell warns from 30 days before it and once it has fallen due. A unit is suspended or retired with the reason, and its nozzles are not used while it is.
- **Why:** the guidelines check the Weights & Measures seals and certification of each unit daily, suspend a unit whose seals are tampered with, and test with a W&M-verified 5-litre measure (1.4.2).
- **Change it:** the warning days under *Tolerances* (`settings.edit`); the dates on *Pumps & nozzles*.

### The attendant's other sales

- **Rule:** lubricants, additives and the shop's items an attendant sells on the forecourt are entered on the shift's close: the business's items that are not fuels, priced as a sale prices them, billed as a GST invoice through the core at their own slabs, one to walk-in buyers and one to each customer the attendant names (on their account). They never go on a fuel bill. The walk-in invoice is paid what is left of the takings once the walk-in fuel bill is paid, then the cash, then the attendant's account. A reopened shift credits them (a part already returned on its own stays returned).
- **Why:** lubricants, additives and accessories are GST supplies on a GST invoice; the fuel is outside GST on its own bill.
- **Change it:** the items' slabs on their item.

### Cash drops and the count

- **Rule:** during an open shift, cash handed over (how much, when, and to whom on the staff other than its attendant) is a cash drop; the attendant records their own, someone with `fuel.edit` anyone's. A manager (`fuel.approve`) cancels one typed wrongly while the shift is open, saying why. The drops not cancelled count with the cash at the close. The cash may be counted by notes and coins, from the station's list; the count is then the cash.
- **Why:** no rule was found on drops or safe deposits: the station's own practice, so its settings.
- **Change it:** the notes and coins under *Tolerances* on *Pumps & nozzles* (`settings.edit`).

### A walk-in fill of ₹2,00,000 or more

- **Rule:** a walk-in buyer's single fill of ₹2,00,000 or more is entered on the close and billed on its own: a fuel bill to no one by name with the buyer's PAN or their declaration (Form 97), paid in full as the buyer paid (cash and a method of the business), its vehicle and buyer's name noted when given. Less than ₹2,00,000 of it is in cash, and the cash from the same PAN that day (on bills, less what was handed back) stays under ₹2,00,000. A fill under ₹2,00,000 goes on the walk-in bill. Its line is credited only by reopening the shift.
- **Why:** the cash limit is for one bill and one person in a day (Income-tax Act 2025, section 186), and a sale over ₹2,00,000 quotes the buyer's PAN; the shift's walk-in bill is many buyers, so a single big buyer is billed on their own, as a fleet customer's credit fill is.
- **Change it:** nothing to set.

### The attendant's account

- **Rule:** a shift closed short leaves its short due from its attendant: the walk-in bills are paid it from their account (named *Attendant account*), so nothing is left due on them. A shift in excess holds the excess on their account. A short is recovered when the attendant pays (cash, UPI, card or bank, `fuel.edit`), or by a deduction recorded when they are paid their wages (`fuel.approve`, with what it is for; the wages paid out, if any, go in the expense book as wages with `expenses.create`); never more than they owe. An excess goes to other income only when a manager takes it there (`fuel.approve`, saying why), never more than is held. What the attendant pays and the excess taken to income are money in on the day's money, at the outlet where it was handed in. Each entry is kept as written and audited; a reopened shift reverses its short or excess. The accounts are shown per attendant and period to those who see sales.
- **Why:** the attendant answers for the shortfall of their shift; an excess is not the station's income until someone decides it is.
- **Change it:** who records each is `fuel.edit` (a payment) and `fuel.approve` (a deduction, an excess to income).

### Fleet customers and fleet cards

- **Rule:** a fleet customer is a customer of the business, with their credit days and credit limit. Each vehicle is kept by its registration (in use with one customer at a time), with the fuel it takes on credit and the most it takes in one fill; it keeps its customer and registration, and is switched off, never deleted. An oil company's fleet or loyalty card is a payment method of the business, taken with a shift's takings: it is not the station's credit.
- **Why:** fleet cards are run and settled by the oil company; the station's own credit is the customer's account, filled vehicle by vehicle on signed slips.
- **Change it:** *Customers & fleets › Fleet statements* (`fuel.edit`); the fleet cards under *Settings › Payment methods*.

### A fleet customer billed by the month

- **Rule:** each fleet customer is billed per shift (until changed) or by the month, a term kept with them (`fuel.edit`). A monthly customer's credit fills get no bill at the shift's close: each is held on its slip, its stock still in the core, counted with what they owe against their limit. One invoice for the month at an outlet bills the fills held for that month there, a line for each fill (its fuel, vehicle, day and slip), with no round-off: the stock leaves with it, once, and the fills are then billed. It is made by someone who keeps the fleet and makes sales (`fuel.edit` and `sales.create`), once the month has begun; a fill billed on it is never billed again, and its lines are not credited on their own. Once the month is over, the bell warns of a month's fills not invoiced. Fills already held stay held when the customer goes back to billing per shift.
- **Why:** many fleet customers settle monthly. The delivery challans of the wholesale tools go with an invoice already posted (a dispatch is itself the sale), so they cannot carry fills until a later invoice: the fills are held here instead, so that the stock never leaves twice.
- **Change it:** the customer's terms on their fleet statement.

### Slip books by serial

- **Rule:** slip (indent) books are issued to a fleet customer with their serial range (`fuel.edit`), never overlapping another of theirs, kept for good; a book taken back or lost is withdrawn. A customer with a book in use gives each fill's slip serial: one outside their books in use, or one already used on a fill in force, is refused (the database checks it too). Each book shows its slips used, with their shift and vehicle, and those still unused.
- **Why:** the indents or credit slips are kept by book and serial number.
- **Change it:** the customer's slip books on their fleet statement.

### Interest on overdue fleet credit

- **Rule:** a fleet customer's terms may carry interest on overdue credit: a rate a month and a number of days after a bill falls due. On each of their fuel bills (a shift's or a month's invoice), each day after its due date and those days earns a thirtieth of the rate on what is still owed on it at the end of that day, to the paisa, simple interest (never on interest). The interest worked out to today, less what was billed before, is billed when someone confirms the amount they saw (`fuel.approve` and `sales.create`): one bill of the service item chosen for it, exact to the paisa, due at once, on the customer's account whatever their limit; refused when the amount has moved since. The workings are kept with it.
- **Why:** interest and reminders on fleet credit are the dealer's practice, by the terms agreed with the customer.
- **Change it:** the rate and days in the customer's terms; the interest item under *Tolerances* (`settings.edit`).

### The records

- **Rule:** the daily sales register prints from the shifts closed on a day at an outlet: each shift's nozzles with their readings, the test and the litres, and each fuel's sales on credit, in big fills and to walk-in buyers, at its price (money for those who see sales). It is the station's own register: the oil companies' own formats are not matched. The inspection log keeps each inspection of an outlet (when, by whom, for whom, what was found and what was done), written by someone with `fuel.edit`, never changed or erased.
- **Why:** the daily sales register and the density register are kept for the current and previous financial years, and inspection records for the previous five years.
- **Change it:** nothing to set.

### Every outlet at a glance

- **Rule:** *Outlets* shows each outlet the person works at: today's shifts open and closed, the litres and sales, the attendants' shorts and excess today, each tank's latest day of the register against the tolerance, what customers owe on the outlet's bills, its fleet fills not yet billed and what its attendants owe, and the bell's alerts there. Money is for those who see sales.
- **Why:** an owner with several outlets sees them side by side.
- **Change it:** nothing to set.

### Who sees what

- **Rule:** someone whose role does not hold `sales.view` (a pump attendant) sees and closes only their own shifts and no other attendant's money; a tanker load's value is for those who see purchases; the fleet statements, the attendants' accounts and the money on *Outlets* and the daily sales register are for those who see sales.
- **Why:** an attendant's settlement is theirs and the manager's to see.
- **Change it:** *Roles & permissions*.

## Hotels, lodges & guest houses

A hotel, lodge or guest house bills on bills of the shared core ([Shops and the shared core](#shops-and-the-shared-core)); with *Rooms & stays* on it also keeps its rooms and their housekeeping status, takes reservations (a room at a time, or a group's block of rooms) priced from its rate plans and rate calendar, checks guests in with every occupant, keeps its foreign guests' Form-III reports, posts its room nights night by night and bills each folio at check-out. Each rule below is checked by the server, and the ones about a night's rate and slab, a room never booked twice and records that must not change are held by the database too. Every day the rules count (a stay's nights, today, the check-in and the check-out) is on the business's own clock: a night belongs to the date it starts on, the arrival date is the first night, and the departure date is the morning the guest leaves.

### A room night's GST slab is decided night by night

- **Rule:** the settings name two slabs of a room night and the limit between them (5% at or below ₹7,500 a night before GST, 18% above it). Each night of a stay is valued before GST: the night's rate as the stay keeps it ([Each night's rate from the calendar](#each-nights-rate-from-the-calendar)), plus each adult beyond those in the rate, each child and each extra bed at their rates, less the stay's discount; a plan's meals are not in it. A night valued at or below the limit is billed at the lower slab, one above it at the higher, the GST worked out to the paisa. The database checks each room night's rate, value and slab as it is posted. Nothing is reserved or billed until the two slabs are set, and the lower is below the higher.
- **Why:** from 22 September 2025 accommodation valued at ₹7,500 or less per unit per day is taxed at 5% without input tax credit, and above it at 18% with credit (Notification 15/2025-Central Tax (Rate), on the 56th GST Council's recommendation). The slab follows the value actually charged for each room each day, so a stay whose rate crosses the limit on some nights (a weekend rate) carries both slabs, night by night.
- **Change it:** the slabs, the limit and the weekend nights under *Settings › Room types & rates* (`settings.edit`). No official rule says whether extra-adult, child and extra-bed charges count in the value: here they do, and an accountant's view is asked in [BACKLOG.md](BACKLOG.md#7-left-inside-built-modules).

### Room rates are before GST

- **Rule:** a room type's rates (rack, weekend, each extra adult, each child, each extra bed), a rate plan's, a season's and a date's rates, a plan's meals and a stay's agreed rate are each a night before GST (a day use's price is for its block of hours), whatever the business's setting for prices with or without GST; the GST is added on the bill. A stay keeps the rates it was booked at, and a change to a room type's rates applies to stays booked after it. An agreed rate (an OTA's price, a company's rate) takes the place of every other room rate for every night. A room type takes more adults than its rate is for only when it has an extra-adult rate, and extra beds only when it has an extra-bed rate; it never takes more guests than its most.
- **Why:** the limit is on the value of the supply, before tax; a guest is charged the rates they were quoted.
- **Change it:** the rates under *Settings › Room types & rates* (`catalog.edit`); the agreed rate of a guest in the house is changed by `lodging.approve` (the owner and a manager by default).

### A room is never booked twice

- **Rule:** a night stay holds its room from its arrival night to the night before its departure while it is reserved or in the house, and a room is held by one stay a night: the database refuses a second (an exclusion constraint on the room and the nights), even for two stays saved at the same moment, and the server says which stay holds it. A room type never holds more reservations and stays on a night than it has rooms in use at the location, with a room chosen or not: checked when the work is saved, one stay after another for each room type. A stay arrives today or later and runs one night at least and 180 at most. A day use holds its room's hours instead, and no night ([Day use by the hour](#day-use-by-the-hour)).
- **Why:** a room promised to two guests fails one of them, and a reservation with no room yet still needs one on the night.
- **Change it:** nothing to set; the rooms under *Settings › Room types & rates*.

### Every occupant, with their photo ID

- **Rule:** a reservation checks in from its arrival day to the night before its departure, to a room of its type that is vacant and clean and free over its nights. Every occupant is recorded, as many adults and children as the stay is for (the database checks it when the check-in is saved), each with their name and nationality, and an adult with the photo ID seen, its kind and its number. Of an Aadhaar card only the last four digits are kept, and the database refuses more. A foreign national (an OCI cardholder too) is recorded with their passport as the photo ID, their visa's type and number (or their OCI card's), the date they arrived in India (today or before) and their next destination. An occupant's details are corrected while they are in the house; their record is kept, never deleted.
- **Why:** police orders require verifying every guest's government photo ID and recording all the occupants of a room, not only the one who booked (Hyderabad's of July 2026 among them); a foreigner's particulars go on Form-III. Gujarat's PATHIK verifies Aadhaar without storing its number: the business keeps no more of it than the last four digits.
- **Change it:** nothing to set.

### Form-III within 24 hours of arrival and of departure

- **Rule:** each foreign occupant has two reports: the arrival's, due 24 hours after their check-in, and the departure's, due 24 hours after the check-out. Staff make each on the portal and mark it here with the portal's acknowledgement number (3 to 40 letters, digits, `/` or `-`), written once; the departure's once the guest has left. The countdowns show on *Foreign guests (Form-III)* and the bell, an overdue report first. Nothing is sent from here.
- **Why:** under the Immigration and Foreigners Act 2025, in force from 1 September 2025, every accommodation keeper reports every foreigner, now including OCI cardholders, on Form-III (which replaced Form C) within 24 hours of arrival and of departure, through indianfrro.gov.in or its app, and keeps the records electronically for at least a year. The portal is web-only, behind a CAPTCHA, with no public API.
- **Change it:** nothing to set.

### The night audit posts each night once

- **Rule:** the night audit (for one property or every property) posts, for every stay in the house, each of its nights from the arrival to tonight (or to the night before its departure) not posted yet, at the stay's rate for that night and the slab its value decides, with the night's meals of its plan as a line of their own; marks the day's no-shows ([No-shows at the night audit](#no-shows-at-the-night-audit)); and keeps the day close's money as it then stood with the audit, which closes the business date (the date on the business's own clock: a front-desk date lagging the calendar is not kept). A night is posted once it has come, and once only: run again, or from two screens at once, the audit posts nothing twice (the database keeps one room night a night). A night posted by mistake is voided by a manager with the reason before it is billed, and posted again at the stay's rates as they now are. The check-out posts any night still to post. Charges are kept as posted, never deleted.
- **Why:** each night is charged and its slab decided as it is stayed; the folio shows the guest what is owed so far.
- **Change it:** who runs it is `lodging.create`; who voids `lodging.approve` (the owner and a manager by default).

### Extras on the folio

- **Rule:** an extra is a service item (laundry, food, a pickup) at its item's price and GST slab, charged on the day it is posted while the guest is in the house; a room type's item is never an extra. Goods kept in stock by quantity go on the folio as goods ([Goods on the folio](#goods-on-the-folio)); goods kept by batch or serial number, and kits, are sold on a bill of their own.
- **Why:** each folio line carries its own GST; a room night is posted only by the audit or the check-out.
- **Change it:** the items and their slabs in the catalogue (`catalog.edit`).

### Each folio's bill at check-out, to the guest or the company

- **Rule:** a guest checks out on the business's date, on the departure day or earlier; a guest past the departure day is extended to today first. The stay then ends today (one night at least): nights posted ahead and not stayed are voided, the nights up to last night are posted, and each folio (every charge on it not billed) is billed on a sale of its own through the core ([Folios and routing](#folios-and-routing)), each line at its own slab and price, nothing priced again. The main folio's bill is to the company billed (a customer of the business, its GSTIN on the invoice) or to the guest, and every bill's place of supply is the property's state whoever the buyer is. The stay's advances and then its deposits pay them first, each only the bills of the customer who paid it; what is still due on a company's bill stays on its dues, and on a guest's own bill only when someone with `lodging.approve` checks them out. The occupants are marked gone and the room left vacant dirty. When the check-out is saved, the database checks that every night from arrival to departure is billed (on its group's folio, billed with the group) and every charge billed or voided. Retries give the same check-out.
- **Why:** one tax invoice for the stay, with the buyer's GSTIN when a company pays; a guest leaves with the bill settled unless a manager says otherwise. A hotel's accommodation is supplied where the property is (IGST Act section 12(3), not checked: an accountant's view is in [BACKLOG.md](BACKLOG.md#7-left-inside-built-modules)).
- **Change it:** who checks out is `lodging.create` with `sales.create`; who leaves a guest's bill due is `lodging.approve`.

### Advances and deposits are held for the stay

- **Rule:** an advance (money on account, at most the room nights booked and the extras posted) or a refundable deposit is a collection receipt in the guest's name, by cash, card, UPI or bank, taken while the stay is reserved or in the house. It pays only that stay's bills (and its group's folio) made out to the customer who paid it, advances first, then deposits, so a guest's advance never pays a company's invoice; the customer's dues leave it alone. What is left goes back from the stay, deposits first, as a numbered refund of each receipt by cash, UPI or bank, with a reason and a manager's PIN, and a slip prints for the guest to sign. A receipt stays with its stay.
- **Why:** money taken for a stay belongs to that stay, and the business owes what it holds to its guests.
- **Change it:** who takes money is the role's `sales.edit`; who hands it back `lodging.refund` (the owner and a manager by default).

### Cancellations and no-shows

- **Rule:** a reservation is cancelled with a reason; once its arrival day has come it may be marked a no-show instead. A cancellation or no-show charge, before GST (worked out by the stay's policy, [Policies worked out, not typed](#policies-worked-out-not-typed); typed only for a stay booked under none), is billed on a sale to the guest as the room type's nights at the slab of the first night booked, paid first by what is held; what is left goes back, now or later, with a manager's PIN. A cancelled stay or a no-show never changes.
- **Why:** what the property keeps is billed with its GST. A cancellation charge is treated as part of the room's supply (CBIC Circular 178/10/2022-GST, not checked: an accountant's view is in [BACKLOG.md](BACKLOG.md#7-left-inside-built-modules)).
- **Change it:** who cancels is `lodging.cancel` (the owner, a manager and the front desk by default).

### Housekeeping and the rooms

- **Rule:** a room's status has three parts kept apart: occupancy (vacant, or occupied while a guest is checked in to it), cleanliness (dirty, being cleaned, clean, inspected) and availability (out of order for the nights of a period booked for it, [Out of order ahead](#out-of-order-ahead); out of service, still sold). A room is vacant clean when it is clean or inspected and vacant dirty when it is dirty or being cleaned; it is left dirty when its guest checks out or moves. Only a vacant clean room, not out of order over the stay's nights, is checked in to or moved into ([Cleaning steps and inspection](#cleaning-steps-and-inspection)). Every change is kept with who made it and when. A room keeps its location and is never deleted; its type changes, and it goes out of use, only while no stay is reserved for it or in it and its type's reservations still fit in the rooms left.
- **Why:** a guest is given a room that is ready, and the history shows who made up each room.
- **Change it:** who marks rooms is `lodging.edit` (housekeeping, the front desk, a cashier and a manager by default).

### A stay keeps its record

- **Rule:** a stay keeps its number, its guest and where it was made (a group's room takes its guest from the rooming list while it is reserved); a day use stays a day use, and a group's stay stays in its group. It goes reserved → in the house → checked out, or is cancelled or marked a no-show while reserved, and then never changes; the check-in, the check-out and a cancellation are each written once, with it, and its bill once. A guest in the house keeps a room, the stay's adults and children are the occupants recorded and still in the room, and its departure is never before a night already posted. The history keeps every step with who made it.
- **Why:** the register and the bills stay as they were made.
- **Change it:** nothing to set.

### Who sees the money and the IDs

- **Rule:** someone whose role does not hold `sales.view` (housekeeping) sees the desk, the stays and the folio without rates, charges, money held or bills. Only those who check guests in (`lodging.create`) or print the register (`lodging.print`) see the occupants' ID details, phones, addresses and visas.
- **Why:** housekeeping makes up rooms; the guests' IDs are for the desk and the police register.
- **Change it:** *Roles & permissions*.

### Rate plans and their meals

- **Rule:** a room type has rate plans, each with its meal plan: EP (room only), CP (with breakfast), MAP (half board) or AP (full board). A plan with meals names the food service item they are billed as (a service item of the business, not a kit and not a room type's) and their price a night before GST for each adult and each child. The meals are kept apart from the room: each night's meals for the stay's adults and children are billed as a line of their own, as that item at its slab, so the room night's value alone decides its slab (5% at ₹7,500 or less, 18% above). The extra adults, children and extra beds still count in the room night's value; the meals do not. A plan may have its own room rate and weekend rate (none: the room type's), is refundable or not, and may name its policy (none: the property's). A plan keeps its room type and is switched off, never deleted. A stay with no plan takes the room type's rates, room only.
- **Why:** the slab follows the value charged for the room each night, so meals sold with a room do not lift it into the higher slab, and one vendor advises invoicing the room and the restaurant separately for a room at or below ₹7,500 sold with meals. Whether bundled meals, extra persons or extra beds count towards the ₹7,500 value is not settled: an accountant's view is asked in [BACKLOG.md](BACKLOG.md#7-left-inside-built-modules).
- **Change it:** *Settings › Room types & rates › Rate plans* (`catalog.edit`); the meal item and its slab in the catalogue.

### Each night's rate from the calendar

- **Rule:** each night of a stay is priced from the rate calendar, the most particular rate first: an agreed rate for every night; else the date's own rate (set for the stay's plan, then for the room type); else a season covering the night (the plan's own season, then the room type's), at its weekend rate on a weekend night, else its weekday rate; else the plan's own rates (its weekend rate on a weekend night, else its room rate); else the room type's weekend rate on a weekend night, else its rack rate. Each extra adult, child and extra bed takes the date's rate, then the season's, then the room type's. A stay keeps each night's rates as priced: they change only when its room type, its plan or its agreed rate changes, and the nights an extension adds take the calendar's. Two seasons of the same room type and plan never cover the same date (the database refuses it; a season switched off is left out), and a season runs a year at most.
- **Why:** a property sells the same room at different prices by season, by weekday and by date; a guest is charged the rates they were quoted.
- **Change it:** *Settings › Room types & rates › Seasons* and *Rate calendar* (`catalog.edit`); the weekend nights with the slabs (`settings.edit`).

### Minimum stay, closed to arrival and stop-sell

- **Rule:** the calendar may give a date, for a room type or one of its plans, a minimum stay (a season may too), close it to arrival, or stop selling it. When a reservation is made or changed, the server refuses a stay arriving on a date closed to arrival, one shorter than its arrival date's minimum stay (the date's, else its season's), and one with any night not sold, each with the reason (409, `data.reason` `closed_to_arrival`, `min_stay` or `stop_sell`); an extension checks stop-sell on the nights it adds. The reservation's preview shows the refusal as it is typed, and a group's rooms are checked as any reservation.
- **Why:** a property keeps its busy dates for longer stays, keeps arrivals off the days it cannot take them, and stops selling a room type when it chooses.
- **Change it:** *Settings › Room types & rates › Rate calendar*, *Set dates* (`catalog.edit`).

### A discount on a stay

- **Rule:** a stay may take a discount: a percentage off the room's value (the room rate with the extra adults, children and beds; not the meals, extras or goods), with a reason, given by someone with `sales.discount` within the most a bill takes off in *Business settings* (the owner, any). Each night's value after the discount decides its slab, so a discount may bring a night to ₹7,500 or less and to the lower slab. Changed while the guest is in the house, the nights not yet billed are posted again with it. A day use takes it too.
- **Why:** GST is on the value actually charged: the discounted price is what counts.
- **Change it:** the most a bill takes off in *Business settings*; who gives a discount under *Roles & permissions* (`sales.discount`).

### Day use by the hour

- **Rule:** a day use is a room for a block of 1 to 12 hours within one day, its room named, priced by the room type's day-use price for that many hours (refused with `data.reason` `no_day_use_rate` when it has none), with no extra bed, agreed rate or rate plan. It never shares its room's hours with a night stay (which holds its room from the check-in time on its arrival day to the check-out time on its departure day) or with another day use: checked by the server, and by the database when the work is saved, even for two saved at the same moment. It is billed at the slab its value would take for a night, and counts for no night of its room type's rooms. It keeps its day, hours, room and guests: to change them, it is cancelled and booked again.
- **Why:** a room is sold for a few hours' rest between journeys or for a meeting. No rule was found for the slab of a day use: it is billed as a night of that value would be, and an accountant's view is asked in [BACKLOG.md](BACKLOG.md#7-left-inside-built-modules).
- **Change it:** *Settings › Room types & rates › Day use* (`catalog.edit`).

### Check-in and check-out times

- **Rule:** the property's check-in time (12:00 to start with) and check-out time (11:00) are in the settings. A night stay holds its room from the check-in time on its arrival day to the check-out time on its departure day, on the business's clock. A check-in before the check-in time on the arrival day is early, and a check-out after the check-out time on the departure day is late: the stay's policy says what each costs.
- **Why:** no regulation fixes them: they are the property's policy.
- **Change it:** *Settings › Room types & rates*, *GST slabs, nights and times* (`settings.edit`).

### Policies worked out, not typed

- **Rule:** a policy is a property's, or the business's for every property; one of each is the default, and a rate plan may name its own. A stay keeps the policy it was booked under (its plan's, else its property's default, else the business's) as it then was, with whether its plan is refundable. From the stay's room nights' values (after the discount, before GST; meals and extras are not in them) the server works out an early check-in (before the check-in time on the arrival day) and a late check-out (after the check-out time on the departure day) as a percentage of that night's value, a flat fee or a full night, posted to the folio as the room type's item at that night's slab; a cancellation, free until so many hours before the arrival (the check-in time on the arrival day), then so many of the first nights or a percentage of the stay (under a plan that is not refundable, the full stay whenever it is cancelled); a no-show, the first night or the full stay (not refundable: the full stay); and a deposit, a percentage of the stay or the first night with its GST, due so many days before the arrival and shown on the stay with what is still short. Each charge is shown on the stay before it is made, and is waived only by a manager (`lodging.approve`: their own say-so, or another's with their PIN), with the reason, written to the stay's history and audited (`lodging_policy.waived`). A cancellation or no-show charge of a stay booked under a policy is the policy's: another amount typed is refused (409, `data.reason` `policy_charge`). A stay booked under no policy is charged nothing for an early check-in or a late check-out, and its cancellation charge is typed.
- **Why:** the property's terms are applied the same way to every guest, and only a manager lets one off. The GST of cancellation, no-show, early check-in and late check-out charges is not settled: each is billed as the room's nights at the slab of the night it attaches to (the first night for a cancellation or a no-show), and an accountant's view is asked in [BACKLOG.md](BACKLOG.md#7-left-inside-built-modules).
- **Change it:** *Settings › Room types & rates › Policies* (`settings.edit`); a plan's policy and whether it is refundable under *Rate plans* (`catalog.edit`).

### Group bookings

- **Rule:** a group booking (GB/2627/0001) is one booking of 2 to 50 rooms for a group or a company, billed to its organiser or the company (a customer of the business; a company with its GSTIN). Each room is a stay of its own, with its room type, plan, room (now or at check-in), guests and beds, arriving and leaving with the group or on its own dates, and checked as any reservation (the calendar, the rooms free). The rooming list names each reserved room's guest; until then it is the organiser. The rooms are checked in together or each on its own, every occupant recorded as at any check-in, and checked out together or each on its own. The kinds of charges the group routes to its folio (the room and its tax to start with) go there from every room; each room's own folio takes the rest and is billed at its check-out. The group's folio is billed once, with its own GST invoice to the organiser or company (its GSTIN on it), after every room has left (checked out or cancelled), paid first by what is left of the rooms' receipts its organiser paid. A group booking is never deleted: its rooms are cancelled one by one.
- **Why:** a wedding party, a tour or a company's team books many rooms at once; the company pays for the rooms and each guest for their own extras, and each buyer gets a tax invoice of their own.
- **Change it:** nothing to set; the series under *Settings › Number series* (*Group bookings*).

### Folios and routing

- **Rule:** a stay's main folio is billed to the company it is billed to, or to the guest. More folios may be opened while the stay is reserved or in the house, each with a name of its own (not *Main*) and billed to a customer of the business (a company with its GSTIN on the invoice); a group's stay may also send charges to its group's folio. Routing sends each kind of charge to a folio: the room (its nights, a day use, early check-in and late check-out, with their tax), meals, extras and goods; a kind not routed goes to the main folio. Changing a route moves that kind's charges not yet billed; one charge not yet billed may be moved while the guest is in the house; a cancellation charge stays the guest's. At check-out each folio is billed through the core as its own GST invoice (the stay's bill is the main folio's), paid by what is paid on it now and then by the stay's advances and deposits; a receipt settles only bills of the customer who paid it (the guest), so a guest's advance never pays the company's invoice, and what is left goes back. A folio billed stays as it was billed, and none is deleted.
- **Why:** a company often pays for the room and its tax while the guest pays for the meals and extras; each buyer is invoiced for what they pay for, with their own GSTIN.
- **Change it:** nothing to set; who opens folios and routes charges is `lodging.create`.

### Goods on the folio

- **Rule:** goods kept in stock by quantity (a minibar's drinks, toiletries; not kept by batch or serial number, not a kit) go on the folio while the guest is in the house, at their selling price (or one typed) and their own slab, never above their MRP. Posting is refused when the property's stock, less what is on folios not yet billed, is short ("Only 8 of … is in stock at this property"). They leave stock through the core when their folio is billed, not when posted.
- **Why:** goods sold to a guest are a sale like any other, at their goods slab, and the stock moves once, with the bill.
- **Change it:** the items, their prices, MRPs and slabs in the catalogue (`catalog.edit`).

### Occupants joining and leaving

- **Rule:** while a stay is in the house an occupant may join, recorded as at check-in (their photo ID; a foreigner's passport and visa), or leave partway, with a reason; each is kept for the register with when they came and left, and a foreigner's Form-III countdowns run from those times. The stay's adults and children are the occupants still in the room (the database checks it), never more than the room type takes, and an extra adult only at a night with an extra-adult rate; its nights still to post are priced for them, and those posted stay as they were. The last adult does not leave: the stay checks out instead.
- **Why:** the police register and Form-III ask for every person in a room and when they came and went, and the room is charged for those who stay each night.
- **Change it:** nothing to set; who records them is `lodging.create`.

### Guest profiles

- **Rule:** a guest's preferences (a quiet room, a high floor, a pillow) and the desk's notes are kept with their contact and shown on each of their stays; the profile also lists their past stays, without money for someone who does not see sales. They are personal data: in the guest's access export, and erased on request.
- **Why:** the desk greets a returning guest with what they asked for before.
- **Change it:** who saves a profile is `lodging.create`.

### Out of order ahead

- **Rule:** a room is put out of order for a period booked from today or ahead, with its reason, to a last night or until put back in order. Its nights are off sale: the room type's rooms on a night are those in use less those out of order that night, so a reservation that would need the room is refused with the reason (a reservation naming the room too), checked by the server and by the database when the work is saved, two saved at once included. A period is refused while a stay holds the room over its nights (move the stay first) or while the room type's stays on one of its nights would no longer fit; two periods of a room never cover the same night. It ends early (its last night last night) or, not begun, is withdrawn; the nights gone stay as they were; never deleted.
- **Why:** a room under repair cannot be sold, and selling it ahead would overbook the type; the reason tells the desk why a night is full.
- **Change it:** who books and ends periods is `lodging.edit` (housekeeping, the front desk, a cashier and a manager by default).

### Out of service

- **Rule:** a room out of service stays on sale and is let; it is flagged with why on the board, the calendar and the rooms offered at check-in. Taken off, the flag goes.
- **Why:** a small fault (a TV, a view) does not stop a room being sold, but the desk should know before giving it.
- **Change it:** who flags rooms is `lodging.edit`.

### Cleaning steps and inspection

- **Rule:** a room's cleanliness goes dirty → being cleaned (or straight to clean) → clean → inspected; any step goes back to dirty. Each step is kept with who took it and when, and the room keeps who cleaned it last and who inspected it last. A guest's room is cleaned while they stay (it stays occupied); no cleaning starts while its guest asked not to be disturbed (do not disturb, only on a guest's room, off at check-out). With *A room is inspected after it is cleaned, before it is let* set, a guest checks in or moves only to an inspected room (the database checks it too).
- **Why:** the facts of a front office: cleanliness is a state apart from occupancy, and a property may want a supervisor's check before a guest is given a room. No regulation applies to housekeeping.
- **Change it:** the inspection setting under *Settings › Room types & rates* (`settings.edit`); who takes the steps is `lodging.edit`.

### Linen and minibar checks

- **Rule:** each room type keeps a checklist of linen (named) and minibar items (goods kept in stock by quantity), each with how many a room holds; an item taken off is switched off, never deleted. A room's check counts every item on its type's list. A minibar item found below what the room holds is posted, for what was used, to the folio of the guest in the room as goods at the item's catalogue price and slab (the goods-on-the-folio path: it leaves stock when the folio is billed, and is refused beyond the stock at the property); with no guest in the room nothing is charged. Linen is recorded. A check is kept as written; retried with its key it charges nothing twice.
- **Why:** minibar consumption is charged to the guest's folio; the linen count shows what is missing.
- **Change it:** the checklists under *Settings › Room types & rates › Linen & minibar* (`catalog.edit`); who checks rooms is `lodging.edit`.

### Maintenance tickets

- **Rule:** a ticket names a room, the issue, a priority (urgent, high, normal, low) and, if given, a member of staff who looks after the rooms; it may book the out-of-order period the work needs (as [Out of order ahead](#out-of-order-ahead)). It goes open → in progress → done, or is cancelled with why while not done; the work's start and end are kept with who. Done or cancelled, the room's period ends last night (or is withdrawn if it had not begun) unless kept. Done or cancelled, a ticket no longer changes; never deleted. Tickets are listed open first, the most urgent first. *Tasks* still hold the rounds.
- **Why:** a room's repairs are tracked to the end, and the room goes back on sale when the work is done.
- **Change it:** who opens and closes tickets is `lodging.edit`.

### No-shows at the night audit

- **Rule:** with a *No-show cut-off* set, the night audit marks as a no-show every reservation not checked in by that time of its arrival day on the business's clock (or whose arrival day has passed): its charge worked out by the policy it was booked under (none under no policy) and billed as at [Cancellations and no-shows](#cancellations-and-no-shows), what is held paying first. Only someone who may cancel (and bill, when there is a charge) marks them; for anyone else the audit lists them. Run again, it marks nothing twice. With no cut-off, no-shows are marked by hand.
- **Why:** the night audit closes the day: a guest who did not come by the property's cut-off is a no-show, charged as their booking's policy says.
- **Change it:** the cut-off under *Settings › Room types & rates* (`settings.edit`); who marks them is `lodging.cancel`.

### Occupancy, ADR and RevPAR

- **Rule:** for dates on the business's calendar, at one property or every property: room nights available (each room in use, a night for each date from the day it was added, less its nights out of order), sold (the room nights posted and not voided; a day use is not a room night) and the room revenue (those nights' value before GST, after a stay's discount, without meals, extras, early check-in or late check-out). Occupancy is sold ÷ available, ADR revenue ÷ sold, RevPAR revenue ÷ available; each per property and in all, by room type (against that type's rooms), and by source (walk-in, phone, each OTA by its name) and rate plan (each against all the rooms available). A figure with nothing to divide by is left empty.
- **Why:** the house's usual measures, on the business's own dates.
- **Change it:** who sees them is `reports.view`.

### Rate plans per property

- **Rule:** a rate plan is shared by every property or kept for one; a stay takes a plan of its own property or a shared one (the database checks it too), and two plans of a room type share a name only at different properties. A plan made one property's while a stay at another is on it is refused.
- **Why:** a group of properties may sell one plan everywhere or price one property apart.
- **Change it:** the plans under *Settings › Room types & rates* (`catalog.edit`).

### A guest moved to another property

- **Rule:** a guest in the house moves to another property of the business from their second day: a check-out at the first property (every folio billed there with its own GST invoice, the place of supply that property's state, paid first by the stay's advances and deposits) and, in the same step, a reservation and check-in at the other for the same guest, party, source and company billed, arriving today on that property's rates and rooms, its occupants recorded again there; the two stays are linked. No late check-out or early check-in is charged for the move. What is left of the first stay's advances and deposits carries on and pays the new stay's bill. A move on the arrival day, of a day use or of a group's room is refused.
- **Why:** GST is per property (each its own GSTIN and state), so the folio is billed, not carried.
- **Change it:** who moves a guest is `lodging.create` with `sales.create`.

## Restaurant and food formats

### Advance on a pickup order

- **Rule:** a takeaway ordered ahead can take an advance from its order row (*Orders › More › Take advance…*) while it is open and not yet billed. It is an ordinary restaurant advance (receipt number, drawer, GST tables 11A and 11B) that remembers the order; an order without a guest gets the paying guest put on it. At billing, the bill offers that advance first and selects it for the amount due. A cancelled order's advance stays held and is handed back from *Dues & accounts › Advances* with a manager's say-so, like any advance.
- **Why:** the restaurant's advances already handle the money, the GST and the refund rules. Linking the advance to the order is all a pickup order needs.
- **Change it:** the *Advances* feature, and who holds `payments.manage` (who may take it).

### Formats: restaurant, café, bakery, cloud kitchen

- **Rule:** a restaurant is a restaurant, a café, a bakery or a cloud kitchen. The format sets the kinds of order the POS takes, the one a new order starts on, token numbers, and the features it starts with. A café starts on takeaway with tokens. A bakery takes takeaway and delivery, with recipes, advances and pre-orders, and no tables. A cloud kitchen starts on delivery, with online ordering, deliveries and brands, and no tables. The server refuses a kind of order the POS does not take. Each setting can be changed afterwards, and changing the format deletes nothing.
- **Change it:** the platform team picks the format when it creates the restaurant (*Platform › Restaurants*). Afterwards the owner changes it in *Settings › Features › Format*, and the kinds of order in *Service settings › Orders the POS takes*.

### Pre-orders

- **Rule:** a pre-order's advance is an ordinary customer advance, in the day's cash, so it needs *Advances & deposits*: while that is off, a pre-order is booked without one, and the server refuses an advance, on booking or later. When the till cannot take it (no business day open, or cash that would take the guest to the cash limit for the day), the pre-order is still booked and a warning says so; *Take advance* on the pre-order takes it later. On hand-over the pre-order becomes a takeaway order on today's business day, and its bill takes the advance first. A cancelled pre-order's advance stays held, to be handed back from *Dues & accounts › Advances*. The bake list adds up by item what is due on a day at one till: the pre-orders booked at that outlet, or, with no outlet picked, at the main counter, each with where it has got to. Staff tied to an outlet read their outlet's; anyone else picks whose (an outlet, or the main counter), else reads the outlet picked at the top, else the main counter's. Asked for without a date, it uses the day that till is trading on. The kitchen's own permission (`kds.view`) reads the bake list and nothing else of pre-orders. Moving a pre-order to *In production* and *Ready* is a permission of its own (`preorders.produce`), which every role that takes orders has and a kitchen role gets when the owner ticks it; handing it over and billing stay `orders.create`, cancelling `orders.manage`. Someone who moves one along without `orders.view` is told its number and status, not the guest's mobile or the money. Staff tied to an outlet see and act on that outlet's pre-orders only; everyone else sees every outlet's, whichever outlet is picked. An outlet with open pre-orders (booked, in production or ready) is neither closed nor deleted until they are handed over or cancelled: its *Remove* dialog lists them first, and a pre-order booked there at the moment it is closed is refused once the close is done (each holds the outlet while it decides). Switching *Pre-orders & cakes* off warns about the open ones, which are kept but hidden until it is switched back on.
- **Why:** an advance is spent on the bill (*From advance*) or handed back from *Dues & accounts › Advances*, and both need *Advances & deposits*: an advance taken while it is off could be neither. Each outlet's kitchen bakes what was booked at that outlet; another outlet's cakes are on that outlet's list, and a kitchen that bakes for several outlets reads each one's. The kitchen bakes from the list, but takes no orders and no money; the owner decides whose bakers mark their cakes ready. Staff tied to an outlet work at that outlet only, for pre-orders as for its bills and advances. A closed outlet's bake list is on no till, so its cakes would be baked nowhere, and a deleted outlet's pre-orders would fall to the main counter's list; a close and a booking at the same moment must not both pass.
- **Change it:** the *Pre-orders & cakes* feature; *Advances & deposits*, and who holds `payments.manage` (who may take the advance), `kds.view` (who reads the bake list) and `preorders.produce` (who moves pre-orders along: a copy of *Kitchen Staff* with it ticked, in *Users & access › Roles & permissions*); the outlet a person is tied to, in *Users*.

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

### The cash limit at a restaurant

- **Rule:** cash of ₹2,00,000 or more is never taken for one bill, or from one guest on one day of the restaurant's calendar, in its time zone. For one bill, the cash paid on it counts with any cash tip on top, because the tip is cash the guest hands over for that bill, and so does what the bill took from an advance the guest paid in cash. From one guest in a day, the cash paid on the bills that name them counts with their advances taken in cash. A bill names the guest or company whose account it is on, else the guest on its order, so cash collected on an account is the account's, and cash on delivery a rider brings in is the guest's on the order. Cash taken earlier counts once, on the day it was received: an advance used on a bill does not count again that day. One person is also known by their PAN: a walk-in bill (naming nobody) that carries the buyer's PAN adds up with every other walk-in bill carrying it that day and with the guests whose guest book holds that PAN (their bills and cash advances), and a guest's own day counts the walk-in bills under the PAN their guest book holds. A bill that names a guest counts as that guest's, whatever PAN is typed on it. A walk-in bill with no PAN is limited per bill only, and a split bill is limited bill by bill. The payment, the correction to cash, the collection, the rider's settlement or the advance that would reach the limit is refused, with what to do: take the rest by UPI, card, bank transfer or cheque. A correction is checked before a manager is asked for a PIN, and a pre-order is booked without an advance that is refused. The bill window shows how much more cash the bill, and its guest (or, for a walk-in, its PAN) today, can take. The database refuses a payment or an advance the same way, whatever writes it.
- **Why:** the Income-tax Act 2025, section 186 ([Cash of ₹2,00,000 or more](#cash-of-200000-or-more)). Banquets, parties and caterers make bills that size, and a buyer who splits a party over walk-in bills is still one person paying, known by the PAN they quote.
- **Change it:** only when the law changes: the database triggers `trg_payments_cash_limit` and `trg_customer_advances_cash_limit`.

### The buyer's PAN at a restaurant

- **Rule:** a bill over ₹2,00,000 takes no payment, at the till, from an advance, on an account or from a rider, until the buyer's PAN is on it, or their declaration that they have none (Form 97). The cashier types it on the payment screen, where it goes on the bill with the payment, or records it there on its own (*Record on the bill*), for a bill collected later on an account. The API also takes it when the bill is raised. A B2B bill whose buyer's GSTIN carries a PAN records that PAN with its first payment; failing that, a bill naming a guest whose guest book keeps a PAN records that PAN with its first payment, so the cashier does not type it again. The guest book keeps a guest's PAN, checked as a bill's is, or that they declared they have none; it shows in full only to staff who may see guests' contact details (`customers.contact`), its last four characters to everyone else, and every change is in the activity log, masked. A declaration of none in the guest book is not recorded on a bill by itself: the cashier is reminded to take one for that bill. A split bill is checked on each bill it becomes. The PAN, or the declaration, prints on the bill, can be changed until the bill is settled, and then stays as it was paid.
- **Why:** the income-tax rules make the buyer quote their PAN on a purchase over ₹2,00,000, and the restaurant must keep it ([PAN on a bill over ₹2,00,000](#pan-on-a-bill-over-200000)). A regular quotes it once; a declaration of none (Form 97) is made for each purchase. A PAN is personal data, kept only for these rules, and erased with the guest's details.
- **Change it:** a code change (the database trigger `trg_payments_buyer_pan`) when the rules change; a guest's PAN on their record in *Customers*.

### GST rates by date at a restaurant

- **Rule:** the same changes as a shop's ([GST rates by date](#gst-rates-by-date)) move dishes to another of the restaurant's tax rates, under *Menu › GST rate changes* (`menu.manage`), from a day on the restaurant's own clock: its trading day, so a night that runs past midnight stays on the old rate until its business day ends. A dish takes the rate in force on its order's business day, and the bill keeps it; a bill made before keeps its rates. A price that includes GST (the dish's own setting, or the restaurant's) keeps its total unless the change keeps the price before GST, which then moves the dish's price and its sizes' prices; add-ons, happy-hour prices and the prices set for an outlet, a channel or a kind of order keep theirs. An outlet still on the day before (its own business day not yet closed) prices its orders as before the change. The restaurant's default GST rate, which its advances' GST is worked out at, changes by date the same way ([GST rates kept in settings, by date](#gst-rates-kept-in-settings-by-date)). The dish's *GST history* (its *More actions* on *Menu › Products*) and the activity log keep each change with who entered it and why, so a dish a change has named is archived, not deleted. A tax rate dishes are to move to cannot be switched off until then.
- **Why:** the same yearly change; a restaurant's day is its trading day, not the calendar's.
- **Change it:** *Menu › GST rate changes*; a dish's rate from today, on the dish itself.

### The captain app follows the waiter's role

- **Rule:** the captain app (*Daily work › Captain app*, the address `/captain`) opens for anyone whose role takes orders (`orders.create`), as the POS does, and asks the server only for what that person may read: the tables' calls with `orders.view` (the bills captains asked for, and the guests' calls and QR orders while QR ordering is on); the food at the pass while the kitchen display is on, with `kot.manage` or `kds.view`. Its tables are the person's captain section of the day, or every table for someone with none, and *All tables* is one tap away. A table's running total shows only to someone who may see takings (`sales.view`). Orders are taken on the POS's own screen, by every rule of the POS. A bill is raised there only with `billing.manage`, in the POS's own bill window, and paid there only with `payments.manage`; a captain without them prints a bill the counter has raised (a second copy needs `bills.reprint` or a manager's PIN), and the money is taken at the counter. Such a captain asks the counter for a running table's bill in one tap (`orders.create`, with QR ordering on or off): the table's bill request, the same one a guest's *Request bill* makes, marked as asked by that captain; while it is open, a second ask is counted on it rather than made again (with QR ordering off, a guest's request still open from before takes the captain's name, so the counter sees it), and a table with no order running, or whose bill is raised already, is refused. Food is served from the pass with `kot.manage`, exactly as on the kitchen display, a whole ticket or one dish the kitchen ticked done on a ticket still cooking; serving the last dish serves the ticket.
- **Why:** the captain app is a phone layout over the restaurant's own screens, so a waiter does there exactly what their role allows on the POS, Table requests and the kitchen display, and nothing more. Money on the floor is for those who see takings, as on the dashboard. The bill ask goes where the counter already looks for a table's requests, Table requests, which the owner's rule gives every restaurant. A dish that is ready should not wait for its slowest neighbour on the ticket.
- **Change it:** the person's role (*Users & access › Roles & permissions*); their tables (*Tables & QR › Captain sections*); the *Captain sections*, *QR ordering* and *Kitchen display* features (*Settings › Features*).

### Table requests in every restaurant

- **Rule:** every restaurant has *Orders › Table requests*, for whoever may see orders (`orders.view`), and the POS's badges and the alerts bell count what is waiting there. It holds the bills captains ask for from the captain app whatever is switched on; while *QR table ordering* is on, the guests' orders and calls from the tables' QR codes too, and while the *Online ordering page* is on, its orders. Switched off, a place's requests leave the inbox, its counts and the bell, and come back when it is switched on; the guests' own part (accepting or rejecting an order, the QR ordering settings) answers only while one of them is on. The dashboard's *Table requests* block is there for whoever may see orders, whatever is switched on; with both off it, and the screen, show the waiters' asks alone, with no guests' order figures, *Orders* lane or *Kind* filter.
- **Why:** the owner's rule: a restaurant without QR ordering still has captains who ask the counter for a table's bill, and the counter must see it where it looks for a table's requests.
- **Change it:** *Settings › Features* (*QR table ordering*, *Online ordering page*); who sees orders, in the roles.

### Captain sections switched off

- **Rule:** while *Captain sections* is switched off, no table is anyone's: the POS, the captain app and Table requests show every table to every captain, with no *Your table* marks. The day's plans are kept, and count again when it is switched back on.
- **Why:** switching it off says so ("Every captain will see every table"), and a plan nobody can see or change should not decide whose tables are whose.
- **Change it:** *Settings › Features › Captain sections*.

### A later course waits until it is fired

- **Rule:** on the captain app, dishes added to a dine-in order go under a named course from the restaurant's list (*Service settings › Courses*: *Starters*, *Mains*, *Desserts* to start; course 1 is the first name). The first course goes to the kitchen when the order is sent, unless it is held; a later course is always held. Held dishes are saved on the order but not sent to the kitchen until someone presses *Fire* with the course's name on it, on the captain app or the POS. They then reach the kitchen as a round of their own, in the name of whoever fired them. The KOT and the kitchen display show the course's name the dish was sent under; renaming a course changes only what is sent after. Only an open order fires a course. The till itself sends every dish when the order is sent, under no course.
- **Why:** the captain at the table knows when the guests are ready for their mains; the kitchen should not start them with the starters.
- **Change it:** the courses' names under *Service settings › Courses* (one to six, `orders.manage`); the choice is made at the table, dish by dish.

### The kitchen's times, day by day and station by station

- **Rule:** the *Kitchen stations* report counts the tickets of the business days dated in its range (a night that runs past midnight stays on its day), at the outlet chosen. A ticket's time from sent to ready runs from the moment it was cut to the moment it was marked ready (a ticket cleared without ever being marked ready has none); from ready to served only for a ticket that waited at the pass, marked ready before someone served it. A ticket is late once it was marked ready after the kitchen's late minutes, is still not ready past them, or was cleared unready after sitting past them: the kitchen display's own rule, at the late minutes set now. The average and the 90th percentile (the time nine tickets in ten beat) are given for each station and the whole kitchen, with the busiest hours by when tickets were sent, on the restaurant's clock. Cancelled tickets are left out, and counted. An earlier day's tickets are read on the dashboard's kitchen panel, read only.
- **Why:** an average hides the slow tickets a guest remembers; the 90th percentile shows them. A ticket bumped straight to served never waited at the pass, and a cancelled one was never cooked, so neither should move the figures.
- **Change it:** the late minutes under *Stations & routing → Kitchen timers*.

### Alerts on the captain's phone

- **Rule:** a guest's call, a QR order or food at the pass at the tables shown reaches the captain app by itself within a second or two, with a message naming the table. The phone buzzes (where the browser can) and chimes only once the waiter has switched alerts on with the bell in the app's header, on that phone. Nothing rings for what was already waiting when the app opened.
- **Why:** a browser lets a page vibrate or play a sound only after a tap on it, and the waiter decides whether their phone may buzz.
- **Change it:** the bell in the captain app's header, phone by phone.

### Links to the guests' site

- **Rule:** every link to a guest's page starts at the restaurant's own guest web address when it has one, else at the guests' site's own address: the server's `GUEST_WEB_URL` for the links the server builds (the online booking link), the staff app's `VITE_CUSTOMER_WEB_URL` for those its screens build (table QR codes, *Open guest menu*, the online ordering link). No link names a host of its own. A live server does not start without a `GUEST_WEB_URL` that guests' phones can open: https, and not a local address.
- **Why:** a link that leads to the wrong site, or to a computer phones cannot reach, fails the guest at the table or at home.
- **Change it:** *Settings › Service settings › Guest ordering web address* for the restaurant; `GUEST_WEB_URL` on the server ([GO_LIVE.md](GO_LIVE.md)).
