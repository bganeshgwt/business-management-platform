// Saved delivery addresses: read at the till and in the
// guest book, edited and removed in the guest book.
//
// Privacy follows the guest book's rule for contact details: the full text
// is for people with customers.contact (owners and managers). Everyone else
// sees the label and the area only ("Home · …, Jubilee Hills") — enough to
// ask "the usual, to Jubilee Hills?" — and picks the address by its id; the
// server copies the full text onto the delivery (delivery.service).
const AppError = require("../../../../utils/AppError");
const pool = require("../../../../config/database");
const guestAddressRepository = require("../repositories/guestAddress.repository");

// The last part of an address is the area or the city: "Flat 402, Sai
// Residency, Road 12, Banjara Hills" → "…, Banjara Hills".
const maskAddress = (text) => {
  const parts = String(text || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length > 1) {
    return `…, ${parts[parts.length - 1]}`;
  }

  return parts[0] ? `${parts[0].slice(0, 4)}…` : "…";
};

const toAddress = (row, reveal) => ({
  id: row.id,
  label: row.label,
  address: reveal ? row.address : maskAddress(row.address),
  landmark: reveal ? row.landmark || null : null,
  masked: !reveal,
  lastUsedAt: row.last_used_at,
  useCount: Number(row.use_count),
});

const requireGuest = async (restaurantId, customerId) => {
  const result = await pool.query(
    "SELECT id, name, erased_at FROM customers WHERE restaurant_id = $1 AND id = $2",
    [restaurantId, customerId]
  );
  const guest = result.rows[0];

  if (!guest || guest.erased_at) {
    throw new AppError(404, "Guest not found");
  }

  return guest;
};

const listForGuest = async (restaurantId, customerId, reveal) => {
  await requireGuest(restaurantId, customerId);

  const rows = await guestAddressRepository.findForGuest(restaurantId, customerId);

  return { max: guestAddressRepository.MAX_ADDRESSES, addresses: rows.map((row) => toAddress(row, reveal)) };
};

const update = async (restaurantId, customerId, id, data, userId) => {
  const guest = await requireGuest(restaurantId, customerId);

  let row;

  try {
    row = await guestAddressRepository.update(restaurantId, customerId, id, data, userId);
  } catch (error) {
    if (error.code === "23505") {
      throw new AppError(409, `${guest.name} already has this address saved.`);
    }

    throw error;
  }

  if (!row) {
    throw new AppError(404, "Address not found");
  }

  return { guest, address: toAddress(row, true) };
};

const remove = async (restaurantId, customerId, id) => {
  const guest = await requireGuest(restaurantId, customerId);
  const existing = await guestAddressRepository.findOne(restaurantId, customerId, id);

  if (!existing || !(await guestAddressRepository.remove(restaurantId, customerId, id))) {
    throw new AppError(404, "Address not found");
  }

  return { guest, address: existing };
};

module.exports = { toAddress, listForGuest, update, remove };
