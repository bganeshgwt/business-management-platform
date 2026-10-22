import api from "../../../../services/api";

// The loyalty programme: its rules, and the points guests hold.
export const getLoyaltyProgramme = async () => (await api.get("/discounts/loyalty")).data.data;

// Every rule in one save (blank limits: no limit; blank expiry: never).
export const saveLoyaltyRules = async (payload) => (await api.put("/discounts/loyalty", payload)).data.data;
