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
| Restaurant Core | 4 | Restaurant settings, business day, users, roles, permissions | Not started |
| Menu & Tables | 5–7 | Categories, products, pricing, modifiers, tables, QR, availability | Not started |
| Orders & POS | 8–10 | Orders, POS, billing, payments, discounts, refunds | Not started |
| Captain & Kitchen | 11–12 | Captain, KOT, KDS, kitchen stations, status | Not started |
| Inventory | 13–14 | Items, stock, issue, transfer, consumption, low stock, wastage | Not started |
| Purchasing | 15–16 | Suppliers, purchase orders, receiving, returns | Not started |
| CRM | 17–18 | Customers, loyalty, feedback, complaints | Not started |
| Online Ordering | 19–20 | Customer website, cart, QR ordering, payment, tracking | Not started |
| Delivery | 21–22 | Delivery management, partner integration, settlement | Not started |
| Operations | 23–25 | Staff, shifts, expenses, notifications, hardware | Not started |
| Reports | 26 | Sales, payment, inventory, kitchen, customer and operations reports | Not started |
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
