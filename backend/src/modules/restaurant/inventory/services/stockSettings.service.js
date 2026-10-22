const stockSettingsRepository = require("../repositories/stockSettings.repository");
const approvalService = require("../../../access/services/approval.service");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");

// Stock → Stock & purchasing settings (sweep SW-B-10, SW-B-11).
//
//   poApprovalLimit        a purchase order worth more than this (before GST)
//                          waits as "Waiting for approval" until someone with
//                          "Approve purchase orders over the limit" — or a
//                          manager's PIN — approves it.
//   writeoffApprovalLimit  wastage or a stock out worth more than this, at
//                          cost, needs "Approve large write-offs" or a
//                          manager's PIN, tied to the item, quantity and value.
//   transferReceiptRequired  stock sent between stores is "in transit" until
//                          the receiving store confirms what arrived.
//
// Blank limits mean no limit.

// The words the manager-PIN prompt uses for the two approvals this module
// adds ("You need a manager's OK to make a large write-off"). The prompt
// reads them from the approval service's list; they are registered here,
// with the permissions they belong to, rather than left as "do this".
const ACTION_WORDS = {
  "purchasing.approve": "approve a large purchase order",
  "inventory.approve_writeoff": "make a large write-off",
};

if (approvalService.ACTION_LABELS && typeof approvalService.ACTION_LABELS === "object") {
  for (const [code, words] of Object.entries(ACTION_WORDS)) {
    if (!approvalService.ACTION_LABELS[code]) {
      approvalService.ACTION_LABELS[code] = words;
    }
  }
}

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const numberOrNull = (value) => (value === null || value === undefined ? null : Number(value));

const toSettings = (row) => ({
  poApprovalLimit: numberOrNull(row.po_approval_limit),
  writeoffApprovalLimit: numberOrNull(row.writeoff_approval_limit),
  transferReceiptRequired: Boolean(row.transfer_receipt_required),
  updatedAt: row.updated_at || null,
  updatedByName: row.updated_by_name || null,
});

const get = async (restaurantId, client) => {
  requireRestaurantId(restaurantId);

  return toSettings(await stockSettingsRepository.find(restaurantId, client));
};

// Returns the settings before and after, for the activity log.
const save = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  const before = await get(restaurantId);
  const after = toSettings(
    await stockSettingsRepository.save(
      restaurantId,
      {
        poApprovalLimit: data.poApprovalLimit === null ? null : round2(data.poApprovalLimit),
        writeoffApprovalLimit: data.writeoffApprovalLimit === null ? null : round2(data.writeoffApprovalLimit),
        transferReceiptRequired: data.transferReceiptRequired,
      },
      userId
    )
  );

  return { before, after };
};

// Is this much over the limit? A blank limit is never exceeded.
const overLimit = (limit, value) => limit !== null && limit !== undefined && round2(value) > Number(limit) + 0.004;

module.exports = { ACTION_WORDS, get, save, overLimit };
