import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import StatTile from "../../../../components/StatTile";
import SectionCard from "../../../../components/SectionCard";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import Icon from "@bmp/ui/Icon";
import { ErrorMessage, Loading } from "../../../../components/Feedback";
import { listGiven } from "../../billing/services/discount.service";
import { getErrorMessage } from "../../../../services/api";
import { money, moneyExact } from "@bmp/shared/format";
import "../../../../styles/billing.css";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A business date as the lists show it: 23 Sep.
const dateText = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));

  return match ? `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]}` : "";
};

const GRID_ID = "given-at-till";
const PAGE_SIZES = [25, 50, 100];

// The rows a page the viewer last chose on the bill-by-bill grid (the grid
// keeps it under its id); the API pages, so the first request asks for it.
const rememberedPageSize = () => {
  try {
    const saved = JSON.parse(window.localStorage.getItem(`rmp.grid.${GRID_ID}`) || "null");
    const value = Number(saved && saved.pageSize);

    return PAGE_SIZES.includes(value) ? value : PAGE_SIZES[0];
  } catch {
    return PAGE_SIZES[0];
  }
};

const whatText = (row) =>
  row.kind === "complimentary"
    ? "No charge"
    : row.manualDiscount && row.manualDiscount.type === "percentage"
      ? `${row.manualDiscount.value}% off the bill`
      : row.manualDiscount
        ? "Amount off the bill"
        : "Off dishes";

// What was given away at the till: discounts on bills and dishes, and
// no-charge bills — by whom, approved by whom and why. The owner's check on
// the one thing a cashier can do to the takings without touching the drawer.
//
// It opens on the business day the till is trading on (the API picks it and
// says which); a week or a month is one click away.
export default function GivenAtTill({ currency = "₹" }) {
  // Empty until the first answer: the API then says which day "today" is.
  const [range, setRange] = useState({ from: "", to: "" });
  const [anchor, setAnchor] = useState(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(rememberedPageSize);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(
    () =>
      listGiven({ from: range.from, to: range.to, page, pageSize })
        .then((result) => {
          setData(result);
          setError("");

          // The first answer says which day "today" is: the quick picks
          // count from it.
          if (!range.from && !range.to) {
            setAnchor(result.to);
          }
        })
        .catch((err) => setError(getErrorMessage(err)))
        .finally(() => setLoading(false)),
    [range, page, pageSize]
  );

  useEffect(() => {
    load();
  }, [load]);

  const pickRange = (next) => {
    setRange(next);
    setPage(1);
  };

  const pickPage = ({ page: nextPage, pageSize: nextSize }) => {
    if (nextSize && nextSize !== pageSize) {
      setPageSize(nextSize);
      setPage(1);
      return;
    }

    setPage(nextPage);
  };

  // "Export CSV" takes every bill in the dates, not just this page.
  const fetchAll = async () => {
    const all = [];

    for (let next = 1; ; next += 1) {
      const result = await listGiven({ from: shown.from, to: shown.to, page: next, pageSize: 100 });
      all.push(...result.items);

      if (result.items.length < 100 || all.length >= result.total) {
        return all;
      }
    }
  };

  const staffColumns = [
    {
      key: "who",
      header: "Given by",
      value: (row) => row.label,
      mobile: "title",
      pin: true,
      render: (row) => <strong>{row.label}</strong>,
    },
    {
      key: "what",
      header: "What",
      value: (row) => (row.kind === "complimentary" ? "No-charge bills" : "Discounts"),
      mobile: "subtitle",
    },
    { key: "bills", header: "Bills", type: "number", value: (row) => row.bills, total: "sum" },
    { key: "approved", header: "With approval", type: "number", value: (row) => row.approved, total: "sum" },
    {
      key: "amount",
      header: "Given away",
      type: "money",
      exact: true,
      value: (row) => Number(row.amount),
      total: "sum",
      render: (row) => moneyExact(row.amount, currency),
    },
  ];

  const billColumns = [
    {
      key: "bill",
      header: "Bill",
      value: (row) => row.billNumber,
      mobile: "title",
      pin: true,
      render: (row) => (
        <span className="nowrap">
          <Link className="mono given-bill-link" to={`/bills?bill=${row.billId}`}>
            {row.billNumber}
          </Link>
          <span className="small muted"> · {row.tableNo ? `Table ${row.tableNo}` : row.orderNumber}</span>
        </span>
      ),
    },
    {
      key: "date",
      header: "Date",
      type: "date",
      value: (row) => row.businessDate,
      mobile: "subtitle",
      render: (row) => <span className="nowrap">{dateText(row.businessDate)}</span>,
    },
    {
      key: "what",
      header: "What",
      value: whatText,
      mobile: "show",
      render: (row) =>
        row.kind === "complimentary" ? <span className="badge badge-primary">No charge</span> : <span className="nowrap">{whatText(row)}</span>,
    },
    {
      key: "given",
      header: "Given",
      type: "money",
      exact: true,
      value: (row) => Number(row.amount),
      mobile: "show",
      render: (row) => (
        <span className="nowrap">
          {moneyExact(row.amount, currency)}
          <span className="small muted"> · {row.percent}%</span>
        </span>
      ),
    },
    {
      key: "reason",
      header: "Reason",
      value: (row) => [row.reasonLabel, row.note].filter(Boolean).join(" · "),
      mobile: "show",
      width: 220,
      render: (row) => (
        <span>
          {row.reasonLabel}
          {row.note ? <span className="small muted"> · {row.note}</span> : null}
        </span>
      ),
    },
    { key: "givenBy", header: "Given by", value: (row) => row.givenBy || "", mobile: "show" },
    {
      key: "approvedBy",
      header: "Approved by",
      value: (row) => row.approvedBy || "Own limit",
      mobile: "hide",
      render: (row) =>
        row.approvedBy ? (
          <span className="given-approved">
            <Icon name="shield" size={13} /> {row.approvedBy}
          </span>
        ) : (
          <span className="muted">Own limit</span>
        ),
    },
  ];

  // The dates on show: the ones picked, else the ones the API used.
  const shown = range.from || range.to || !data ? range : { from: data.from, to: data.to };
  const approved = data ? (data.approvedCount ?? data.items.filter((row) => row.approvedBy).length) : 0;
  const listed = data ? (data.total ?? data.items.length) : 0;

  return (
    <div className="stack">
      <div className="card money-filtercard">
        <div className="filters">
          <DateRangeFilter from={shown.from} to={shown.to} label="period" anchor={anchor} onChange={pickRange} />
        </div>
        <p className="muted small money-filtercard-note">
          Discounts typed in at the till and bills made no-charge — who gave them, why, and who approved.
        </p>
      </div>

      <ErrorMessage message={error} />

      {loading && !data ? (
        <Loading />
      ) : data ? (
        <>
          <div className="stat-grid">
            <StatTile
              icon="percent"
              tone="warning"
              label="Till discounts"
              value={money(data.totals.discountAmount, currency)}
              note={`${data.totals.discountBills} bill${data.totals.discountBills === 1 ? "" : "s"}`}
            />
            <StatTile
              icon="sparkles"
              tone="violet"
              label="No-charge bills"
              value={money(data.totals.complimentaryAmount, currency)}
              note={`${data.totals.complimentaryBills} bill${data.totals.complimentaryBills === 1 ? "" : "s"} · food value before tax`}
            />
            <StatTile
              icon="shield"
              tone="info"
              label="Needed a manager's PIN"
              value={String(approved)}
              note={`of ${listed} bill${listed === 1 ? "" : "s"} in these dates`}
            />
          </div>

          {data.byReason.length > 0 && (
            <SectionCard icon="pie" title="Why" description="Added up by reason over the whole period.">
              <div className="given-reasons">
                {data.byReason.map((row) => (
                  <div key={`${row.kind}-${row.label}`} className="given-reason">
                    <span className="given-kind">
                      <Icon name={row.kind === "complimentary" ? "sparkles" : "percent"} size={14} />
                      {row.label}
                      <span className="muted small"> · {row.bills}</span>
                    </span>
                    <strong>{money(row.amount, currency)}</strong>
                  </div>
                ))}
              </div>
            </SectionCard>
          )}

          {data.byStaff.length > 0 && (
            <SectionCard
              icon="users"
              title="Who gave them"
              description="Each person's discounts and no-charge bills, and how many a manager approved."
              flush
            >
              <DataGrid
                id="given-by-staff"
                caption="Who gave discounts and no-charge bills"
                variant="compact"
                pageSize={false}
                columns={staffColumns}
                rows={data.byStaff}
                rowKey={(row) => `${row.kind}-${row.label}`}
                currency={currency}
              />
            </SectionCard>
          )}

          <SectionCard
            icon="list"
            title="Bill by bill"
            description="Newest first. Open a bill to see it as the guest got it."
            flush
          >
            <DataGrid
              id={GRID_ID}
              caption="Bills with a discount or no charge"
              columns={billColumns}
              rows={data.items}
              rowKey={(row) => row.billId}
              loading={loading}
              empty="Nothing was given away at the till in these dates."
              emptyIcon="percent"
              emptyHint="Coupons are on the Offers tab; their uses are counted there. Pick wider dates to look further back."
              server={{ total: listed, page: data.page || page, pageSize, onChange: pickPage, fetchAll }}
              search={false}
              exportName="given-at-till"
              currency={currency}
            />
          </SectionCard>
        </>
      ) : null}
    </div>
  );
}
