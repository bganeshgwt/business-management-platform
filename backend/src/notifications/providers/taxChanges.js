// GST rate changes (modules/tax-changes): a change of dishes' tax rates, or of
// the restaurant's default GST rate, shown 7 days before its trading day and
// again on the day before, saying what moves and how many dishes. The same
// lines as a business's bell, for those who manage the menu (menu.manage),
// who enter the changes under Menu › GST rate changes.
const menu = require("../../modules/tax-changes/services/taxChangesMenu");

module.exports = {
  key: "taxChanges",
  label: "GST rate changes",
  permission: "menu.manage",

  collect: async ({ restaurantId }) => {
    try {
      return await menu.bell(restaurantId);
    } catch (error) {
      console.error("GST rate change notifications:", error.message);
      return [];
    }
  },
};
