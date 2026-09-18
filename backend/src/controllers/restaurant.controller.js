const restaurantService = require("../services/restaurant.service");

// Returns only the logged-in user's own restaurant: the id comes from the
// token (req.user), never from the URL, so one tenant cannot read another.
const getCurrent = async (req, res) => {
  const restaurant = await restaurantService.getCurrentRestaurant(req.user.restaurantId);

  res.json({
    success: true,
    data: restaurant,
  });
};

module.exports = {
  getCurrent,
};
