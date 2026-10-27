import api from "../../../services/api";
import { businessRead, businessWrite } from "../../../services/business.service";

// An owner's GST thresholds (backend modules/gst-thresholds), through its
// three doors: the owner's view across their businesses, one business (the
// PAN its owner records, its HSN / SAC codes to fix), and the signed-in
// restaurant's codes to fix. The server works every figure out and checks who
// may see it; nothing here is trusted for that.

export const ownerThresholds = async (signal) => (await api.get("/businesses/gst-thresholds", { signal })).data.data;
export const setWarnLevel = async (warnPercent) => (await api.put("/businesses/gst-thresholds/warning-level", { warnPercent })).data.data;
// An empty PAN clears the one recorded.
export const recordPan = (businessId, pan) => businessWrite(businessId, "gst-pan", { pan }, "put");
export const hsnSummary = (businessId, signal) => businessRead(businessId, "gst-thresholds/hsn", undefined, signal);
export const menuHsn = async (signal) => (await api.get("/gst-thresholds/hsn", { signal })).data.data;
