import { useState } from "react";
import FormDialog from "./FormDialog";
import { Field } from "./ui";

// A one-question dialog: why something is being cancelled or approved.
export default function ReasonDialog({ title, description, label = "Why", required = true, placeholder, submitLabel, icon = "ban", onSubmit, onClose, onSaved }) {
  const [reason, setReason] = useState("");
  return (
    <FormDialog title={title} description={description} icon={icon} width={500} submitLabel={submitLabel} onClose={onClose} onSaved={onSaved}
      onSubmit={() => onSubmit(reason.trim())}>
      <Field label={label} wide>
        <input required={required} maxLength={300} value={reason} placeholder={placeholder} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </FormDialog>
  );
}
