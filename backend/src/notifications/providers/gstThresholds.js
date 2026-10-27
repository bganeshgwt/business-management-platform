// An owner's GST thresholds (modules/gst-thresholds): the turnover of the
// owner's businesses under the restaurant's PAN, nearing or past a figure the
// platform keeps (e-invoicing and 6-digit HSN / SAC codes above ₹5 crore, the
// IRP's 30 days at ₹10 crore or more): passed last year, it applies now;
// passed this year so far, from the next 1 April. The same lines as a
// business's bell, for those who may see the restaurant's money
// (reports.view). Everyone here shares one answer, so the PAN is masked and no
// sums are shown: the owner sees them in their own view. The standing behind
// it is kept for five minutes (gst-thresholds standingCache.js) and cleared
// when a PAN is recorded or an owner's warning level changes, so this keeps
// nothing of its own: two caches would add up to ten minutes.
const service = require("../../modules/gst-thresholds/services/gstThresholds.service");

module.exports = {
  key: "gstThresholds",
  label: "GST thresholds",
  permission: "reports.view",

  collect: async ({ restaurantId }) => {
    try {
      return await service.restaurantBell(restaurantId);
    } catch (error) {
      console.error("gst threshold notifications:", error.message);
      return [];
    }
  },
};
