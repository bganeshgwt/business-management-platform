import { useMemo } from "react";
import useAuth from "../../hooks/useAuth";
import useBusiness from "../../hooks/useBusiness";
import { restaurantPrivacy, shopPrivacy } from "./services/privacy.service";

// What a screen needs to take or check a person's consent, for the business
// open in Business Admin or for the signed-in restaurant:
//   api          the calls (services/privacy.service.js)
//   canRecord    may record or withdraw a consent (whoever takes customers)
//   canView, canManage, canExport   the registers, as the server allows them
//   settingsPath where Settings › Personal data is
// The same object while none of these change, so a list's columns can depend on it.

const SHOP_RECORDERS = ["contacts.create", "contacts.edit", "patients.create", "patients.edit"];

export function useShopPrivacy() {
  const biz = useBusiness();
  const id = biz.context?.business?.id;
  const canRecord = SHOP_RECORDERS.some((code) => biz.can(code));
  const canView = biz.can("privacy.view");
  const canManage = biz.can("privacy.manage");
  const canExport = biz.can("privacy.export");
  const settingsPath = biz.path("privacy");
  return useMemo(() => ({ api: shopPrivacy(id), canRecord, canView, canManage, canExport, settingsPath }),
    [id, canRecord, canView, canManage, canExport, settingsPath]);
}

export function useRestaurantPrivacy() {
  const { hasPermission } = useAuth();
  const canRecord = hasPermission("customers.manage");
  const canView = hasPermission("privacy.view");
  const canManage = hasPermission("privacy.manage");
  const canExport = hasPermission("privacy.export");
  return useMemo(() => ({ api: restaurantPrivacy(), canRecord, canView, canManage, canExport, settingsPath: "/privacy" }),
    [canRecord, canView, canManage, canExport]);
}
