const menuCardService = require("../services/menuCard.service");
const v = require("../../../../utils/validate");

// Menu → Products → Print menu: the card for one outlet and one service.
const card = async (req, res) => {
  const outletId = v.optionalNumber(req.query.outletId, "Outlet", { min: 1 }) || null;
  const orderType = v.optionalEnum(
    req.query.orderType,
    "Service",
    Object.keys(menuCardService.ORDER_TYPES),
    "dine_in"
  );

  res.json({
    success: true,
    data: await menuCardService.card(req.user.restaurantId, { outletId, orderType }),
  });
};

module.exports = { card };
