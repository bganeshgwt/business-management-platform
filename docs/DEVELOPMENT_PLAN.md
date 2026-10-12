> Historical status: see [current verification and remaining scope](VERIFICATION.md) for checks performed on 29 September 2026. Counts and pending labels below may be outdated.

# Development plan

Taken from the source documents in [`reference/`](reference):

- `Restaurant_Management_Simple_Database_Module_Development_Plan.docx`
- `Restaurant_Management_Platform_Documentation.pdf`

This file tracks what is planned and what is done. Update the status column as
work completes.

## Platform model

```
Platform Admin → Restaurants → Subscription → Applications → Modules → Users → Roles → Permissions
Restaurant → Outlet (future) → Menu / Tables / Orders / Inventory / Customers / Staff / Reports
```

Each restaurant subscribes to the applications and modules it needs. Users only
see what their roles allow.

## Sprint plan

| Phase | Sprint | Work | Status |
| --- | --- | --- | --- |
| Foundation | 1 | React/Vite setup, Express, PostgreSQL, authentication, base structure | **Done** |
| SaaS Platform | 2–3 | Restaurants, plans, subscriptions, applications, modules, platform admin | Not started |
| Restaurant Core | 4 | Restaurant settings, business day, users, roles, permissions | **Done** (business day pending) |
| Menu & Tables | 5–7 | Categories, products, pricing, modifiers, tables, QR, availability | **Done**, including tax rates with HSN codes, combos, happy-hour pricing and CSV import/export. Per-outlet pricing and product images pending |
| Orders & POS | 8–10 | Orders, POS, billing, payments, discounts, refunds | **Done**, including split bills, per-item cancellation and bill reprint |
| Captain & Kitchen | 11–12 | Captain, KOT, KDS, kitchen stations, status | Not started |
| Inventory | 13–14 | Items, stock, issue, transfer, consumption, low stock, wastage | **Done**, including recipe-based automatic consumption |
| Purchasing | 15–16 | Suppliers, purchase orders, receiving, returns | **Done**, including returns, supplier payments and outstanding balances |
| CRM | 17–18 | Customers, loyalty, feedback, complaints | **Done**: customers with visit history, loyalty earning/redemption/adjustment, feedback, complaints |
| Online Ordering | 19–20 | Customer website, cart, QR ordering, payment, tracking | Not started |
| Delivery | 21–22 | Delivery management, partner integration, settlement | Not started |
| Operations | 23–25 | Staff, shifts, expenses, notifications, hardware | **Done**: staff, shifts, roster, attendance, payroll summary and expenses. Notifications and hardware pending |
| Reports | 26 | Sales, payment, inventory, kitchen, customer and operations reports | **Done** for sales, tax, items, staff, discounts, consumption and day-end |
| Integrations | 27 | Payment gateway, maps, messaging, partner APIs | Not started |
| Testing | 28–29 | Functional, permissions, integration, performance, security | Not started |
| Pilot & Release | 30–31 | Pilot restaurant, fixes, production setup, release | Not started |

## Sprint 1 (Foundation) — what was delivered

| Item | Where |
| --- | --- |
| Migration tooling (SQL files, up/down) | `backend/scripts/migrate.js`, `backend/migrations/` |
| `restaurants`, `outlets` tables | Migration 1 |
| `users`, `roles`, `permissions`, `user_roles`, `role_permissions` | Migration 2 |
| 21 permissions and 6 system roles seeded | Migration 3 |
| Layered backend (routes → controllers → services → repositories) | `backend/src/` |
| Startup database check, 404 and error handlers | `server.js`, `middlewares/` |
| Login API with bcrypt + JWT, rate limited | `POST /api/auth/login` |
| Auth and permission middleware, tenant scoping | `middlewares/authenticate.js`, `authorize.js` |
| User creation script | `npm run user:create` |
| React router, auth context, login page, protected layout | `frontend/src/` |

### Not yet done from Sprint 1

- No refresh token; sessions end after 8 hours
- No `audit_logs` table
- No automated tests (Jest + Supertest recommended before Sprint 8)
- Token stored in `localStorage`; revisit before production

## Admin Web — what was delivered

| Area | Screens | API |
| --- | --- | --- |
| Restaurant | Profile, Outlets, Business hours, Settings | `/api/restaurants/current*`, `/api/outlets` |
| Users & access | Users (add, edit, reset password), Roles & permissions (custom roles) | `/api/users`, `/api/roles` |
| Menu | Categories, Products (price, tax, food type, availability, filters), Modifiers, per-product sizes and add-ons | `/api/menu/*` |
| Tables | Floors & areas, Tables with printable QR codes | `/api/tables/*` |
| Inventory | Items & stock (units, stock in/out, wastage, low-stock alerts), Stock movements ledger | `/api/inventory/*` |
| Purchasing | Suppliers, Purchase orders (draft → ordered → receive → stock) | `/api/suppliers`, `/api/purchase-orders` |
| Customers | Customers, Feedback (with rating summary), Complaints (assign and resolve) | `/api/crm/*` |
| Operations | Business day, Discounts & offers, Expenses (record and approve) | `/api/business-day`, `/api/discounts`, `/api/expenses` |
| Service (POS) | POS screen, Orders list, Bills & payments with day summary | `/api/orders`, `/api/bills` |
| Reports | Sales, item & category, tax/GST, discounts, staff, cancellations, stock consumption, day end — with CSV export | `/api/reports/*` |
| Menu | Recipes with food cost and margin per dish | `/api/menu/products/:id/recipe` |
| Audit | Activity log of cancellations, voids, refunds, approvals and changes | `/api/reports/audit-log` |
| Staff | Employees, shifts, weekly roster, attendance with auto-calculated hours, payroll summary | `/api/staff/*` |

Tables added in migrations 4–13: `restaurant_settings`, `business_hours`,
`categories`, `products`, `floors`, `dining_areas`, `dining_tables`,
`product_variants`, `modifiers`, `product_modifiers`, `discounts`,
`business_days`, `suppliers`, `units`, `inventory_items`, `stock_transactions`,
`purchase_orders`, `purchase_order_items`, `customers`, `feedback`,
`complaints`, `expense_categories`, `expenses`, `orders`, `order_items`,
`order_item_modifiers`, `bills`, `payments`, `refunds` — 37 tables in total.
Permissions grew from 21 to 37.

Navigation is permission-aware: a link only appears if the user's role grants the
matching permission, and the API enforces the same permission again.

### Closed since (migrations 17–19)

- **Split bills** and bill reprint counts — `bill_items` holds how much of each
  order line sits on each bill, so an order can be billed in parts and each
  portion consumes its ingredients exactly once
- **Per-item order edits** — a line can be cancelled while the order is open,
  unless it is already on a live bill
- **Purchase returns**, supplier payments and supplier outstanding balances
- **Two-sided stock transfers** and per-outlet `stock_balances`
- **Loyalty**: points earned when a bill is paid, spent when the next bill is
  raised, adjusted by hand, with a full ledger per guest
- **Orders linked to saved customers** — the POS has a guest picker, so history
  and points attach to the right person
- **Voiding a bill reverses it** — redeemed points return and, when the bill
  consumed stock, the ingredients go back

### Closed since (migrations 20–22)

- **Tax rates with HSN/SAC codes** — a named rate holds the percentage and the
  code; changing it reprices every dish that uses it, and the GST report is
  grouped HSN-wise the way a GSTR-1 summary is filed
- **Combos** — a thali sells as one line at a set price and consumes its parts'
  recipes out of stock
- **Happy hour and timed prices** — a window replaces the menu price on chosen
  days and hours, judged in the restaurant's own timezone, and the POS shows the
  price it will actually charge
- **Bulk menu import and export** — a CSV round trip, validated whole before
  anything is written

### Closed since (migrations 23–24)

- **Product photos** — uploaded, checked by their bytes, served as static files,
  shown on the POS grid and the product list
- **A profile page** — anyone can change their own name, mobile and password,
  proving the current password first
- **An outlet switcher**, with the outlet settled by the server rather than
  taken from the request body; a tenancy hole in stock transfers was closed at
  the same time
- **Printer settings** — paper width, copies, a bill header, auto-print on
  settle, and the QR on the receipt
- **Audit-log coverage** across the remaining write endpoints: inventory,
  suppliers, tables, floors, areas, roles, outlets, variants, modifiers,
  recipes and purchase orders

### Still pending in these modules

- Per-outlet **pricing** (the switcher and per-outlet stock are done)
- QR ordering itself: the codes are printed, but the customer page arrives in Sprint 20
- KOT tickets and the kitchen display (Sprint 11–12); orders already carry a kitchen status
- Kitchen-station and customer reports (the rest of Sprint 26)
- Multi-outlet consolidated reporting
- Notifications (email/SMS/WhatsApp)
- Direct thermal-printer and cash-drawer control, which a browser cannot do
  without a local print agent

## Module list and dependencies

| Module | Sub-modules | Depends on |
| --- | --- | --- |
| Restaurant Management | Profile, outlet, business hours, settings, business day | — |
| Subscription & Plans | Plans, subscriptions, applications, modules, limits, renewal | Restaurants |
| User & Role Management | Users, roles, permissions, approvals, audit | Restaurants |
| Menu Management | Categories, products, variants, modifiers, combos, pricing, tax, availability | Restaurant, Tax |
| Table Management | Floors, areas, tables, capacity, QR, table status | Restaurant, Outlets |
| Reservation & Booking | Availability, reservation, guests, advance payment, cancellation, no-show | Tables, Customers |
| Order Management | Dine-in, takeaway, QR, website, delivery, source, status | Menu, Tables |
| POS & Billing | POS, bills, invoices, split bill, discounts, cancellation, reprint | Orders, Tax |
| Payment Management | Cash, card, UPI/online, payment status, refund | Billing |
| Captain / Waiter | Table selection, order taking, confirmation, KOT submission | Tables, Menu, Orders, KOT |
| KOT | KOT creation, items, priority, status, reprint | Orders, Menu, Kitchen |
| KDS / Kitchen | Stations, new, preparing, ready, completed, delay | KOT, Kitchen |
| Inventory | Items, units, stock, issue, transfer, adjustment, consumption, low stock | Inventory items, Menu/Recipe |
| Purchasing | Request, PO, items, receiving, purchase return | Suppliers, Inventory |
| Supplier Management | Profile, items, pricing, purchase history, returns | — |
| Wastage | Entry, reason, quantity, stock impact | Inventory |
| Customer / CRM | Profile, guest customer, order history, segmentation, feedback | Customers, Orders |
| Loyalty & Rewards | Points, rewards, redemption, history | CRM |
| Feedback & Complaints | Feedback, complaints, assignment, status, resolution | CRM |
| Staff & Shifts | Employees, roles, shifts, opening/closing cash, reconciliation | Users |
| Expenses | Categories, expenses, approval, history | Restaurant |
| Tax Management | Tax rates, categories, product/invoice tax, reports | Restaurant |
| Discount & Offers | Offers, coupons, rules, limits, approval | Menu, Billing |
| Online Ordering | Website menu, cart, online order, payment, tracking | Menu, Orders, Payment |
| QR Ordering | Table QR, menu, cart, order, payment/pay at counter | Tables, Menu, Orders |
| Delivery Management | Assignment, pickup, out-for-delivery, delivered | Orders |
| Delivery Integrations | Swiggy, Zomato, menu/order/status sync | Delivery, Menu, Orders |
| Settlement & Reconciliation | Gross sales, commission, tax, adjustments, settlement | Delivery, Payments |
| Notifications | Customer, kitchen, staff and admin notifications | Orders |
| Reports & Analytics | Sales, payments, products, kitchen, inventory, customers, staff | All transactional modules |
| Hardware | POS, receipt printer, KOT printer, KDS, cash drawer, QR | POS, KOT, KDS |
| Integrations | Payment gateway, maps, SMS/email/WhatsApp, partner APIs | Payments, Notifications |

## Business flows

**Order**
```
Customer/Staff → Order → KOT → KDS → Prepare → Serve/Pack → Bill → Payment → Complete
```

**Purchase**
```
Purchase Request → PO → Supplier → Goods Receipt → Stock Increase
```

**Inventory**
```
Store Stock → Kitchen Issue → Kitchen Stock → Consumption → Stock Reduction
```

**Reservation**
```
Date/Time → Availability → Table → Advance Payment → Confirmation → Arrival → Completion
```

**Delivery**
```
Order → Partner → Pickup → Out for Delivery → Delivered → Settlement
```

## Suggested next step

The plan puts the SaaS subscription layer in Sprints 2–3, before the restaurant
features. An alternative is to build a working POS first (Sprints 4–10: settings,
users, menu, tables, orders, billing, payments) and add subscriptions afterwards.
That produces something a real restaurant can use sooner, and the subscription
layer only gates access to what already exists.

Either way, **Sprint 4 (users, roles, permissions APIs and screens)** is the
natural next piece, because the tables already exist and users can currently only
be created from the terminal.
