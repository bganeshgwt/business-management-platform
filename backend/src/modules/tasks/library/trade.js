// Wholesale, pharmacy, salon & spa, clinics & labs, meat & seafood and other
// weight-based shops. The item lines are explained in parse.js.

module.exports = [
  // --- Wholesale / FMCG distribution ------------------------------------------------------------
  {
    code: "wholesale.vehicle", name: "Delivery van / vehicle check", category: "maintenance", types: ["wholesale"], priority: "high",
    frequency: "daily", times: ["08:30"], window: 90, minutes: 10,
    description: "Before the van leaves on its route.",
    items: [
      "txt: Vehicle number",
      "num: Odometer reading | km | 0 |",
      "choice: Tyres | Fine, Low air*, Worn out*",
      "yn: Brakes, horn, lights and indicators working ! ~critical",
      "yn: RC, insurance, PUC and permit in the vehicle ~high",
      "num: Fuel level | % | 20 | 100",
      "Crates and tarpaulin loaded",
      "photo: Photo of the van",
    ],
  },
  {
    code: "wholesale.loading", name: "Loading check against dispatch", category: "day_to_day", types: ["wholesale"], priority: "high",
    frequency: "daily", times: ["09:00"], minutes: 20,
    items: [
      "Pick list from the app printed",
      "Each retailer's goods loaded together and marked",
      "num: Cases loaded | cases | 0 |",
      "yn-no: Any short or extra case against the dispatch? ~high",
      "Invoices and e-way bill handed to the driver",
      "sign: Loaded by",
    ],
  },
  {
    code: "wholesale.godown_audit", name: "Godown stock audit", category: "stock_check", types: ["wholesale"], priority: "high",
    frequency: "monthly", monthDay: 30, times: ["18:00"], minutes: 240, review: true,
    items: [
      "# Before",
      "Stock count started in the app",
      "Damaged and near-expiry stock moved to a separate bay",
      "# Count",
      "Each brand counted bay by bay",
      "Scheme / free stock counted separately",
      "# After",
      "num: Lines with a difference | lines | 0 | 10 ~high",
      "txt: Reasons for large differences",
      "sign: Godown in-charge",
    ],
  },
  {
    code: "wholesale.cheque_deposit", name: "Cheque deposit", category: "day_to_day", types: ["wholesale"], priority: "high",
    frequency: "weekdays", weekdays: [1, 2, 3, 4, 5, 6], times: ["13:00"], minutes: 20,
    items: [
      "Cheques due today listed from the app",
      "num: Cheques deposited | cheques | 0 |",
      "num: Amount deposited | ₹ | 0 |",
      "photo: Photo of the bank counterfoil",
    ],
  },
  {
    code: "wholesale.beat_review", name: "Salesman beat review", category: "audit", types: ["wholesale"], priority: "normal",
    frequency: "weekly", weekdays: [6], times: ["18:30"], minutes: 30,
    items: [
      "Visits per beat compared with the plan",
      "num: Outlets not visited this week | outlets | 0 | 5",
      "Outstanding over 60 days discussed with each salesman",
      "txt: New outlets to add ?",
    ],
  },
  {
    code: "wholesale.damaged_stock", name: "Damaged stock sorting & claims", category: "stock_check", types: ["wholesale"], priority: "normal",
    frequency: "weekly", weekdays: [3], times: ["16:00"], minutes: 40,
    items: ["Damaged and returned stock sorted by company", "Claims raised in the app for each company", "num: Value of damaged stock | ₹ | 0 |", "photo: Photo of the damaged stock"],
  },
  // --- Pharmacy -----------------------------------------------------------------------------------
  {
    code: "pharmacy.expiry", name: "Monthly expiry check", category: "stock_check", types: ["pharmacy"], priority: "high",
    frequency: "monthly", monthDay: 1, times: ["15:00"], minutes: 90, review: true,
    description: "Pull everything expiring in the next 90 days; expired stock is kept apart and labelled.",
    items: [
      "Expiring-soon list taken from the app",
      "Strips and bottles expiring within 90 days moved to the front / near-expiry shelf",
      "yn-no: Expired medicine found among saleable stock? ! ~critical",
      "Expired stock kept in a separate labelled box \"Not for sale\" ! ",
      "num: Items to return to the stockist | items | 0 |",
      "sign: Pharmacist",
    ],
  },
  {
    code: "pharmacy.fridge", name: "Medicine fridge log (2–8 °C)", category: "health_safety", types: ["pharmacy", "healthcare"], priority: "high",
    frequency: "daily", times: ["10:00", "18:00"], window: 120, minutes: 5,
    description: "Insulin, vaccines and eye drops. Every reading out of range needs the action taken.",
    items: [
      "num: Fridge temperature | °C | 2 | 8 ! ~critical",
      "yn: Fridge not used for food or drinks",
      "yn: Power backup working for the fridge",
      "txt: Action taken if out of range ?",
    ],
  },
  {
    code: "pharmacy.h1_register", name: "Schedule H1 register check", category: "audit", types: ["pharmacy"], priority: "high",
    frequency: "weekly", weekdays: [6], times: ["19:00"], minutes: 20, review: true,
    description: "Rule 65(3)(h): every H1 sale entered with prescriber, patient and quantity; kept for 3 years.",
    items: [
      "Every H1 sale this week has an entry",
      "yn: Prescriber name and address written for each ! ~high",
      "yn: Patient name and quantity written for each ~high",
      "yn-no: Any H1 drug sold without a prescription? ! ~critical",
      "sign: Registered pharmacist",
    ],
  },
  {
    code: "pharmacy.narcotics", name: "Narcotics cupboard check", category: "audit", types: ["pharmacy"], priority: "high",
    frequency: "daily", times: ["21:00"], minutes: 10,
    items: ["Cupboard locked, key with the pharmacist", "num: Stock as per register matches the count | mismatches | 0 | 0 ! ~critical", "sign: Pharmacist"],
  },
  {
    code: "pharmacy.returns", name: "Returns to stockist", category: "procurement", types: ["pharmacy"], priority: "normal",
    frequency: "monthly", monthDay: 5, times: ["16:00"], minutes: 30,
    items: ["Expired / breakage list prepared", "Credit note requested from each stockist", "num: Value returned | ₹ | 0 |", "photo: Photo of the return note"],
  },
  {
    code: "pharmacy.licence", name: "Licence & pharmacist display check", category: "audit", types: ["pharmacy"], priority: "normal",
    frequency: "monthly", monthDay: 1, times: ["11:00"], minutes: 5,
    items: ["yn: Drug licence (Form 20/21) displayed ~high", "yn: Registered pharmacist's name and registration displayed ~high", "yn: Pharmacist present during working hours ! ~high", "yn: Licence valid for more than 60 days"],
  },
  // --- Salon & spa ---------------------------------------------------------------------------------
  {
    code: "salon.sanitisation", name: "Station sanitisation", category: "cleaning", types: ["salon"], priority: "high",
    frequency: "daily", times: ["10:00", "15:00"], window: 60, minutes: 10,
    items: [
      "Chairs, armrests and headrests sanitised",
      "Mirrors and counters wiped",
      "Hair swept after every client, bin emptied",
      "Wash basins cleaned, no hair in the drain",
      "Hand sanitiser at every station",
    ],
  },
  {
    code: "salon.sterilisation", name: "Tool sterilisation log", category: "health_safety", types: ["salon"], priority: "high",
    frequency: "daily", times: ["10:30", "16:00"], minutes: 10,
    description: "Combs, scissors, razors, nail tools. Single-use blades are never reused.",
    items: [
      "Scissors, combs and clippers cleaned and disinfected (Barbicide / UV)",
      "Nail tools autoclaved or soaked as instructed",
      "yn: Fresh blade for every shave ! ~critical",
      "num: UV / autoclave cycle time | minutes | 15 | ",
      "sign: Done by",
    ],
  },
  {
    code: "salon.linen", name: "Towel & linen count", category: "stock_check", types: ["salon"], priority: "normal",
    frequency: "daily", times: ["20:00"], minutes: 10,
    items: ["num: Clean towels left | towels | 10 |", "num: Towels sent to laundry | towels | 0 |", "Capes and spa sheets washed"],
  },
  {
    code: "salon.product_stock", name: "Product & back-bar stock check", category: "stock_check", types: ["salon"], priority: "normal",
    frequency: "weekly", weekdays: [1], times: ["11:00"], minutes: 30,
    items: ["Hair colour shades counted", "Shampoo, conditioner and treatment stock checked", "Retail products on display checked for expiry", "txt: Products to order ?"],
  },
  {
    code: "salon.consultation", name: "Client consultation & patch test", category: "day_to_day", types: ["salon"], priority: "normal", minutes: 10,
    description: "Before a colour, keratin or chemical treatment.",
    items: ["txt: Client name and service", "yn-no: Any allergy or skin condition? ~high", "yn: Patch test done 48 hours before (for colour) ~high", "Expected result and price agreed", "sign: Client consent"],
  },
  {
    code: "salon.spa_room", name: "Spa room readiness", category: "opening_closing", types: ["salon"], priority: "normal",
    frequency: "daily", times: ["10:00"], minutes: 15,
    items: ["Fresh sheets and towels", "Oils and creams topped up", "Steam / shower working", "Room temperature comfortable", "Music and lighting set"],
  },
  // --- Clinics & labs --------------------------------------------------------------------------------
  {
    code: "healthcare.bmw", name: "Biomedical waste segregation", category: "health_safety", types: ["healthcare"], priority: "high",
    frequency: "daily", times: ["18:00"], minutes: 15,
    description: "BMW Rules 2016: yellow, red, white (sharps) and blue bags; handed to the authorised agency.",
    items: [
      "yn: Yellow, red, white and blue containers present and labelled ! ~high",
      "yn-no: Any mixing of general and biomedical waste? ! ~high",
      "Sharps container not more than three-quarters full",
      "num: Bags handed to the collection agency | bags | 0 |",
      "photo: Photo of the collection slip ?",
    ],
  },
  {
    code: "healthcare.sample_fridge", name: "Sample & reagent fridge log", category: "health_safety", types: ["healthcare"], priority: "high",
    frequency: "daily", times: ["09:30", "17:30"], window: 120, minutes: 5,
    items: ["num: Sample fridge | °C | 2 | 8 ! ~critical", "num: Reagent fridge | °C | 2 | 8 ~high", "num: Freezer | °C | -30 | -18 ?"],
  },
  {
    code: "healthcare.calibration", name: "Equipment calibration check", category: "maintenance", types: ["healthcare"], priority: "normal",
    frequency: "monthly", monthDay: 2, times: ["11:00"], minutes: 30,
    items: ["BP apparatus checked against the reference", "Glucometer control solution test passed", "Analyser QC run within range", "num: Weighing scale with 10 kg standard | kg | 9.95 | 10.05 ~high", "txt: Equipment due for service ?"],
  },
  {
    code: "healthcare.room_ready", name: "Consultation room readiness", category: "opening_closing", types: ["healthcare"], priority: "normal",
    frequency: "daily", times: ["09:00"], minutes: 10,
    items: ["Couch sheet changed", "Hand rub and gloves stocked", "Thermometer, BP machine and torch working", "Prescription pads / printer ready", "Waiting area clean, token display on"],
  },
  {
    code: "healthcare.bmw_register", name: "BMW register & annual report", category: "audit", types: ["healthcare"], priority: "normal",
    frequency: "monthly", monthDay: 28, times: ["16:00"], minutes: 20, review: true,
    items: ["Daily quantities entered in the register", "Agency receipts filed", "yn: BMW authorisation valid ~high", "sign: In-charge"],
  },
  // --- Meat & seafood -----------------------------------------------------------------------------------
  {
    code: "meat.cold_room", name: "Cold-room & display temperature log", category: "food_safety", types: ["meat"], priority: "high",
    frequency: "daily", times: ["07:30", "13:00", "19:00"], window: 90, minutes: 5,
    items: [
      "num: Cold room | °C | 0 | 4 ! ~high",
      "num: Display counter | °C | 0 | 4 ! ~high",
      "num: Fish on ice (core) | °C | 0 | 3 ~high",
      "num: Freezer | °C | -25 | -18 ~high",
      "txt: Action taken if out of range ?",
    ],
  },
  {
    code: "meat.ice_display", name: "Ice & display check", category: "day_to_day", types: ["meat"], priority: "normal",
    frequency: "daily", times: ["07:00", "15:00"], minutes: 10,
    items: ["Fresh flake ice on the fish display", "Melt-water drained", "Display covered from flies (net / glass)", "Price board updated with today's rates"],
  },
  {
    code: "meat.sanitising", name: "Knife, block & board sanitising", category: "cleaning", types: ["meat"], priority: "high",
    frequency: "daily", times: ["14:00", "21:00"], minutes: 20,
    items: ["Knives and cleavers washed with hot water and sanitised", "Chopping block scraped and salted / sanitised", "Mincer dismantled and washed", "Separate boards for chicken, mutton and fish", "Aprons and gloves changed"],
  },
  {
    code: "meat.waste", name: "Waste disposal", category: "health_safety", types: ["meat"], priority: "high",
    frequency: "daily", times: ["21:30"], minutes: 15,
    items: ["Offal and waste in a covered bin", "Waste handed to the municipal / rendering collector", "num: Waste weight | kg | 0 |", "Drain and floor washed with disinfectant"],
  },
  {
    code: "meat.freshness", name: "Fish freshness check", category: "food_safety", types: ["meat"], priority: "high",
    frequency: "daily", times: ["06:30"], minutes: 15,
    description: "On receiving fish from the harbour / market.",
    items: [
      "choice: Eyes | Clear and bulging, Cloudy*, Sunken*",
      "choice: Gills | Bright red, Brown*, Grey*",
      "choice: Smell | Fresh sea smell, Sour*, Ammonia*",
      "yn: Flesh firm, springs back when pressed ~high",
      "num: Fish received | kg | 0 |",
    ],
  },
  {
    code: "meat.licence", name: "Licence & slaughter certificate check", category: "audit", types: ["meat"], priority: "normal",
    frequency: "monthly", monthDay: 1, times: ["11:00"], minutes: 10,
    items: ["yn: FSSAI licence displayed ~high", "yn: Municipal trade licence valid ~high", "yn: Meat bought only from an approved slaughterhouse (bills kept) ! ~high"],
  },
  // --- Other weight-based shops (dry fruits, sweets, spices) ------------------------------------------------
  {
    code: "weight.moisture", name: "Dry-fruit & spice quality check", category: "food_safety", types: ["weight_retail"], priority: "normal",
    frequency: "weekly", weekdays: [2], times: ["11:00"], minutes: 20,
    items: ["choice: Cashews and almonds | Crisp, Soft / damp*, Insects*", "choice: Raisins and dates | Fine, Sticky / fermented*, Fungus*", "Spice jars tightly closed", "Silica / moisture absorbers in the bins ?"],
  },
  {
    code: "weight.packing", name: "Packing material stock", category: "procurement", types: ["weight_retail", "meat"], priority: "low",
    frequency: "weekly", weekdays: [5], times: ["17:00"], minutes: 10,
    items: ["num: Pouches / boxes left | pieces | 100 |", "Labels and printer ribbon in stock", "Carry bags (no single-use plastic below 120 micron)"],
  },
  {
    code: "weight.repacking", name: "Repacking & labelling batch", category: "production", types: ["weight_retail"], priority: "normal", minutes: 60,
    items: ["Bulk lot weighed before repacking", "Packs weighed and sealed", "Each pack labelled: name, net weight, MRP, packed date, best before", "num: Packs made | packs | 0 |", "Repacking entered in the app"],
  },
  {
    code: "weight.sweets_display", name: "Sweets display & shelf life", category: "food_safety", types: ["weight_retail"], priority: "high",
    frequency: "daily", times: ["10:00"], minutes: 10,
    description: "FSSAI: loose sweets must show a best-before date on the tray.",
    items: ["yn: Best-before date shown on every tray ! ~high", "yn-no: Any tray past its best-before? ! ~high", "Display covered", "num: Display chiller | °C | 0 | 8 ?"],
  },
];
