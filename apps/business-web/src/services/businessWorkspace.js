// Presentation groups share the existing route permissions and module guards.
// A capability being available does not make it a daily sidebar destination.
export const WORKSPACES = {
  pharmacyBilling: ['rx-sale','counter'],
  products: ['products', 'rates', 'variants', 'books', 'drug-master', 'salon-setup', 'categories', 'kits', 'labels', 'offers', 'pricing'],
  stock: ['stock', 'weight-stock', 'movements', 'counts', 'near-expiry', 'pharmacy-batches', 'transfers', 'serials', 'processing', 'wastage'],
  purchases: ['purchases', 'suppliers', 'purchase-orders', 'claims'],
  dues: ['udhaar', 'outstanding', 'collections'],
  customers: ['customers', 'loyalty'],
  sales: ['sales', 'exchanges', 'warranties', 'pickup-orders'],
  orders: ['sales-orders', 'back-orders', 'dispatch', 'price-groups', 'pricing', 'routes'],
  appointments: ['salon-calendar', 'appointments'],
  care: ['clinic-today', 'clinic-queue', 'visits', 'appointments', 'doctors'],
  patients: ['patients', 'customers'],
  laboratory: ['lab-orders', 'lab-tests', 'lab-qc'],
  reports: ['reports', 'retail-reports', 'wholesale-reports', 'variant-reports', 'weight-reports', 'salon-reports', 'commissions', 'activity'],
  settings: ['settings', 'tax-rates', 'payment-methods', 'number-series', 'locations', 'units', 'resources', 'health-settings'],
  staff: ['staff', 'roles'],
  money: ['day-close', 'expenses', 'emi-finance'],
  repairs: ['repairs', 'appointments'],
  packages: ['packages'],
  bookOrders: ['book-orders'],
  offers: ['offers'],
  // Tasks has its own tabs inside (TasksNav); the menu opens the first one this person may use.
  tasks: ['tasks', 'tasks/issues', 'tasks/projects', 'tasks/board', 'tasks/calendar', 'tasks/templates', 'tasks/recurring', 'tasks/reports'],
};

const GOODS = ['grocery', 'supermarket', 'fashion', 'electronics', 'pharmacy', 'books', 'meat', 'weight_retail'];
const WEIGHED = ['meat', 'weight_retail'];

export function workspaceFor(section, type) {
  if (section === 'appointments') return type === 'healthcare' ? 'care' : type === 'electronics' ? 'repairs' : 'appointments';
  if (section === 'pricing') return type === 'wholesale' ? 'orders' : 'products';
  if (section === 'customers' && type === 'healthcare') return 'patients';
  return Object.keys(WORKSPACES).find((key) => WORKSPACES[key].includes(section)) || null;
}

export function workspaceSections(key, type) {
  const list = WORKSPACES[key] || [];
  // Packaging, sizes, recipes, warranties and prescribing stay in their trades.
  return list.filter((section) => {
    // A wholesaler's price lists sit with its orders; any other shop that switches
    // the price lists on finds them with its products.
    if (section === 'pricing') return key === 'orders' ? type === 'wholesale' : type !== 'wholesale';
    if (section === 'kits') return ['electronics', 'fashion', 'books', 'supermarket'].includes(type);
    if (section === 'weight-stock') return WEIGHED.includes(type);
    if (section === 'processing') return WEIGHED.includes(type);
    if (section === 'wastage') return [...WEIGHED,'grocery','supermarket'].includes(type);
    if (section === 'pharmacy-batches' || section === 'drug-master') return type === 'pharmacy';
    if (section === 'near-expiry') return type !== 'pharmacy';
    // Weighed stock is checked on the weight screens, not by counting pieces.
    if (section === 'counts') return !WEIGHED.includes(type);
    if (section === 'salon-setup') return type === 'salon';
    if (section === 'appointments') return ['salon', 'healthcare', 'electronics'].includes(type);
    if (section === 'day-close' || section === 'expenses') return type !== 'restaurant';
    return true;
  });
}

export function workspaceLabel(section, type, fallback) {
  if (section === 'sales') return ['salon', 'healthcare'].includes(type) ? 'Bill history' : 'Sales history';
  if (section === 'collections') return 'Payments received';
  if (section === 'udhaar') return ['meat', 'grocery', 'weight_retail'].includes(type) ? 'Udhaar' : 'Customer dues';
  if (section === 'outstanding') return 'Customer dues';
  if (section === 'day-close') return 'Daily money';
  if (section === 'stock') return type === 'salon' ? 'Product stock' : 'Stock';
  if (section === 'processing') return type === 'weight_retail' ? 'Sorting & repacking' : 'Cutting & processing';
  if (section === 'weight-reports') return type === 'weight_retail' ? 'Repacking & wastage' : 'Cutting & wastage';
  if (section === 'salon-calendar') return 'Appointments';
  if (section === 'products' && type === 'healthcare') return 'Services & charges';
  if (section === 'settings') return 'Settings';
  if (section === 'staff') return 'Staff & access';
  return fallback;
}

// Each entry is a workspace: the first accessible page becomes its destination.
// This keeps accountant and stock-keeper menus usable without cashier access.
export function dailyWorkspaces(type) {
  const checkout = type === 'salon' ? 'salon-bill' : type === 'pharmacy' ? 'pharmacyBilling' : GOODS.includes(type) ? 'counter' : null;
  const daily = [checkout, type === 'healthcare' ? 'care' : null,
    type === 'wholesale' ? 'orders' : null, type === 'salon' ? 'appointments' : null,
    'sales', type === 'healthcare' ? 'patients' : 'customers', 'dues', 'money'].filter(Boolean);
  const business = ['products', 'purchases', 'stock'];
  if (type === 'pharmacy') business.push('pharmacy-registers');
  if (type === 'books') business.push('bookOrders');
  if (type === 'electronics') business.push('repairs');
  if (type === 'salon') business.push('packages');
  if (type === 'healthcare') business.push('laboratory');
  return [{ title: 'Daily work', keys: ['', ...daily] }, { title: 'Business', keys: business },
    { title: 'Management', keys: ['reports', 'tasks', 'settings', 'staff'] }];
}
