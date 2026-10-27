import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import useAuth from "../../hooks/useAuth";
import useServerNow from "../../hooks/useServerNow";
import { useOpenBusiness } from "../../modules/business/core/pages/hooks";
import { useSignatories } from "../../modules/business/health/pages/healthFormat";
import { useQueue, useTokenActions } from "../../modules/business/health/pages/tokenQueue";
import { deskDoctors, myCalendar, waitingCounts } from "./clinicDesk.js";

// The clinic workspace's desk, read once by its layout and shared by its
// screens, through the APIs the clinic's Token queue already uses:
//   GET /clinic/queue              the day's tokens at the branch in view, by
//                                  doctor, live within a second (the token
//                                  queue's own, tokenQueue.js)
//   GET /health/signatories        the clinic's doctors: whose calendar, and
//                                  so whose queue, is the signed-in doctor's
// with the server's clock for the waiting times, and what the desk and the
// doctors do with tokens (a consultation started opens in the workspace).
export default function useClinicDesk() {
  const biz = useOpenBusiness();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queue = useQueue(biz.id);
  const now = useServerNow(queue.offset, 15000);
  const signatories = useSignatories(biz.id, "doctor");
  const mine = useMemo(() => myCalendar(signatories, user.id), [signatories, user.id]);
  const openVisit = (visitId) => navigate(biz.path(`visits/${visitId}`));
  const { act, next } = useTokenActions(queue.reload, openVisit);
  const tokens = useMemo(() => queue.data?.tokens || [], [queue.data]);
  const doctors = useMemo(() => deskDoctors(queue.data?.doctors, mine), [queue.data, mine]);
  return {
    ...queue,
    now,
    mine,
    tokens,
    doctors,
    counts: waitingCounts(tokens, mine),
    act,
    next,
    openVisit,
    // What this person may do, as the server decides it.
    can: {
      desk: biz.can("patients.create"),
      act: biz.can("patients.create") || biz.can("patients.edit_clinical"),
      tests: biz.has("lab") && biz.can("lab.create"),
    },
  };
}
