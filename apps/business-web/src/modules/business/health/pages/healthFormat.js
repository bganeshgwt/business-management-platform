import { useEffect, useState } from "react";
import api, { getErrorMessage } from "../../../../services/api";
import { businessRead } from "../../../../services/business.service";
import { toast } from "../../../../services/toast";

// Words, formats and API helpers the pharmacy, clinic and lab screens share
// (the health module). The badges and fields are in healthParts.jsx.

export const SCHEDULES = [["none", "Not scheduled (OTC)"], ["G", "Schedule G"], ["H", "Schedule H (Rx)"], ["H1", "Schedule H1 (Rx + register)"], ["X", "Schedule X (Rx + pharmacist PIN)"], ["narcotic", "Narcotic (NDPS)"]];
export const FORMS = ["tablet", "capsule", "syrup", "suspension", "injection", "ointment", "cream", "drops", "inhaler", "powder", "gel", "solution", "device", "other"];
export const RX_SCHEDULES = ["H", "H1", "X", "narcotic"];
export const SIGNED_SCHEDULES = ["X", "narcotic"];
export const LAB_STATES = {
  ordered: ["info", "Ordered"], collected: ["info", "Sample collected"], received: ["info", "In the lab"], in_process: ["warning", "In process"],
  resulted: ["warning", "Awaiting approval"], approved: ["success", "Report ready"], cancelled: ["neutral", "Cancelled"],
};
export const FLAG_WORDS = { low: "Low", high: "High", critical_low: "Critical low", critical_high: "Critical high", abnormal: "Abnormal", normal: "", none: "" };
export const isFlagged = (flag) => ["low", "high", "critical_low", "critical_high", "abnormal"].includes(flag);
// A result as the lab writes it: to the parameter's decimals.
export const resultText = (p) => (p.value_text != null ? p.value_text : p.value_numeric == null ? "" : Number(p.value_numeric).toFixed(Number(p.decimals ?? 1)));
export const SEX_WORDS = { female: "Female", male: "Male", other: "Other" };
export const PURPOSE_WORDS = { treatment: "Treatment and medical records", reports_digital: "Reports on WhatsApp / e-mail", reminders: "Reminders (follow-ups, refills)" };
export const METHOD_WORDS = { signed_form: "Signed form", verbal: "Told at the desk (verbal)", digital: "Digital (OTP / tablet)" };
const ageText = (age) => (age === null || age === undefined ? "" : `${age} y`);
export const patientLine = (p) => [p.patient_no, p.sex ? SEX_WORDS[p.sex] : "", p.age !== undefined && p.age !== null ? ageText(p.age) : ""].filter(Boolean).join(" · ");

// The people who sign (pharmacist, doctor, pathologist) of this business.
export function useSignatories(businessId, kind) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    businessRead(businessId, "health/signatories", kind ? { kind } : undefined, controller.signal).then(setRows).catch(() => setRows([]));
    return () => controller.abort();
  }, [businessId, kind]);
  return rows;
}

// Opens a prescription scan (private: through the API, and the look is logged).
export async function openPrescriptionFile(businessId, fileId) {
  try {
    const response = await api.get(`/businesses/${businessId}/pharmacy/prescription-files/${fileId}`, { responseType: "blob" });
    const url = URL.createObjectURL(response.data);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    toast.error(getErrorMessage(err));
  }
}
export async function uploadPrescriptionFile(businessId, file) {
  const form = new FormData();
  form.append("file", file);
  return (await api.post(`/businesses/${businessId}/pharmacy/prescription-files`, form)).data.data;
}
