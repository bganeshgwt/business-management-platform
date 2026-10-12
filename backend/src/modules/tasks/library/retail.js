// Shops: grocery / kirana, supermarket, books & stationery, fashion,
// electronics. The item lines are explained in parse.js.

module.exports = [
  // --- Grocery / kirana ----------------------------------------------------------------
  {
    code: "grocery.month_end_stock", name: "Month-end stock check", category: "stock_check", types: ["grocery", "supermarket"], priority: "high",
    frequency: "monthly", monthDay: 28, times: ["20:00"], minutes: 180, review: true,
    description: "Count by rack before the month closes; differences go to the stock count in the app.",
    items: [
      "# Before counting",
      "Stock count started in the app for this location",
      "Damaged and expired goods kept aside first",
      "# Count by section",
      "Rice, atta and dal bags counted",
      "Oil tins and packets counted",
      "Spices and masala counted",
      "Biscuits, snacks and beverages counted",
      "Soaps, detergents and personal care counted",
      "# After",
      "num: Items with a difference | items | 0 | 10 ~medium",
      "txt: Big differences and the reason",
      "sign: Counted by",
    ],
  },
  {
    code: "grocery.expiry_check", name: "Weekly expiry check", category: "stock_check", types: ["grocery", "supermarket"], priority: "high",
    frequency: "weekly", weekdays: [2], times: ["15:00"], minutes: 45,
    items: [
      "Dairy, bread and eggs checked for date",
      "Biscuits, chips and packed snacks checked",
      "Beverages and juices checked",
      "Baby food and health drinks checked",
      "yn-no: Expired item found on the shelf? ! ~high",
      "num: Items moved to the return-to-supplier crate | items | 0 |",
      "Near-expiry items put on offer in the app ?",
    ],
  },
  {
    code: "grocery.bin_cleaning", name: "Loose grains bin cleaning", category: "cleaning", types: ["grocery", "weight_retail"], priority: "normal",
    frequency: "weekly", weekdays: [0], times: ["10:00"], minutes: 40,
    items: [
      "Rice, dal and sugar bins emptied and wiped",
      "yn-no: Any weevils, insects or moisture found? ~high",
      "Scoops washed and dried",
      "Bins refilled, oldest stock on top",
      "Floor under the bins cleaned",
    ],
  },
  {
    code: "grocery.scale_calibration", name: "Weighing scale check", category: "maintenance", types: ["grocery", "supermarket", "meat", "weight_retail"], priority: "high",
    frequency: "weekly", weekdays: [1], times: ["10:30"], minutes: 10,
    description: "Legal Metrology: a wrong scale is a fine. Check with a standard 1 kg weight.",
    items: [
      "num: Reading with the 1 kg standard weight | kg | 0.995 | 1.005 ! ~high",
      "yn: Scale shows zero with nothing on it",
      "yn: Stamping / verification certificate valid ! ~high",
      "photo: Photo of the stamping seal ?",
    ],
  },
  {
    code: "grocery.udhaar_followup", name: "Udhaar follow-up", category: "day_to_day", types: ["grocery", "supermarket", "pharmacy", "meat"], priority: "normal",
    frequency: "weekly", weekdays: [6], times: ["18:00"], minutes: 30,
    items: [
      "Udhaar list opened in the app, sorted by oldest",
      "Reminders sent on WhatsApp to customers over 30 days",
      "num: Customers called | customers | 0 |",
      "num: Collected today | ₹ | 0 |",
      "txt: Customers who promised a date ?",
    ],
  },
  {
    code: "grocery.home_delivery", name: "Home delivery dispatch check", category: "day_to_day", types: ["grocery", "supermarket", "pharmacy"], priority: "normal", minutes: 10,
    items: [
      "Order items picked and matched with the bill",
      "Cold items packed in an insulated bag",
      "yn: Payment collected or UPI confirmed",
      "Delivery boy has the address and phone number",
    ],
  },
  // --- Supermarket -----------------------------------------------------------------------
  {
    code: "supermarket.planogram", name: "Shelf & planogram check", category: "audit", types: ["supermarket"], priority: "normal",
    frequency: "weekdays", weekdays: [1, 2, 3, 4, 5, 6], times: ["10:30"], minutes: 30,
    items: [
      "Every shelf faced up, labels to the front",
      "yn-no: Any gaps (out of stock) on the shelves? ~medium",
      "Promotional end-caps match this week's offers",
      "Shelf price labels match the system price",
      "photo: Photo of the main aisle",
    ],
  },
  {
    code: "supermarket.price_audit", name: "Price label audit", category: "audit", types: ["supermarket", "grocery", "pharmacy"], priority: "high",
    frequency: "weekly", weekdays: [4], times: ["16:00"], minutes: 30,
    description: "Pick 20 items at random; selling above MRP is an offence.",
    items: [
      "num: Items checked | items | 1 |",
      "num: Items with a wrong shelf price | items | 0 | 0 ~high",
      "yn-no: Any item scanning above MRP? ! ~critical",
      "Wrong labels re-printed from the app",
    ],
  },
  {
    code: "supermarket.chiller", name: "Dairy & frozen chiller log", category: "food_safety", types: ["supermarket", "grocery"], priority: "high",
    frequency: "daily", times: ["10:00", "18:00"], window: 120, minutes: 5,
    items: [
      "num: Dairy chiller | °C | 0 | 5 ! ~high",
      "num: Frozen food freezer | °C | -25 | -18 ! ~high",
      "num: Ice cream freezer | °C | -30 | -18 ~high",
      "yn: Chiller curtains / doors closed",
    ],
  },
  {
    code: "supermarket.trolleys", name: "Trolley & basket sanitising", category: "cleaning", types: ["supermarket"], priority: "low",
    frequency: "daily", times: ["14:00"], minutes: 20,
    items: ["Trolley handles sanitised", "Baskets washed and stacked", "Broken trolley wheels reported ?"],
  },
  {
    code: "supermarket.counter_audit", name: "Billing counter surprise audit", category: "audit", types: ["supermarket", "grocery", "pharmacy", "fashion", "electronics"], priority: "high", minutes: 15, review: true,
    items: [
      "num: Cash as per the app | ₹ | 0 |",
      "num: Cash counted in the drawer | ₹ | 0 |",
      "yn-no: Difference of more than ₹100? ! ~high",
      "yn-no: Bills cancelled without a manager approval?",
      "sign: Cashier",
      "sign: Auditor",
    ],
  },
  // --- Books & stationery --------------------------------------------------------------------
  {
    code: "books.new_arrivals", name: "New arrivals display", category: "marketing", types: ["books"], priority: "normal",
    frequency: "weekly", weekdays: [1], times: ["11:00"], minutes: 30,
    items: ["New titles entered in the app with price", "New arrivals shelf refreshed", "Bestseller list updated at the entrance", "photo: Photo of the display"],
  },
  {
    code: "books.school_season", name: "School season set check", category: "stock_check", types: ["books"], priority: "high",
    frequency: "weekly", weekdays: [1, 4], times: ["10:30"], minutes: 60,
    description: "April–June: every school's booklist set ready to hand over.",
    items: [
      "Booklist sets for each school and class checked against the list",
      "num: Sets short of one or more titles | sets | 0 | 0 ~high",
      "Notebooks, covers and labels stocked",
      "Pending orders for missing titles placed",
    ],
  },
  {
    code: "books.shelf_count", name: "Shelf-wise stock count", category: "stock_check", types: ["books"], priority: "normal",
    frequency: "monthly", monthDay: 25, times: ["19:00"], minutes: 120,
    items: ["Fiction shelves counted", "Academic and competitive exam shelves counted", "Stationery counted", "num: Titles with a difference | titles | 0 | 5"],
  },
  {
    code: "books.damaged", name: "Damaged books sorting", category: "stock_check", types: ["books"], priority: "low",
    frequency: "monthly", monthDay: 10, times: ["16:00"], minutes: 30,
    items: ["Torn or water-damaged books taken off the shelf", "num: Books for return to the publisher | books | 0 |", "num: Books for the discount bin | books | 0 |"],
  },
  {
    code: "books.reorder", name: "Bestseller & exam-guide reorder", category: "procurement", types: ["books"], priority: "normal",
    frequency: "weekly", weekdays: [5], times: ["16:00"], minutes: 20,
    items: ["Top 20 sellers checked for stock", "Competitive exam guides checked before exam season", "num: Titles below 2 copies | titles | 0 |", "Order sent to the publisher / distributor"],
  },
  {
    code: "books.stationery", name: "Stationery counter check", category: "day_to_day", types: ["books"], priority: "low",
    frequency: "daily", times: ["18:00"], minutes: 10,
    items: ["Pens, refills and geometry boxes refilled on the counter", "Xerox / print machine paper and toner checked ?", "Loose items (erasers, sharpeners) counted"],
  },
  // --- Fashion ---------------------------------------------------------------------------------
  {
    code: "fashion.window", name: "Window display change", category: "marketing", types: ["fashion"], priority: "normal",
    frequency: "every_n_days", everyN: 14, times: ["10:30"], minutes: 90,
    items: ["Theme agreed (season / festival / new collection)", "Mannequins dressed with complete looks", "Price tags hidden, offer board clear", "Window glass cleaned, lights working", "photo: Photo of the window ! "],
  },
  {
    code: "fashion.trial_room", name: "Trial room check", category: "day_to_day", types: ["fashion"], priority: "normal",
    frequency: "daily", times: ["12:00", "17:00"], minutes: 5,
    items: ["Clothes left behind put back on the racks", "Mirror and floor clean", "Hooks and lock working", "yn-no: Any security tag or empty hanger found (possible theft)? ~high"],
  },
  {
    code: "fashion.tagging", name: "Stock tagging audit", category: "audit", types: ["fashion"], priority: "normal",
    frequency: "weekly", weekdays: [3], times: ["15:00"], minutes: 30,
    items: ["num: Pieces checked | pieces | 1 |", "num: Pieces without a barcode tag | pieces | 0 | 0", "Missing tags printed from the app", "Size and colour on the tag match the piece"],
  },
  {
    code: "fashion.size_set", name: "Size-set availability check", category: "stock_check", types: ["fashion"], priority: "normal",
    frequency: "weekly", weekdays: [1], times: ["11:00"], minutes: 30,
    items: ["Best sellers checked for S–XXL", "num: Styles with a broken size set | styles | 0 | 5", "Reorder sent for broken sets ?"],
  },
  {
    code: "fashion.steam_press", name: "Steam & press before display", category: "production", types: ["fashion"], priority: "low",
    frequency: "daily", times: ["10:30"], minutes: 30,
    items: ["New arrivals steamed", "Display pieces pressed", "Steamer water emptied and switched off"],
  },
  // --- Electronics -------------------------------------------------------------------------------
  {
    code: "electronics.demo_units", name: "Demo unit check", category: "audit", types: ["electronics"], priority: "high",
    frequency: "daily", times: ["10:30"], minutes: 20,
    items: [
      "All demo phones / laptops / TVs switched on and charging",
      "Demo mode on, personal accounts signed out",
      "yn: Every demo unit present and its security cable intact ! ~critical",
      "Screens clean, no fingerprints",
      "Price cards and EMI offers correct",
    ],
  },
  {
    code: "electronics.serial_audit", name: "Serial / IMEI audit", category: "audit", types: ["electronics"], priority: "high",
    frequency: "weekly", weekdays: [6], times: ["19:00"], minutes: 60, review: true,
    items: [
      "Phones on hand scanned against the IMEI register in the app",
      "num: Serials missing from the shelf | units | 0 | 0 ! ~critical",
      "num: Serials on the shelf not in the app | units | 0 | 0 ~high",
      "sign: Audited by",
    ],
  },
  {
    code: "electronics.warranty_cards", name: "Warranty card & bill check", category: "audit", types: ["electronics"], priority: "normal",
    frequency: "weekly", weekdays: [2], times: ["16:00"], minutes: 20,
    items: ["Warranty registered in the app for every serial sold this week", "Brand warranty cards stamped", "Pending repair job cards followed up"],
  },
  {
    code: "electronics.earthing", name: "Earthing & power check", category: "health_safety", types: ["electronics"], priority: "normal",
    frequency: "monthly", monthDay: 3, times: ["11:00"], minutes: 15,
    items: ["num: Earth-to-neutral voltage | V | 0 | 2 ~high", "Stabiliser / spike guards working on demo counters", "yn-no: Any burnt smell or hot socket? ! ~critical"],
  },
  {
    code: "electronics.service_followup", name: "Repair job follow-up", category: "day_to_day", types: ["electronics"], priority: "normal",
    frequency: "daily", times: ["17:00"], minutes: 20,
    items: ["Jobs promised for today checked", "Customers informed of ready jobs", "num: Jobs past the promised date | jobs | 0 | 0"],
  },
];
