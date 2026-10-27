// A shared till's switch, with "Ask the biller's PIN for every bill" on,
// gives a proof that the PIN just typed counts for the next bill
// (backend: businessCounter.service.js). It stands for the person the till
// was switched to, in that business, from that session, for one bill within
// two minutes; the server checks all of it again. The screen keeps it in this
// page's memory only, never in storage, and never keeps or sends the PIN:
// after a reload, or once the proof is used or refused, the PIN is asked.

let held = null;

// After a switch: the session the switch answered with ({ user, billProof,
// billProofExpiresAt }); one without a proof clears any earlier one.
export function keepBillProof(businessId, session) {
  held = session && session.billProof
    ? { businessId: String(businessId), userId: String(session.user?.id), proof: session.billProof, until: Date.parse(session.billProofExpiresAt) || 0 }
    : null;
}

// The proof for this person's next bill here, or null.
export function billProofFor(businessId, userId, now = Date.now()) {
  if (!held || held.businessId !== String(businessId) || held.userId !== String(userId) || now >= held.until) {
    return null;
  }
  return held.proof;
}

// Used on a bill, or refused by the server: the PIN is asked from now on.
export function dropBillProof() {
  held = null;
}
