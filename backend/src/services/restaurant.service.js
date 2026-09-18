const restaurantRepository = require("../repositories/restaurant.repository");
const AppError = require("../utils/AppError");

const getCurrentRestaurant = async (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }

  const restaurant = await restaurantRepository.findById(restaurantId);

  if (!restaurant) {
    throw new AppError(404, "Restaurant not found");
  }

  return restaurant;
};

module.exports = {
  getCurrentRestaurant,
};
