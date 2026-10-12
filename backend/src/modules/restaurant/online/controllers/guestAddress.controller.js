const v = require("../../../../utils/validate");
const { logAction } = require("../../../../utils/audit");
const guestAddressService = require("../services/guestAddress.service");

// Full addresses are for customers.contact, as mobiles are (crm.controller).
const reveals = (req) => (req.user?.permissions || []).includes("customers.contact");

const LABELS = ["Home", "Office", "Other"];

const readAddress = (body = {}) => ({
  // Home, Office, or a word of the guest's own ("Mum's place").
  label: v.optionalString(body.label, "Label", 30) || "Home",
  address: v.requiredString(body.address, "Address", 500),
  landmark: v.optionalString(body.landmark, "Landmark", 200) || null,
});

const list = async (req, res) => {
  const customerId = v.requiredId(req.params.customerId, "Guest id");

  res.json({
    success: true,
    data: await guestAddressService.listForGuest(req.user.restaurantId, customerId, reveals(req)),
  });
};

const update = async (req, res) => {
  const customerId = v.requiredId(req.params.customerId, "Guest id");
  const id = v.requiredId(req.params.id, "Address id");
  const { guest, address } = await guestAddressService.update(
    req.user.restaurantId,
    customerId,
    id,
    readAddress(req.body),
    req.user.id
  );

  logAction(req, "update_address", "customer", { id: customerId, label: guest.name, details: { label: address.label } });

  res.json({ success: true, message: `${address.label} address updated for ${guest.name}`, data: address });
};

const remove = async (req, res) => {
  const customerId = v.requiredId(req.params.customerId, "Guest id");
  const id = v.requiredId(req.params.id, "Address id");
  const { guest, address } = await guestAddressService.remove(req.user.restaurantId, customerId, id);

  logAction(req, "remove_address", "customer", { id: customerId, label: guest.name, details: { label: address.label } });

  res.json({ success: true, message: `${address.label} address removed from ${guest.name}` });
};

module.exports = { LABELS, list, update, remove };
