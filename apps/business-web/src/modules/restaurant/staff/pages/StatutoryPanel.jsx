import { useCallback, useEffect, useState } from "react";
import Modal from "../../../../components/Modal";
import Icon from "@bmp/ui/Icon";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { getStatutorySettings, getStatutorySummary, saveStatutorySettings } from "../services/staff.service";
import { getErrorMessage } from "../../../../services/api";
import { money } from "@bmp/shared/format";
import { downloadCsv } from "../../../../services/csv";

// PF, ESI and professional tax on Payroll: the settings (off until switched
// on, with the rules' starting values), and what a month owes the PF and ESI
// offices and the state, split into the employee's part and the employer's.

const monthWords = (month) =>
  new Date(`${month}-01T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

const numberText = (value) => (value === null || value === undefined ? "" : String(value));

export function StatutorySettingsModal({ onClose, onSaved }) {
  const [form, setForm] = useState(null);
  const [presets, setPresets] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getStatutorySettings()
      .then((data) => {
        setPresets(data.presets || []);
        setForm({
          pfEnabled: data.pfEnabled,
          pfEmployeeRate: numberText(data.pfEmployeeRate),
          pfEmployerRate: numberText(data.pfEmployerRate),
          pfWageCeiling: numberText(data.pfWageCeiling),
          esiEnabled: data.esiEnabled,
          esiEmployeeRate: numberText(data.esiEmployeeRate),
          esiEmployerRate: numberText(data.esiEmployerRate),
          esiWageLimit: numberText(data.esiWageLimit),
          ptEnabled: data.ptEnabled,
          ptState: data.ptState || "",
          ptSlabs: (data.ptSlabs || []).map((slab) => ({
            over: numberText(slab.over),
            amount: numberText(slab.amount),
            februaryAmount: numberText(slab.februaryAmount),
            for: slab.for === "women" ? "women" : "",
          })),
        });
      })
      .catch((err) => setError(getErrorMessage(err)));
  }, []);

  const set = (field) => (event) =>
    setForm({ ...form, [field]: event.target.type === "checkbox" ? event.target.checked : event.target.value });

  const preset = presets.find((item) => item.state === form?.ptState) || null;

  const pickState = (state) => {
    const chosen = presets.find((item) => item.state === state);
    setForm({
      ...form,
      ptState: state,
      ptSlabs: chosen
        ? chosen.slabs.map((slab) => ({
            over: numberText(slab.over),
            amount: numberText(slab.amount),
            februaryAmount: numberText(slab.februaryAmount),
            for: slab.for === "women" ? "women" : "",
          }))
        : form.ptSlabs,
    });
  };

  const setSlab = (index, field, value) =>
    setForm({ ...form, ptSlabs: form.ptSlabs.map((slab, at) => (at === index ? { ...slab, [field]: value } : slab)) });

  const save = async (event) => {
    event.preventDefault();
    setError("");
    setBusy(true);

    try {
      await saveStatutorySettings({
        pfEnabled: form.pfEnabled,
        pfEmployeeRate: Number(form.pfEmployeeRate),
        pfEmployerRate: Number(form.pfEmployerRate),
        pfWageCeiling: Number(form.pfWageCeiling),
        esiEnabled: form.esiEnabled,
        esiEmployeeRate: Number(form.esiEmployeeRate),
        esiEmployerRate: Number(form.esiEmployerRate),
        esiWageLimit: Number(form.esiWageLimit),
        ptEnabled: form.ptEnabled,
        ptState: form.ptState || null,
        ptSlabs: form.ptSlabs
          .filter((slab) => slab.over !== "" && slab.amount !== "")
          .map((slab) => ({
            over: Number(slab.over),
            amount: Number(slab.amount),
            ...(slab.februaryAmount !== "" ? { februaryAmount: Number(slab.februaryAmount) } : {}),
            ...(slab.for === "women" ? { for: "women" } : {}),
          })),
      });
      onSaved();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="PF, ESI and professional tax"
      description="Off until you switch each one on. The starting values are the rules in force; change them only when the rules change."
      icon="percent"
      onClose={onClose}
      width={720}
    >
      {!form ? (
        error ? <ErrorMessage message={error} /> : <Loading label="Loading…" />
      ) : (
        <form className="stack" onSubmit={save}>
          <ErrorMessage message={error} />

          <fieldset className={`asw-stat-block ${form.pfEnabled ? "is-on" : ""}`}>
            <legend>
              <label className="checkbox">
                <input type="checkbox" checked={form.pfEnabled} onChange={set("pfEnabled")} />
                <span>Provident fund (PF)</span>
              </label>
            </legend>
            <div className="form-grid">
              <label className="field">
                <span>From the employee (%)</span>
                <input type="number" min="0" max="100" step="0.01" value={form.pfEmployeeRate} onChange={set("pfEmployeeRate")} disabled={!form.pfEnabled} />
              </label>
              <label className="field">
                <span>From the employer (%)</span>
                <input type="number" min="0" max="100" step="0.01" value={form.pfEmployerRate} onChange={set("pfEmployerRate")} disabled={!form.pfEnabled} />
              </label>
              <label className="field">
                <span>On basic wages up to (₹ a month)</span>
                <input type="number" min="1" step="1" value={form.pfWageCeiling} onChange={set("pfWageCeiling")} disabled={!form.pfEnabled} />
              </label>
            </div>
            <p className="muted small">Each rounded to the nearest rupee. Only people marked "PF" on their record pay it.</p>
          </fieldset>

          <fieldset className={`asw-stat-block ${form.esiEnabled ? "is-on" : ""}`}>
            <legend>
              <label className="checkbox">
                <input type="checkbox" checked={form.esiEnabled} onChange={set("esiEnabled")} />
                <span>ESI</span>
              </label>
            </legend>
            <div className="form-grid">
              <label className="field">
                <span>From the employee (%)</span>
                <input type="number" min="0" max="100" step="0.01" value={form.esiEmployeeRate} onChange={set("esiEmployeeRate")} disabled={!form.esiEnabled} />
              </label>
              <label className="field">
                <span>From the employer (%)</span>
                <input type="number" min="0" max="100" step="0.01" value={form.esiEmployerRate} onChange={set("esiEmployerRate")} disabled={!form.esiEnabled} />
              </label>
              <label className="field">
                <span>When gross pay is up to (₹ a month)</span>
                <input type="number" min="1" step="1" value={form.esiWageLimit} onChange={set("esiWageLimit")} disabled={!form.esiEnabled} />
              </label>
            </div>
            <p className="muted small">Each rounded up to the next rupee, as ESIC does. Only people marked "ESI" pay it.</p>
          </fieldset>

          <fieldset className={`asw-stat-block ${form.ptEnabled ? "is-on" : ""}`}>
            <legend>
              <label className="checkbox">
                <input type="checkbox" checked={form.ptEnabled} onChange={set("ptEnabled")} />
                <span>Professional tax</span>
              </label>
            </legend>
            <label className="field">
              <span>State</span>
              <select value={form.ptState} onChange={(event) => pickState(event.target.value)} disabled={!form.ptEnabled}>
                <option value="">Choose the restaurant's state</option>
                {presets.map((item) => (
                  <option key={item.state} value={item.state}>
                    {item.state}
                    {item.none ? " (no professional tax)" : ""}
                  </option>
                ))}
              </select>
            </label>
            {preset && preset.note && <p className="small asw-note-line">{preset.note}</p>}
            {preset && preset.none ? (
              <p className="muted small">{form.ptState} does not charge professional tax. Leave it switched off.</p>
            ) : (
              <div className="asw-slabs">
                <div className="asw-slab-head">
                  <span>Monthly gross pay above (₹)</span>
                  <span>Tax a month (₹)</span>
                  <span>February (₹)</span>
                  <span>For</span>
                  <span />
                </div>
                {form.ptSlabs.map((slab, index) => (
                  <div className="asw-slab-row" key={index}>
                    {/* The headings above the slabs are hidden on phones, so each
                        box carries its own small caption there. */}
                    <label className="asw-slab-field">
                      <span className="asw-slab-cap">Pay above (₹)</span>
                      <input type="number" min="0" value={slab.over} onChange={(event) => setSlab(index, "over", event.target.value)} disabled={!form.ptEnabled} aria-label="Pay above" />
                    </label>
                    <label className="asw-slab-field">
                      <span className="asw-slab-cap">Tax a month (₹)</span>
                      <input type="number" min="0" max="2500" value={slab.amount} onChange={(event) => setSlab(index, "amount", event.target.value)} disabled={!form.ptEnabled} aria-label="Tax a month" />
                    </label>
                    <label className="asw-slab-field">
                      <span className="asw-slab-cap">February (₹)</span>
                      <input
                        type="number"
                        min="0"
                        max="2500"
                        value={slab.februaryAmount}
                        onChange={(event) => setSlab(index, "februaryAmount", event.target.value)}
                        disabled={!form.ptEnabled}
                        placeholder="same"
                        aria-label="Tax in February"
                      />
                    </label>
                    {/* Some states tax women differently (Maharashtra: nothing up to
                        ₹25,000). A table with any women's slab taxes women by those. */}
                    <label className="asw-slab-field">
                      <span className="asw-slab-cap">For</span>
                      <select
                        value={slab.for || ""}
                        onChange={(event) => setSlab(index, "for", event.target.value)}
                        disabled={!form.ptEnabled}
                        aria-label="Who this slab is for"
                      >
                        <option value="">Everyone</option>
                        <option value="women">Women</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => setForm({ ...form, ptSlabs: form.ptSlabs.filter((item, at) => at !== index) })}
                      disabled={!form.ptEnabled}
                      aria-label="Remove this slab"
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setForm({ ...form, ptSlabs: [...form.ptSlabs, { over: "", amount: "", februaryAmount: "", for: "" }] })}
                  disabled={!form.ptEnabled}
                >
                  <Icon name="plus" size={14} /> Add a slab
                </button>
                <p className="muted small">
                  The highest slab a person's monthly gross pay is above decides their tax. Below the lowest, nothing. Where the
                  table has slabs for women, a woman (Gender: Female on her staff record) is taxed by those alone.
                </p>
              </div>
            )}
          </fieldset>

          <div className="form-actions">
            <button type="button" className="button button-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="button" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// What one month's payroll owes, for the PF and ESI returns and the state.
export function StatutorySummary({ initialMonth, currency }) {
  const [month, setMonth] = useState(initialMonth);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(
    () =>
      getStatutorySummary(month)
        .then((result) => {
          setData(result);
          setError("");
        })
        .catch((err) => setError(getErrorMessage(err))),
    [month]
  );

  useEffect(() => {
    load();
  }, [load]);

  const exportCsv = () =>
    downloadCsv(
      [
        ["Employee", "Code", "UAN", "ESI number", "Gross pay", "PF wages", "PF employee", "PF employer", "ESI wages", "ESI employee", "ESI employer", "Professional tax", "Paid"],
        ...data.people.map((row) => [
          row.name,
          row.employeeCode || "",
          row.uan || "",
          row.esiNumber || "",
          row.grossPay,
          row.pfWages,
          row.pfEmployee,
          row.pfEmployer,
          row.esiWages,
          row.esiEmployee,
          row.esiEmployer,
          row.professionalTax,
          row.paid ? "yes" : "not yet",
        ]),
        ["Total", "", "", "", "", data.totals.pfWages, data.totals.pfEmployee, data.totals.pfEmployer, data.totals.esiWages, data.totals.esiEmployee, data.totals.esiEmployer, data.totals.professionalTax, ""],
      ],
      `pf-esi-pt-${month}.csv`
    );

  return (
    <SectionCard
      icon="percent"
      tone="info"
      title={`PF, ESI and professional tax · ${monthWords(month)}`}
      description="What the month owes: taken from pay (employee) and on top (employer). People already paid for the month show what they were paid with."
      actions={
        <div className="asw-inline-actions">
          <label className="asw-date-chip">
            <span className="sr-only">Month</span>
            <input type="month" value={month} onChange={(event) => setMonth(event.target.value || initialMonth)} />
          </label>
          <button type="button" className="button button-secondary button-sm" onClick={exportCsv} disabled={!data || data.people.length === 0}>
            <Icon name="download" size={15} /> CSV
          </button>
        </div>
      }
      flush
    >
      <ErrorMessage message={error} />
      {!data ? (
        error ? null : (
          <div className="acc-pad">
            <Loading />
          </div>
        )
      ) : (
        <>
          <div className="asw-muster-tiles">
            <StatTile size="sm" icon="wallet" tone="primary" label="PF payable" value={money(data.totals.pf)} note={`${money(data.totals.pfEmployee)} employee + ${money(data.totals.pfEmployer)} employer`} />
            <StatTile size="sm" icon="shield" tone="info" label="ESI payable" value={money(data.totals.esi)} note={`${money(data.totals.esiEmployee)} employee + ${money(data.totals.esiEmployer)} employer`} />
            <StatTile size="sm" icon="receipt" tone="warning" label="Professional tax" value={money(data.totals.professionalTax)} note={data.settings.ptState || "the state"} />
            <StatTile size="sm" icon="check-circle" tone="success" label="Total to pay over" value={money(data.totals.payable)} />
          </div>
          {/* The CSV button above gives the filing layout (UAN, ESI number,
              gross pay and wages for every line); the grid has no export of
              its own, so there is one CSV for this card. */}
          <DataGrid
            id="statutory-summary"
            caption={`PF, ESI and professional tax for ${monthWords(month)}`}
            columns={[
              {
                key: "name",
                header: "Employee",
                value: (row) => row.name,
                mobile: "title",
                pin: true,
                render: (row) => (
                  <span className="acc-who-text">
                    <strong>{row.name}</strong>
                    <span className="muted small mono">
                      {row.uan ? `UAN ${row.uan}` : "No UAN yet"}
                      {row.esiNumber ? ` · ESI ${row.esiNumber}` : ""}
                      {row.paid ? " · paid" : ""}
                    </span>
                  </span>
                ),
              },
              { key: "grossPay", header: "Gross pay", type: "money", exact: true, value: (row) => row.grossPay, defaultHidden: true },
              { key: "pfWages", header: "PF wages", type: "money", exact: true, value: (row) => row.pfWages, total: "sum" },
              { key: "pfEmployee", header: "PF · employee", type: "money", exact: true, value: (row) => row.pfEmployee, total: "sum", mobile: "show" },
              { key: "pfEmployer", header: "PF · employer", type: "money", exact: true, value: (row) => row.pfEmployer, total: "sum", mobile: "show" },
              { key: "esiWages", header: "ESI wages", type: "money", exact: true, value: (row) => row.esiWages, total: "sum", defaultHidden: true },
              { key: "esiEmployee", header: "ESI · employee", type: "money", exact: true, value: (row) => row.esiEmployee, total: "sum", mobile: "show" },
              { key: "esiEmployer", header: "ESI · employer", type: "money", exact: true, value: (row) => row.esiEmployer, total: "sum", mobile: "show" },
              { key: "professionalTax", header: "Prof. tax", type: "money", exact: true, value: (row) => row.professionalTax, total: "sum", mobile: "show" },
            ]}
            rows={data.people}
            rowKey={(row) => row.employeeId}
            currency={currency}
            empty="Nothing owed for this month"
            emptyIcon="percent"
            emptyHint="Switch PF, ESI or professional tax on, and mark who is covered on each person's record."
          />
        </>
      )}
    </SectionCard>
  );
}
