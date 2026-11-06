import { useEffect, useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { getErrorMessage } from "../../../../services/api";
import { listRoles } from "../../../access/services/role.service";
import { giveEmployeeLogin } from "../services/staff.service";

// "Give a login": an employee's own sign-in, made from their record in one
// step (POST /staff/:id/login). Their name, mobile, email and outlet come
// from the record; the owner picks the role and a first password, which they
// replace with their own at the first sign-in. The login is linked to them
// in the same save.
//
// When the server says the mobile or email is already on a login here, that
// login is offered to link instead of making a second; when the record has
// neither, or a mobile that is not ten digits, Edit opens the record.
export default function GiveLoginDialog({ employee, outletName, onClose, onDone, onEdit }) {
  const [roles, setRoles] = useState(null);
  const [roleId, setRoleId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  // The server's refusal, with what it offers: { reason, userId, userName }.
  const [refusal, setRefusal] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let current = true;

    listRoles()
      .then((rows) => {
        if (!current) {
          return;
        }

        // The platform's own role is never a restaurant's to give.
        const offered = rows.filter((role) => role.code !== "SUPER_ADMIN" && role.status === "active");
        setRoles(offered);
        // A captain, cashier or cook is told by their designation; else nothing is picked for them.
        const guess = offered.find((role) => employee.designation && role.name.toLowerCase().startsWith(employee.designation.toLowerCase()));
        setRoleId(guess ? String(guess.id) : "");
      })
      .catch((err) => current && setError(getErrorMessage(err)));

    return () => {
      current = false;
    };
  }, [employee.designation]);

  const signsInWith = [employee.mobile, employee.email].filter(Boolean);
  const noContact = signsInWith.length === 0;

  const send = async (body) => {
    setError("");
    setSaving(true);

    try {
      const result = await giveEmployeeLogin(employee.id, body);
      onDone(result.message);
    } catch (err) {
      const data = err.response?.data?.data || {};

      setRefusal(data.reason ? data : null);
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const submit = (event) => {
    event.preventDefault();

    if (!roleId) {
      setError("Choose what they do: their role decides what they can open.");
      return;
    }

    if (password.length < 8) {
      setError("The first password needs at least 8 characters.");
      return;
    }

    send({ roleIds: [Number(roleId)], password });
  };

  const fixRecord = refusal && ["no_contact", "bad_mobile", "email_elsewhere"].includes(refusal.reason);

  return (
    <Modal
      title={`Give ${employee.name} a login`}
      description="Their sign-in, made from this record and linked to it. You choose what they do and a first password; they pick their own when they first sign in."
      icon="login"
      onClose={onClose}
      dismissible={!saving}
      width={520}
    >
      <form className="form-grid" onSubmit={submit} noValidate>
        <dl className="field-wide give-login-facts">
          <div>
            <dt>Signs in with</dt>
            <dd>{noContact ? <span className="muted">No mobile or email on the record</span> : signsInWith.join(" or ")}</dd>
          </div>
          {outletName && (
            <div>
              <dt>Outlet</dt>
              <dd>{outletName}</dd>
            </div>
          )}
        </dl>

        {noContact ? (
          <p className="field-wide alert alert-notice">
            Staff sign in with their mobile number or email. Add one to {employee.name}&apos;s record first.
          </p>
        ) : (
          <>
            <label className="field field-wide">
              <span>What they do *</span>
              {roles ? (
                <select
                  value={roleId}
                  onChange={(event) => {
                    setRoleId(event.target.value);
                    setError("");
                  }}
                  required
                >
                  <option value="">Choose a role</option>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
              ) : (
                !error && <Loading label="Reading the roles…" />
              )}
              <small className="muted">Their role decides what they can open and do. Change it later in Users.</small>
            </label>

            <label className="field field-wide">
              <span>First password *</span>
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                maxLength={72}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError("");
                }}
                required
              />
              <small className="muted">At least 8 characters. Tell it to them; they choose their own when they first sign in.</small>
            </label>
          </>
        )}

        <ErrorMessage message={error} />

        {refusal && refusal.reason === "login_exists" && (
          <div className="field-wide give-login-offer">
            <span>
              <Icon name="link" size={16} /> {refusal.userName} already has a login with these details.
            </span>
            <button type="button" className="button button-secondary" disabled={saving} onClick={() => send({ linkUserId: refusal.userId })}>
              Link {refusal.userName}&apos;s login
            </button>
          </div>
        )}

        <div className="form-actions field-wide">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          {noContact || fixRecord ? (
            <button type="button" className="button" onClick={onEdit}>
              <Icon name="edit" size={16} /> Edit {employee.name}
            </button>
          ) : (
            <button type="submit" className="button" disabled={saving || !roles}>
              {saving ? "Giving…" : "Give the login"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
