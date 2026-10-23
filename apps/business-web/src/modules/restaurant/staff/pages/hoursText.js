import { durationMinutes } from "@bmp/shared/format";

// Hours worked in the staff screens: "25h 55m", never "25.92" (read as
// 25 h 92 min) and never "1 day" — a month's hours stay in hours. Under a
// day it is exactly durationMinutes() ("45m", "8h 17m", "8h").
export const hoursFromMinutes = (minutes) => {
  const total = Math.max(0, Math.round(Number(minutes) || 0));

  if (total < 24 * 60) {
    return durationMinutes(total);
  }

  const rest = total % 60;
  return rest ? `${Math.floor(total / 60)}h ${String(rest).padStart(2, "0")}m` : `${Math.floor(total / 60)}h`;
};

// The same from decimal hours as the API gives them (25.92 -> "25h 55m").
export const hoursFromDecimal = (hours) => hoursFromMinutes(Math.round((Number(hours) || 0) * 60));
