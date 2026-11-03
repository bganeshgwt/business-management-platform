import { GOODS, ONLINE_SHOP, SERVICES, WEIGHED } from './businessTypes.js';
import { makeTerms } from './terms.js';

// Presentation groups share the existing route permissions and module guards.
// A capability being available does not make it a daily sidebar destination.
export const WORKSPACES = {
  pharmacyBilling: ['rx-sale','counter'],
  // A rental business's products open on its rental items.
  products: ['rental-items', 'products', 'rates', 'variants', 'books', 'drug-master', 'salon-setup', 'categories', 'kits', 'labels', 'offers', 'pricing', 'laundry-prices', 'tax-changes', 'garage-parts'],
  // A jeweller's stock opens on its tagged pieces.
  stock: ['pieces', 'stock', 'weight-stock', 'movements', 'counts', 'near-expiry', 'pharmacy-batches', 'transfers', 'serials', 'processing', 'wastage', 'karigar-work', 'hallmarking', 'fine-weight', 'agri-seed-lots', 'agri-kept-apart', 'lens-stock'],
  purchases: ['purchases', 'suppliers', 'purchase-orders', 'claims', 'metal-account', 'agri-schemes'],
  dues: ['udhaar', 'outstanding', 'collections'],
  customers: ['customers', 'loyalty', 'sites', 'fitters', 'prescriptions', 'recall', 'contact-lenses', 'vehicles', 'service-due', 'fuel-fleet', 'laundry-packages'],
  sales: ['sales', 'quotations', 'tinting', 'exchanges', 'warranties', 'pickup-orders', 'custom-orders', 'approvals'],
  orders: ['sales-orders', 'back-orders', 'dispatch', 'price-groups', 'pricing', 'routes', 'field-sales'],
  appointments: ['salon-calendar', 'appointments', 'online-booking'],
  care: ['clinic-today', 'clinic-queue', 'visits', 'appointments', 'doctors', 'clinic-drugs', 'online-booking'],
  patients: ['patients', 'customers'],
  laboratory: ['lab-orders', 'lab-tests', 'lab-qc'],
  reports: ['reports', 'retail-reports', 'wholesale-reports', 'variant-reports', 'weight-reports', 'salon-reports', 'commissions', 'fitter-reports', 'cash-report', 'fuel-outlets', 'activity', 'referrals', 'mechanic-commission', 'member-pay', 'lodging-reports'],
  settings: ['settings', 'tax-rates', 'payment-methods', 'number-series', 'locations', 'units', 'resources', 'health-settings', 'licences', 'privacy', 'agri-settings', 'garage-settings', 'member-plans', 'jewellery-settings', 'scheme-plans', 'fuel-pumps', 'lodging-rates', 'plan', 'online-shop', 'tills'],
  // A seeds, fertilisers & pesticides shop's own area.
  farm: ['farmers', 'agri-subsidy', 'agri-registers', 'molecules', 'agri-seasons', 'agri-crops'],
  // An optical shop's spectacle orders, in its daily menu.
  spectacles: ['spectacle-orders'],
  // A garage's job cards, in its daily menu.
  jobCards: ['job-cards'],
  // A gym's, studio's or coaching centre's front desk, and its members (in place of customers).
  checkIn: ['check-in', 'member-classes'],
  members: ['members', 'renewals', 'customers', 'loyalty', 'member-leads'],
  // A laundry's counter (a new order taken in), and its orders with the racks, those not collected and the damage claims.
  laundryNew: ['laundry-new'],
  garmentOrders: ['garment-orders', 'ready-racks', 'unclaimed', 'laundry-claims'],
  // A jeweller's counter (the jewellery bill, with Quick bill beside it), and today's rates with the rate board.
  jewelleryBilling: ['jewellery-bill', 'counter'],
  goldRates: ['gold-rates', 'rate-board'],
  // Old gold bought from customers or taken in exchange, and gold schemes.
  oldGold: ['old-gold'],
  goldSchemes: ['gold-schemes'],
  // A rental business's bookings: the board, the availability week, the deposits held, the yard and fleet, the hirer register, use and earnings.
  rentalBookings: ['rental-bookings', 'rental-availability', 'rental-deposits', 'rental-yard', 'rental-register', 'rental-reports'],
  // A fuel station's shifts with its attendants' accounts, and its tanks with the morning dips, the tanker loads, the stock register and the records.
  fuelShifts: ['fuel-shifts', 'fuel-attendants'],
  fuelTanks: ['fuel-dips', 'fuel-receipts', 'fuel-register', 'fuel-records'],
  // A lodging business's front desk (with the rooms, the reservations calendar, every stay and the rooms' maintenance), and its foreign guests with the guest register.
  lodgingDesk: ['lodging-desk', 'lodging-rooms', 'lodging-reservations', 'lodging-stays', 'lodging-maintenance'],
  lodgingGuests: ['lodging-form-iii', 'lodging-register'],
  staff: ['staff', 'roles'],
  money: ['day-close', 'expenses', 'emi-finance', 'offline-bills'],
  repairs: ['repairs', 'appointments', 'online-booking'],
  packages: ['packages'],
  bookOrders: ['book-orders'],
  offers: ['offers'],
  // Tasks has its own tabs inside (TasksNav); the menu opens the first one this person may use.
  tasks: ['tasks', 'tasks/issues', 'tasks/projects', 'tasks/board', 'tasks/calendar', 'tasks/templates', 'tasks/recurring', 'tasks/reports'],
  // A shop's online orders from its shop link, in its daily menu while the online shop is on.
  onlineOrders: ['online-orders'],
};

// Businesses that book people's time (stylists, doctors, technicians, optometrists, mechanics, trainers).
const BOOKS_APPOINTMENTS = ['salon', 'healthcare', 'electronics', 'optical', 'garage', 'memberships'];

export function workspaceFor(section, type) {
  if (section === 'appointments' || section === 'online-booking') return type === 'healthcare' ? 'care' : type === 'electronics' ? 'repairs' : 'appointments';
  if (section === 'pricing') return type === 'wholesale' ? 'orders' : 'products';
  if (section === 'customers' && type === 'healthcare') return 'patients';
  if ((section === 'customers' || section === 'loyalty') && type === 'memberships') return 'members';
  return Object.keys(WORKSPACES).find((key) => WORKSPACES[key].includes(section)) || null;
}

export function workspaceSections(key, type) {
  const list = WORKSPACES[key] || [];
  // Packaging, sizes, recipes, warranties and prescribing stay in their trades.
  return list.filter((section) => {
    // A wholesaler's price lists sit with its orders; any other shop that switches
    // the price lists on finds them with its products.
    if (section === 'pricing') return key === 'orders' ? type === 'wholesale' : type !== 'wholesale';
    if (section === 'kits') return ['electronics', 'fashion', 'books', 'supermarket', 'general_retail', 'hardware', 'agri_inputs', 'garage'].includes(type);
    // Shelf and barcode labels are a goods shop's: a business that sells its
    // time and work (its new items start as services) keeps the page off its
    // menu, and reaches it from a goods receipt's "Print labels".
    if (section === 'labels') return !SERVICES.includes(type);
    if (section === 'weight-stock') return WEIGHED.includes(type);
    if (section === 'processing') return WEIGHED.includes(type);
    if (section === 'wastage') return [...WEIGHED,'grocery','supermarket','general_retail'].includes(type);
    if (section === 'pharmacy-batches' || section === 'drug-master') return type === 'pharmacy';
    if (section === 'near-expiry') return type !== 'pharmacy';
    // A jeweller's serial numbers are its tags, on Pieces & tags.
    if (section === 'serials') return type !== 'jewellery';
    // Weighed stock is checked on the weight screens, not by counting pieces.
    if (section === 'counts') return !WEIGHED.includes(type);
    if (section === 'salon-setup') return type === 'salon';
    if (section === 'appointments' || section === 'online-booking') return BOOKS_APPOINTMENTS.includes(type);
    // Routes and salespeople are a wholesaler's beat; a hardware shop's orders go to sites.
    if (section === 'routes') return type !== 'hardware';
    if (section === 'day-close' || section === 'expenses') return type !== 'restaurant';
    return true;
  });
}

// A page's name in the menu, the tabs and the page guard: the business's own
// word for it where it names its people, things or money (t: services/terms.js).
export function workspaceLabel(section, type, fallback, t = makeTerms()) {
  if (section === 'sales') return t.ex('phrase.sales_history') || fallback;
  if (section === 'collections') return t('collection', 'many');
  if (section === 'udhaar' || section === 'outstanding') return t('dues_list', 'many');
  if (section === 'day-close') return 'Daily money';
  if (section === 'stock') return t.ex('phrase.stock') || fallback;
  if (section === 'processing') return t('processing', 'many');
  if (section === 'weight-reports') return t.ex('phrase.processing_report') || fallback;
  if (section === 'salon-calendar') return t('appointment', 'many');
  if (section === 'settings') return 'Settings';
  if (section === 'staff') return 'Staff & access';
  return fallback;
}

// Each entry is a workspace: the first accessible page becomes its destination.
// This keeps accountant and stock-keeper menus usable without cashier access.
export function dailyWorkspaces(type) {
  const checkout = type === 'salon' ? 'salon-bill' : type === 'pharmacy' ? 'pharmacyBilling' : type === 'jewellery' ? 'jewelleryBilling' : GOODS.includes(type) ? 'counter' : null;
  // Orders: a wholesaler's beat orders, or a hardware shop's site orders (with Sales orders on).
  const daily = [checkout, type === 'memberships' ? 'checkIn' : null, type === 'laundry' ? 'laundryNew' : null, type === 'laundry' ? 'garmentOrders' : null,
    type === 'jewellery' ? 'goldRates' : null, type === 'jewellery' ? 'oldGold' : null, type === 'jewellery' ? 'goldSchemes' : null,
    type === 'rentals' ? 'rentalBookings' : null,
    type === 'fuel_station' ? 'fuelShifts' : null, type === 'fuel_station' ? 'fuelTanks' : null,
    type === 'lodging' ? 'lodgingDesk' : null, type === 'lodging' ? 'lodgingGuests' : null,
    // A clinic's two workspaces (screens of their own: /clinic and /lab), then its day in Business Admin.
    type === 'healthcare' ? 'clinic-workspace' : null, type === 'healthcare' ? 'lab-workspace' : null,
    type === 'healthcare' ? 'care' : null,
    // A wholesaler's salesperson app (a screen of its own: /sales), then its orders.
    type === 'wholesale' ? 'salesperson-app' : null,
    ['wholesale', 'hardware'].includes(type) ? 'orders' : null,
    ['salon', 'optical', 'garage', 'memberships'].includes(type) ? 'appointments' : null,
    type === 'optical' ? 'spectacles' : null,
    type === 'garage' ? 'jobCards' : null,
    ONLINE_SHOP.includes(type) ? 'onlineOrders' : null,
    'sales', type === 'healthcare' ? 'patients' : type === 'memberships' ? 'members' : 'customers', 'dues', 'money'].filter(Boolean);
  const business = ['products', 'purchases', 'stock'];
  if (type === 'pharmacy') business.push('pharmacy-registers');
  if (type === 'books') business.push('bookOrders');
  if (type === 'electronics') business.push('repairs');
  if (type === 'salon') business.push('packages');
  if (type === 'healthcare') business.push('laboratory');
  if (type === 'agri_inputs') business.push('farm');
  return [{ title: 'Daily work', keys: ['', ...daily] }, { title: 'Business', keys: business },
    { title: 'Management', keys: ['reports', 'tasks', 'settings', 'staff'] }];
}
