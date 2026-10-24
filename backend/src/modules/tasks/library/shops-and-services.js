// Hardware and building materials, seeds and fertilisers, optical shops,
// garages, jewellers, fuel stations, gyms and studios, laundries, rentals, and
// hotels and lodges. The item lines are explained in parse.js.

module.exports = [
  // --- Hardware, paints & building materials --------------------------------------------
  {
    code: "hardware.godown_walk", name: "Godown stock walk", category: "stock_check", types: ["hardware"], priority: "normal",
    frequency: "weekly", weekdays: [1], times: ["09:30"], minutes: 45,
    description: "Cement kept dry, steel tagged by size, paint sold oldest batch first.",
    items: [
      "Cement bags off the floor on pallets, stacked no more than ten high",
      "yn-no: Any wet or hardened cement bags? ~high",
      "num: Damaged cement bags | bags | 0 | 0",
      "TMT and steel bundles tagged by size",
      "Paint tins arranged oldest batch in front",
      "Pipes and fittings in their racks by size",
      "Broken tiles and damaged items set aside for the supplier",
      "txt: What to reorder",
    ],
  },
  // --- Seeds, fertilisers & pesticides ----------------------------------------------------
  {
    code: "agri_inputs.stock_board", name: "Daily stock and price board", category: "opening_closing", types: ["agri_inputs"], priority: "high",
    frequency: "daily", times: ["08:30"], minutes: 15,
    description: "What a fertiliser and seed inspector looks at first, every morning before selling.",
    items: [
      "Opening stock of each fertiliser written on the board !",
      "Prices of fertilisers, seeds and pesticides on display",
      "Fertiliser, seed and insecticide licences on display",
      "Fertiliser PoS device charged and signed in",
      "Expired pesticides kept apart and marked not for sale !",
      "yn-no: Any pesticide kept with food or animal feed? ! ~critical",
    ],
  },
  {
    code: "agri_inputs.licence_expiry", name: "Licences and expiry check", category: "audit", types: ["agri_inputs"], priority: "high",
    frequency: "monthly", monthDay: 1, times: ["11:00"], minutes: 30, review: true,
    items: [
      "Fertiliser authorisation valid for this shop",
      "Seed licence valid for this shop",
      "Insecticide licence valid, with every product we sell endorsed on it",
      "Seed lots past their validity date taken off the shelf",
      "num: Pesticide batches expiring within 30 days | batches | 0 |",
      "Monthly seed stock return sent",
      "sign: Checked by",
    ],
  },
  // --- Optical shops ------------------------------------------------------------------------
  {
    code: "optical.contact_lens_expiry", name: "Contact lens and solution expiry check", category: "stock_check", types: ["optical"], priority: "high",
    frequency: "monthly", monthDay: 5, times: ["12:00"], minutes: 30,
    items: [
      "Contact lens boxes checked for date, power by power",
      "Lens solutions and drops checked for date",
      "num: Expired boxes found | boxes | 0 | 0",
      "Lenses expiring within 3 months moved to the front",
    ],
  },
  {
    code: "optical.testing_room", name: "Eye testing room check", category: "maintenance", types: ["optical"], priority: "normal",
    frequency: "daily", times: ["10:00"], minutes: 10,
    items: [
      "Auto refractometer switched on and calibrated",
      "Trial lens set complete and clean",
      "Vision chart lit and at the right distance",
      "Lensometer clean",
    ],
  },
  // --- Vehicle service & auto parts ---------------------------------------------------------
  {
    code: "garage.safety_round", name: "Workshop safety round", category: "health_safety", types: ["garage"], priority: "high",
    frequency: "daily", times: ["09:00"], minutes: 15,
    items: [
      "Fire extinguishers in place and the gauge in the green !",
      "Vehicle lift locks and hydraulics checked",
      "Waste oil kept in closed drums",
      "Floor free of oil spills",
      "Air compressor drained",
      "yn-no: Any tool or equipment found unsafe? ~high",
    ],
  },
  {
    code: "garage.vehicle_handover", name: "Vehicle handover check", category: "day_to_day", types: ["garage"], priority: "normal",
    minutes: 10,
    description: "Before the keys go back to the customer.",
    items: [
      "Road test done after the work",
      "Old parts shown or returned to the customer",
      "Vehicle washed and the inside clean",
      "num: Odometer at delivery | km | 0 |",
      "Work done and next service date explained to the customer",
    ],
  },
  // --- Jewellery & gold ---------------------------------------------------------------------
  {
    code: "jewellery.day_end", name: "Day-end stock tally and locker closing", category: "audit", types: ["jewellery"], priority: "urgent",
    frequency: "daily", times: ["20:30"], minutes: 30, review: true,
    items: [
      "Pieces in every display tray counted against the app !",
      "Gross weight of each tray checked",
      "Pieces out on approval listed with the customer's name",
      "yn-no: Any piece missing or not matching? ! ~critical",
      "CCTV recording checked",
      "Locker locked; keys with the owner !",
      "sign: Closed by",
    ],
  },
  // --- Fuel stations ------------------------------------------------------------------------
  {
    code: "fuel_station.nozzle_test", name: "Daily nozzle test (5-litre measure)", category: "audit", types: ["fuel_station"], priority: "urgent",
    frequency: "daily", times: ["06:30"], minutes: 30,
    description: "Every nozzle tested each morning with the stamped 5-litre measure, as the oil company requires.",
    items: [
      "5-litre measure has a valid Weights & Measures stamp !",
      "Every nozzle tested",
      "num: Lowest reading of any nozzle | ml | 4975 | 5025 !",
      "num: Highest reading of any nozzle | ml | 4975 | 5025 !",
      "Test fuel poured back into the tank and noted as test quantity",
      "sign: Tested by",
    ],
  },
  {
    code: "fuel_station.density_dips", name: "Morning density and tank dips", category: "stock_check", types: ["fuel_station"], priority: "high",
    frequency: "daily", times: ["06:00"], minutes: 20,
    items: [
      "Dip of every tank taken and written in the stock register",
      "Density of petrol and diesel taken and written in the density register",
      "yn-no: Water found in any tank? ! ~critical",
      "Meter readings of every nozzle noted for the first shift",
    ],
  },
  {
    code: "fuel_station.safety_round", name: "Forecourt safety and amenities round", category: "health_safety", types: ["fuel_station"], priority: "high",
    frequency: "daily", times: ["10:00", "18:00"], minutes: 15,
    items: [
      "Fire extinguishers and sand buckets in place !",
      "No-smoking and mobile-phone signs visible",
      "Emergency stop switch working",
      "Free air for tyres working",
      "Drinking water and toilets clean and open",
      "yn-no: Any leak or spill on the forecourt? ! ~critical",
    ],
  },
  // --- Gyms, studios & coaching ------------------------------------------------------------
  {
    code: "memberships.floor_check", name: "Gym floor and equipment check", category: "maintenance", types: ["memberships"], priority: "high",
    frequency: "daily", times: ["05:45"], minutes: 20,
    items: [
      "Machines wiped and cables, pins and pulleys checked",
      "Treadmill belts and emergency stops working",
      "yn-no: Any machine unsafe to use? ! ~high",
      "First-aid kit stocked",
      "Drinking water filled",
      "Changing rooms and washrooms clean",
    ],
  },
  {
    code: "memberships.renewal_calls", name: "Call members whose plans are ending", category: "marketing", types: ["memberships"], priority: "normal",
    frequency: "weekly", weekdays: [1], times: ["11:00"], minutes: 60,
    items: [
      "List of plans ending in the next 14 days taken from the app",
      "num: Members called | members | 0 |",
      "num: Renewals agreed | members | 0 |",
      "txt: Reasons members gave for not renewing",
    ],
  },
  // --- Laundry & dry cleaning --------------------------------------------------------------
  {
    code: "laundry.machine_care", name: "Machines and pressing area check", category: "maintenance", types: ["laundry"], priority: "normal",
    frequency: "daily", times: ["09:00"], minutes: 15,
    items: [
      "Lint filters of the dryers cleaned",
      "Steam boiler and irons checked",
      "Cleaning chemicals closed and stored away from heat",
      "Garments waiting on racks by order number",
    ],
  },
  {
    code: "laundry.unclaimed", name: "Unclaimed garments review", category: "stock_check", types: ["laundry"], priority: "normal",
    frequency: "weekly", weekdays: [6], times: ["12:00"], minutes: 30,
    items: [
      "Orders ready for more than 30 days listed",
      "num: Unclaimed orders | orders | 0 |",
      "Customers reminded by phone or WhatsApp",
      "txt: Orders to keep, and orders for the owner to decide on",
    ],
  },
  // --- Rentals & hire -----------------------------------------------------------------------
  {
    code: "rentals.return_inspection", name: "Returned item inspection", category: "day_to_day", types: ["rentals"], priority: "high",
    minutes: 15,
    description: "When hired items come back, before the deposit is returned.",
    items: [
      "Items counted against the booking",
      "photo: Photos of any damage",
      "yn-no: Any item damaged or missing? ~high",
      "Items cleaned and tagged ready for the next hire",
      "txt: Charges to take from the deposit, and why",
    ],
  },
  // --- Hotels, lodges & guest houses -------------------------------------------------------
  {
    code: "lodging.room_turnover", name: "Room turnover housekeeping", category: "cleaning", types: ["lodging"], priority: "high",
    minutes: 30,
    description: "After a guest checks out, before the room is sold again.",
    items: [
      "Bed linen and towels changed",
      "Bathroom cleaned and dried",
      "Toiletries and drinking water refilled",
      "Lights, AC, TV and geyser working",
      "yn-no: Anything left behind by the guest? ",
      "photo: Photo of the made room",
    ],
  },
  {
    code: "lodging.guest_register", name: "Guest register and foreigner reports", category: "audit", types: ["lodging"], priority: "urgent",
    frequency: "daily", times: ["11:00"], minutes: 15, review: true,
    items: [
      "Every occupant's ID recorded, not only the person who booked !",
      "yn: Every foreign guest reported on Form-III within 24 hours of arrival? !",
      "yn: Every foreign guest's departure reported within 24 hours? !",
      "Police guest register up to date",
      "sign: Checked by",
    ],
  },
  {
    code: "lodging.night_round", name: "Night safety round", category: "health_safety", types: ["lodging"], priority: "high",
    frequency: "daily", times: ["23:00"], minutes: 15,
    items: [
      "Fire exits clear and their lights on !",
      "Fire extinguishers in place",
      "CCTV recording",
      "Main door locked; night staff awake at the desk",
    ],
  },
];
