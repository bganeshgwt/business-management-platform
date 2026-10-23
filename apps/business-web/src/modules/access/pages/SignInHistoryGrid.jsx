import DataGrid from "../../../components/DataGrid/DataGrid";
import { SIGN_IN_METHODS, SIGN_IN_OUTCOMES, TWO_FACTOR_WORDS, addressOf, deviceOf, whenOf } from "./signInLabels";

// Sign-in history as a data grid: on My profile (your own) and from Users
// (someone else's, with what was typed and where it came from). Each row is
// one sign-in or failed try: when, how (password, PIN, two-step), the result
// and the device.
//
//   rows        the API's sign-in rows
//   detailed    also show what was typed and the address (Users only)
export default function SignInHistoryGrid({ id, rows, detailed = false, empty, emptyHint }) {
  const methodOf = (row) => SIGN_IN_METHODS[row.method] || row.method;
  const resultOf = (row) => SIGN_IN_OUTCOMES[row.outcome]?.label || row.outcome;

  return (
    <DataGrid
      id={id}
      caption="Sign-in history"
      variant="compact"
      columns={[
        {
          key: "when",
          header: "When",
          width: 140,
          type: "datetime",
          value: (row) => row.createdAt,
          mobile: "title",
          render: (row) => <strong className="nowrap small">{whenOf(row.createdAt)}</strong>,
        },
        {
          key: "how",
          header: "How",
          width: 120,
          className: "staff-log-cell",
          value: methodOf,
          mobile: "show",
          csv: (row) => `${methodOf(row)}${row.twoFactor ? ` (${TWO_FACTOR_WORDS[row.twoFactor] || row.twoFactor})` : ""}`,
          render: (row) => (
            <span className="small">
              {methodOf(row)}
              {row.twoFactor && <span className="muted acc-block">{TWO_FACTOR_WORDS[row.twoFactor] || row.twoFactor}</span>}
            </span>
          ),
        },
        {
          key: "result",
          header: "Result",
          width: 140,
          type: "status",
          value: resultOf,
          mobile: "subtitle",
          render: (row) => (
            <span className={`badge status-badge nowrap ${SIGN_IN_OUTCOMES[row.outcome]?.tone || ""}`}>
              <span className="badge-dot" aria-hidden="true" />
              {resultOf(row)}
            </span>
          ),
        },
        detailed && {
          key: "typed",
          header: "Typed",
          width: 170,
          className: "staff-log-cell",
          value: (row) => row.identifier || "",
          mobile: "show",
          render: (row) => <span className="small mono acc-wrap">{row.identifier || "—"}</span>,
        },
        {
          key: "device",
          header: "Device",
          width: 180,
          className: "staff-log-cell",
          value: (row) => deviceOf(row.userAgent),
          mobile: "show",
          render: (row) => (
            <span className="small muted">
              {deviceOf(row.userAgent)}
              {row.trustedDevice && <span className="acc-block">Remembered device</span>}
              {detailed && row.ipAddress && <span className="acc-block">{addressOf(row.ipAddress)}</span>}
            </span>
          ),
        },
      ]}
      rows={rows}
      rowKey={(row) => row.id}
      pageSize={10}
      empty={empty}
      emptyIcon="history"
      emptyHint={emptyHint}
      rowClassName={(row) => (["locked", "wrong_password", "wrong_pin", "wrong_code"].includes(row.outcome) ? "dg-tone-warning" : "")}
    />
  );
}
