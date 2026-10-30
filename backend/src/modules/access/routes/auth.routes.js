const express = require("express");
const authController = require("../controllers/auth.controller");
const authenticate = require("../../../middlewares/authenticate");
const { loginLimiter, passwordChangeLimiter, pinLimiter } = require("../../../middlewares/rateLimiters");

const router = express.Router();

// Everything here is about the signed-in person themselves, so it needs a
// session and nothing more. What a PIN may do is checked in the service.
router.post("/login", loginLimiter, authController.login);

// Two-step sign-in, straight after a right password: the code (or a recovery
// code), or setting it up when the person's role needs it. No session yet,
// only the short ticket the password step handed back.
router.post("/login/two-factor", loginLimiter, authController.loginTwoFactor);
router.post("/login/two-factor/setup", loginLimiter, authController.loginTwoFactorSetup);
router.post("/login/two-factor/enable", loginLimiter, authController.loginTwoFactorEnable);

// Who am I and changing the password are the only routes open to someone
// whose password was set by someone else: they choose their own here first.
router.get("/me", authenticate.duringPasswordChange, authController.me);
router.put("/me", authenticate, authController.updateMe);
router.post(
  "/change-password",
  passwordChangeLimiter,
  authenticate.duringPasswordChange,
  authController.changePassword
);

// Sessions: keep this one alive while working; end all the others.
router.post("/refresh", authenticate, authController.refresh);
router.post("/sign-out-others", authenticate, authController.signOutOthers);
router.get("/me/sign-ins", authenticate, authController.mySignIns);

// My work: your own roster, attendance, leave left and payslips, through your
// own login's link to your staff record (no staff permission needed).
// Your own shifts, attendance and payslips: part of Staff & payroll.
router.get("/me/work", authenticate, require("../../../middlewares/requireFeature")("staff_payroll"), authController.myWork);
router.get("/me/payslips/:id", authenticate, authController.myPayslip);

// Your own two-step sign-in: turn it on (password, then the first code), make
// new recovery codes (password), turn it off (password and a code).
router.get("/two-factor", authenticate, authController.twoFactorStatus);
router.post("/two-factor/setup", passwordChangeLimiter, authenticate, authController.startTwoFactor);
router.post("/two-factor/enable", passwordChangeLimiter, authenticate, authController.enableTwoFactor);
router.post("/two-factor/disable", passwordChangeLimiter, authenticate, authController.disableTwoFactor);
router.post("/two-factor/recovery-codes", passwordChangeLimiter, authenticate, authController.newRecoveryCodes);

// Your personal PIN, for approvals and the shared till. Setting it is open to
// a session a shared till opened with a PIN someone else set: the person
// chooses their own there first.
router.put("/me/pin", passwordChangeLimiter, authenticate.duringPinChange, authController.setMyPin);
router.delete("/me/pin", passwordChangeLimiter, authenticate, authController.clearMyPin);

// The shared till: who can take it over, taking it over, unlocking it. Its
// lock screen works while the person it was switched to chooses their own PIN.
router.get("/till-users", authenticate.duringPinChange, authController.tillUsers);
router.post("/pin-login", pinLimiter, authenticate.duringPinChange, authController.pinLogin);
router.post("/unlock", pinLimiter, authenticate.duringPinChange, authController.unlock);

// Manager approval: who can approve, and approving one action.
router.get("/approvers", authenticate, authController.approvers);
router.post("/approvals", pinLimiter, authenticate, authController.approve);

module.exports = router;
