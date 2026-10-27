// Personal data (modules/personal-data): requests from guests nearing their
// 90 days or past them, a breach whose detailed report to the Data Protection
// Board is still to record (72 hours from when it was found), and a privacy
// notice not yet published. The same lines as a business's bell, for the
// restaurant's own registers (Settings › Personal data).
const register = require("../../modules/personal-data/services/privacyRegister.service");
const restaurant = require("../../modules/personal-data/services/personalDataRestaurant");

module.exports = {
  key: "privacy",
  label: "Personal data",
  permission: "privacy.view",

  collect: async ({ restaurantId }) => {
    try {
      // The registry has checked privacy.view; the lines need nothing more.
      const world = restaurant.world({ restaurantId, id: null, name: null, permissions: ["privacy.view", "privacy.manage"] });
      const link = (tab, id) => `/privacy?tab=${tab}${id ? `&${tab === "requests" ? "request" : "breach"}=${id}` : ""}`;
      return await register.bell(world, link);
    } catch (error) {
      console.error("privacy notifications:", error.message);
      return [];
    }
  },
};
