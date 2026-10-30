// Restaurant navigation uses the same permissions and feature switches as before.
// Related tools live inside their operational area, rather than in the sidebar.
const AREAS = {
  overview: ['/'],
  pos: ['/pos'],
  // The captain app: its own screen with its own tabs (workspaces/captain).
  captain: ['/captain'],
  orders: ['/orders', '/collection', '/table-requests', '/deliveries'],
  // Food formats: a bakery's and café's cake and party orders.
  preorders: ['/preorders'],
  bills: ['/bills'],
  dues: ['/dues'],
  kitchen: ['/kitchen'],
  day: ['/business-day'],
  expenses: ['/expenses'],
  menu: ['/menu/products', '/menu/categories', '/menu/brands', '/menu/modifiers', '/menu/happy-hour', '/menu/tax-rates', '/menu/tax-changes'],
  tables: ['/tables', '/tables/floors'],
  reservations: ['/reservations'],
  inventory: ['/inventory/items', '/inventory/stock', '/inventory/insights', '/inventory/day-end', '/inventory/transfers', '/inventory/settings'],
  purchasing: ['/purchasing/orders', '/purchasing/suppliers', '/purchasing/accounts'],
  customers: ['/crm/customers', '/crm/feedback', '/crm/complaints', '/crm/insights'],
  staff: ['/staff', '/staff/shifts', '/staff/attendance', '/staff/timeclock', '/staff/payroll', '/staff/tips', '/my-work'],
  reports: ['/reports', '/activity-log', '/logbook'],
  settings: ['/restaurant/settings', '/restaurant/profile', '/restaurant/hours', '/restaurant/features', '/restaurant/outlets', '/service/settings', '/discounts', '/privacy', '/plan'],
  access: ['/users', '/roles'],
  // Tasks draws its own tabs (TasksNav); the menu opens the first page this person may use.
  tasks: ['/tasks', '/tasks/issues', '/tasks/projects', '/tasks/board', '/tasks/calendar', '/tasks/templates', '/tasks/recurring', '/tasks/reports'],
};
const LABELS = { menu:'Menu',inventory:'Stock',purchasing:'Purchases & suppliers',customers:'Customers',staff:'Staff',settings:'Settings',access:'Users & access',tasks:'Tasks' };
export function restaurantMenu(sections) {
  const links=sections.flatMap(group=>group.links);
  const groups=[{title:'Daily work',keys:['overview','pos','captain','orders','preorders','bills','dues','kitchen','expenses','day']},
    {title:'Operations',keys:['menu','tables','reservations','inventory','purchasing','customers','staff']},
    {title:'Management',keys:['reports','tasks','settings','access']}];
  const result=groups.map(group=>({title:group.title,links:group.keys.map(key=>{
    const related=AREAS[key].map(path=>links.find(link=>link.to===path)).filter(Boolean);
    if(!related.length)return null;
    return {...related[0],label:LABELS[key]||related[0].label,related};
  }).filter(Boolean)})).filter(group=>group.links.length);
  const platform=sections.find(group=>group.title==='Platform');
  if(platform)result.push(platform);
  return result;
}
export function restaurantRelated(sections,pathname) {
  const groups=sections.flatMap(group=>group.links).filter(link=>link.related?.length>1);
  const matches=groups.filter(link=>link.related.some(item=>pathname===item.to||item.to!=='/'&&pathname.startsWith(`${item.to}/`)));
  return matches.sort((a,b)=>Math.max(...b.related.filter(item=>pathname.startsWith(item.to)).map(item=>item.to.length))-Math.max(...a.related.filter(item=>pathname.startsWith(item.to)).map(item=>item.to.length)))[0]?.related||[];
}
