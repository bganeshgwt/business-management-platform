// Where a salon's screens send someone, kept in one place so every "Book"
// opens the calendar's booking the same way.
import { businessPath } from "../../../../services/businessNav.js";

// "Book a visit" for a client, from their client card (`salon/clients/:id`,
// { contact, profile }): the calendar's booking with the client chosen and
// their usual stylist, if they have one.
export const bookVisitPath = (businessId, card) =>
  `${businessPath(businessId, "salon-calendar")}?book=1&contact=${card.contact.id}${card.profile?.preferred_resource_id ? `&staff=${card.profile.preferred_resource_id}` : ""}`;
