// The built-in template library: read-only, versioned with the app, the same
// for every business. A business "uses" a template (a task is made from it,
// the items copied) or copies it into its own templates to change it.

const { parseItems } = require("./parse");

const RAW = [...require("./common"), ...require("./restaurant"), ...require("./retail"), ...require("./trade")];

const ALL_TYPES = ["restaurant", "grocery", "supermarket", "wholesale", "fashion", "electronics", "pharmacy", "books", "salon", "healthcare", "meat", "weight_retail"];

const TEMPLATES = RAW.map((raw) => ({
  code: raw.code,
  name: raw.name,
  description: raw.description || null,
  category: raw.category,
  types: raw.types === "*" ? ALL_TYPES : raw.types,
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
    code: "project.new_outlet", name: "New outlet opening", category: "project_management", days: 60,
    description: "From signing the lease to the opening day.",
    milestones: [["Lease signed and licences applied", 7], ["Fit-out complete", 35], ["Staff hired and trained", 50], ["Opening day", 60]],
    lists: {
      "Licences & legal": ["Rent agreement registered", "FSSAI / drug / trade licence applied", "GST address added", "Shops & establishment registration", "Fire NOC (if needed)"],
      "Fit-out": ["Layout finalised", "Electrical and plumbing done", "Furniture and racks installed", "Signboard put up", "CCTV and internet installed"],
      "Systems": ["Outlet / location added in the app", "Billing counter and printer set up", "Prices and stock moved in"],
      "People": ["Staff hiring drive", "Induction and training", "Uniforms ordered"],
      "Launch": ["Opening offer decided", "Local promotion / pamphlets", "Puja and opening arrangements"],
    },
  },
  {
    code: "project.festival_sale", name: "Festival sale set-up", category: "marketing", days: 21,
    description: "Diwali, Pongal, Onam, Eid or a year-end sale.",
    milestones: [["Offers finalised", 5], ["Stock in", 14], ["Sale starts", 21]],
    lists: {
      "Planning": ["Last year's festival sales reviewed", "Offers and combos decided", "Budget agreed"],
      "Stock": ["Extra stock ordered from suppliers", "Gift packs / hampers prepared", "Storage space made"],
      "Shop": ["Decoration and lights", "Posters and standees", "Offer prices entered in the app"],
      "Customers": ["WhatsApp broadcast to regular customers", "Instagram / Google Business post", "Extra staff for the rush days"],
    },
  },
  {
    code: "project.annual_audit", name: "Annual stock audit", category: "stock_check", days: 10,
    description: "The year-end physical stock count and reconciliation for the books.",
    milestones: [["Count sheets ready", 2], ["Physical count done", 6], ["Differences reconciled", 9], ["Signed off by the accountant", 10]],
    lists: {
      "Prepare": ["Audit date told to staff and suppliers", "Damaged and expired stock separated", "Stock count started in the app"],
      "Count": ["Count by rack / section", "Re-count of high-value items", "Godown / back store counted"],
      "Close": ["Differences explained", "Adjustments posted", "Stock statement given to the accountant"],
    },
  },
  {
    code: "project.renovation", name: "Shop renovation", category: "maintenance", days: 30,
    milestones: [["Contractor fixed", 5], ["Work complete", 25], ["Reopened", 30]],
    lists: {
      "Plan": ["Quotes from 3 contractors", "Design and colours agreed", "Customers told about the closure dates"],
      "Work": ["Old fixtures removed", "Civil and painting work", "Electrical work", "Cleaning after work"],
      "Reopen": ["Stock moved back and arranged", "Reopening offer"],
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
    code: "project.range_launch", name: "New menu / product range launch", category: "marketing", days: 30,
    milestones: [["Range decided", 7], ["Trials done", 18], ["Launched", 30]],
    lists: {
      "Develop": ["Items and suppliers shortlisted", "Costing and selling price", "Trials / samples"],
      "Set up": ["Items added in the app with tax and HSN", "Photos taken", "Staff briefed"],
      "Launch": ["Launch offer", "Social media and WhatsApp post", "Feedback after 2 weeks"],
    },
  },
];

const projectByCode = new Map(PROJECT_TEMPLATES.map((t) => [t.code, t]));

// The templates a business of this type sees, its own type's first.
const forType = (type) => TEMPLATES.filter((t) => t.types.includes(type)).sort((a, b) => Number(a.common) - Number(b.common));

module.exports = { TEMPLATES, PROJECT_TEMPLATES, ALL_TYPES, forType, get: (code) => byCode.get(code) || null, getProject: (code) => projectByCode.get(code) || null };
