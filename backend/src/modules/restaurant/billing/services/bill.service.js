// Bills. Each part lives in its own file under bill/: shape.js (a bill as
// the screens see it), offers.js (coupons and loyalty), rules.js (line
// pricing, business date, limits), raise.js (list, raise, adjust, print),
// payments.js, refunds.js (credit notes, refunds, voids) and summaries.js.
// This file only gathers them, so callers keep one require.

const { COMPLIMENTARY_REASONS, DISCOUNT_REASONS } = require("./bill/shape");
const { adjust, billableItems, createForOrder, findInScope, getById, list, planAdjust, registerPrint } = require("./bill/raise");
const { addPayment, checkCorrection, correctPayment, listCorrections, setBuyerPan } = require("./bill/payments");
const { addRefund, checkRefund, checkVoid, voidBill } = require("./bill/refunds");
const { daySummary, listCreditNotes, tillOptions } = require("./bill/summaries");

module.exports = {
  DISCOUNT_REASONS,
  COMPLIMENTARY_REASONS,
  list,
  getById,
  findInScope,
  billableItems,
  registerPrint,
  createForOrder,
  planAdjust,
  adjust,
  addPayment,
  checkCorrection,
  correctPayment,
  listCorrections,
  setBuyerPan,
  checkRefund,
  addRefund,
  checkVoid,
  voidBill,
  daySummary,
  listCreditNotes,
  tillOptions,
};
