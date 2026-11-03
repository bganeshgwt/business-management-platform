// The built-in template library: read-only, versioned with the app, the same
// for every business, read in each business's own words. A business "uses" a
// template (a task is made from it, the items copied) or copies it into its
// own templates to change it.
//
// A template's text names the business's people, places and things by a
// placeholder: {customer} "member", {customers} "members", {counter} "front
// desk", {items} "plans & services", {location} "branch", {dues} "fees",
// capitalised as written ({Counter} "Front desk"). `modules`: the template
// shows only to a business using one of them (a stock check where stock is
// kept).

const { parseItems } = require("./parse");

const RAW = [...require("./common"), ...require("./restaurant"), ...require("./retail"), ...require("./trade"), ...require("./shops-and-services")];

const ALL_TYPES = ["restaurant", "grocery", "supermarket", "wholesale", "fashion", "electronics", "pharmacy", "books", "salon", "healthcare", "meat", "weight_retail",
  "general_retail", "hardware", "agri_inputs", "optical", "garage", "jewellery", "fuel_station", "memberships", "laundry", "rentals", "lodging"];

// The words a placeholder names: the key of the business's words and its form.
const PLACEHOLDERS = { customer: ["customer", "one"], customers: ["customer", "many"], counter: ["counter", "one"], items: ["item", "many"],
  location: ["location", "one"], dues: ["dues", "one"] };
// Text with its placeholders in the business's words (t: utils/words.js terms).
const inWords = (text, t) => (typeof text !== "string" || !text.includes("{") ? text : text.replace(/\{([A-Za-z]+)\}/g, (match, name) => {
  const word = PLACEHOLDERS[name.toLowerCase()];
  if (!word) return match;
  return /^[A-Z]/.test(name) ? t(word[0], word[1]) : t.lower(word[0], word[1]);
}));
const itemsInWords = (items, t) => items.map((item) => ({ ...item, label: inWords(item.label, t), help: inWords(item.help, t), unit: inWords(item.unit, t),
  options: item.options ? item.options.map((option) => ({ ...option, label: inWords(option.label, t) })) : item.options }));
// Whether a business with these modules sees a template (has: scope.has).
const shownTo = (template, has) => !template.modules || template.modules.some((module) => has(module));

const TEMPLATES = RAW.map((raw) => ({
  code: raw.code,
  name: raw.name,
  description: raw.description || null,
  category: raw.category,
  types: raw.types === "*" ? ALL_TYPES : raw.types,
  modules: raw.modules || null,
  common: raw.types === "*",
  priority: raw.priority || "normal",
  requiresReview: Boolean(raw.review),
  estimatedMinutes: raw.minutes || null,
  // What it is usually set to repeat as (a suggestion for "Make it recurring").
  suggested: raw.frequency ? {
    frequency: raw.frequency, times: raw.times || ["18:00"], weekdays: raw.weekdays || null,
    monthDay: raw.monthDay || null, everyN: raw.everyN || null, windowMinutes: raw.window || null,
  } : null,
  items: parseItems(raw.items),
}));

const byCode = new Map(TEMPLATES.map((t) => [t.code, t]));

// Project templates: milestones (days after the start), task lists and their tasks.
const PROJECT_TEMPLATES = [
  {
    code: "project.new_outlet", name: "New {location} opening", category: "project_management", days: 60,
    description: "From signing the lease to the opening day.",
    milestones: [["Lease signed and licences applied", 7], ["Fit-out complete", 35], ["Staff hired and trained", 50], ["Opening day", 60]],
    lists: {
      "Licences & legal": ["Rent agreement registered", "FSSAI / drug / trade licence applied", "GST address added", "Shops & establishment registration", "Fire NOC (if needed)"],
      "Fit-out": ["Layout finalised", "Electrical and plumbing done", "Furniture and racks installed", "Signboard put up", "CCTV and internet installed"],
      "Systems": ["{Location} added in the app", "{Counter}, billing and printer set up", "Prices and stock moved in"],
      "People": ["Staff hiring drive", "Induction and training", "Uniforms ordered"],
      "Launch": ["Opening offer decided", "Local promotion / pamphlets", "Puja and opening arrangements"],
    },
  },
  {
    code: "project.festival_sale", name: "Festival offers set-up", category: "marketing", days: 21,
    description: "Diwali, Pongal, Onam, Eid or the year end.",
    milestones: [["Offers finalised", 5], ["Supplies in", 14], ["Offers start", 21]],
    lists: {
      "Planning": ["Last year's festival takings reviewed", "Offers and combos decided", "Budget agreed"],
      "Supplies": ["Extra stock or supplies ordered", "Gift packs / hampers prepared (where sold)", "Space made for the rush"],
      "Display": ["Decoration and lights", "Posters and standees", "Offer prices entered in the app"],
      "{Customers}": ["WhatsApp broadcast to regular {customers}", "Instagram / Google Business post", "Extra staff for the rush days"],
    },
  },
  {
    code: "project.annual_audit", name: "Annual stock audit", category: "stock_check", days: 10, modules: ["inventory", "stock_recipes"],
    description: "The year-end physical stock count and reconciliation for the books.",
    milestones: [["Count sheets ready", 2], ["Physical count done", 6], ["Differences reconciled", 9], ["Signed off by the accountant", 10]],
    lists: {
      "Prepare": ["Audit date told to staff and suppliers", "Damaged and expired stock separated", "Stock count started in the app"],
      "Count": ["Count by rack / section", "Re-count of high-value items", "Godown / back store counted"],
      "Close": ["Differences explained", "Adjustments posted", "Stock statement given to the accountant"],
    },
  },
  {
    code: "project.renovation", name: "Renovation", category: "maintenance", days: 30,
    milestones: [["Contractor fixed", 5], ["Work complete", 25], ["Reopened", 30]],
    lists: {
      "Plan": ["Quotes from 3 contractors", "Design and colours agreed", "{Customers} told about the closure dates"],
      "Work": ["Old fixtures removed", "Civil and painting work", "Electrical work", "Cleaning after work"],
      "Reopen": ["Everything moved back and arranged", "Reopening offer"],
    },
  },
  {
    code: "project.hiring_drive", name: "Staff hiring drive", category: "hiring", days: 21,
    milestones: [["Job posted", 2], ["Interviews done", 12], ["Joined", 21]],
    lists: {
      "Source": ["Job description written", "Posted on WhatsApp groups / job apps", "Referral bonus announced"],
      "Select": ["Phone screening", "Interviews (use the interview template)", "Offer and salary agreed"],
      "Join": ["Documents collected", "Induction (use the induction template)", "Login created in the app"],
    },
  },
  {
    code: "project.range_launch", name: "Launch of new {items}", category: "marketing", days: 30,
    milestones: [["Range decided", 7], ["Trials done", 18], ["Launched", 30]],
    lists: {
      "Develop": ["{Items} and suppliers shortlisted", "Costing and selling price", "Trials / samples"],
      "Set up": ["{Items} added in the app with tax and HSN or SAC", "Photos taken", "Staff briefed"],
      "Launch": ["Launch offer", "Social media and WhatsApp post", "Feedback after 2 weeks"],
    },
  },
];

const projectByCode = new Map(PROJECT_TEMPLATES.map((t) => [t.code, t]));

// A template, or a project template, as a business reads it (t: its words).
const templateIn = (template, t) => ({ ...template, name: inWords(template.name, t), description: inWords(template.description, t), items: itemsInWords(template.items, t) });
const projectIn = (template, t) => ({ ...template, name: inWords(template.name, t), description: inWords(template.description, t),
  milestones: template.milestones.map(([name, days]) => [inWords(name, t), days]),
  lists: Object.fromEntries(Object.entries(template.lists).map(([name, tasks]) => [inWords(name, t), tasks.map((task) => inWords(task, t))])) });

// The templates a business sees (its type's own first), in its words. `scope`:
// { businessType, t (its words), has(module) }.
const forType = (scope) => TEMPLATES.filter((t) => t.types.includes(scope.businessType) && shownTo(t, scope.has))
  .sort((a, b) => Number(a.common) - Number(b.common)).map((t) => templateIn(t, scope.t));
// One template, whether this business sees it, in its words; null for none.
const get = (code, scope) => {
  const template = byCode.get(code);
  return template && template.types.includes(scope.businessType) && shownTo(template, scope.has) ? templateIn(template, scope.t) : null;
};
const projects = (scope) => PROJECT_TEMPLATES.filter((t) => shownTo(t, scope.has)).map((t) => projectIn(t, scope.t));
const getProject = (code, scope) => {
  const template = projectByCode.get(code);
  return template && shownTo(template, scope.has) ? projectIn(template, scope.t) : null;
};

module.exports = { PROJECT_TEMPLATES, forType, get, projects, getProject, inWords };
