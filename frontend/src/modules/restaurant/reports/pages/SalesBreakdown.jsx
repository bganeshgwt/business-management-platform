import SectionCard from "../../../../components/SectionCard";
import { moneyExact } from "../../../../services/format";

function AmountRow({ label, explanation, amount, currency, operation, total = false }) {
  return (
    <div className={`sales-breakdown-row${total ? " is-total" : ""}`}>
      <dt>
        <span>{label}</span>
        <small>{explanation}</small>
      </dt>
      <dd>
        {operation && <span className="sales-breakdown-sign">{operation} </span>}
        {moneyExact(amount, currency)}
      </dd>
    </div>
  );
}

export default function SalesBreakdown({ summary, currency }) {
  // Payments and refunds belong to these bills, even if recorded later.
  // Do not infer an unpaid balance here: that also needs each bill's credit notes.
  const kept = Math.round((summary.collected - summary.refunded) * 100) / 100;

  return (
    <SectionCard
      icon="receipt"
      tone="neutral"
      title="Sales & money received"
      description="See how your bills add up, then how much customers have paid."
      id="sales-breakdown"
    >
      <div className="sales-breakdown-grid">
        <section className="sales-breakdown-panel" aria-labelledby="sales-billed-heading">
          <h3 id="sales-billed-heading"><span aria-hidden="true">1</span> How bills add up</h3>
          <p className="sales-breakdown-intro">Amounts from bills in the selected period. Voided bills are excluded.</p>
          <dl className="sales-breakdown-amounts">
            <AmountRow label="Items before discounts" explanation="Food, drinks, add-ons and packaging, before tax."
              amount={summary.grossSales} currency={currency} />
            <AmountRow label="Less: discounts" explanation="Includes offers, loyalty points used and complimentary items."
              amount={summary.discounts} currency={currency} operation="−" />
            <AmountRow label="Add: service charge" explanation="The service charge added to these bills, if any."
              amount={summary.serviceCharge} currency={currency} operation="+" />
            {summary.deliveryCharges > 0 && (
              <AmountRow label="Add: delivery charges"
                explanation={`Charged for delivery on ${summary.deliveryChargeBills} ${summary.deliveryChargeBills === 1 ? "bill" : "bills"}, before tax (their GST is in the tax line).`}
                amount={summary.deliveryCharges} currency={currency} operation="+" />
            )}
            <AmountRow label="Add: tax" explanation="Tax charged on the bills, including any cess."
              amount={summary.tax} currency={currency} operation="+" />
            <AmountRow label="Rounding adjustment" explanation="Small additions or deductions to round the final bills."
              amount={Math.abs(summary.roundOff)} currency={currency} operation={summary.roundOff < 0 ? "−" : "+"} />
            <AmountRow label="Total billed (net sales)" explanation="Includes tax and service charge, before refunds."
              amount={summary.netSales} currency={currency} total />
          </dl>
        </section>

        <section className="sales-breakdown-panel" aria-labelledby="sales-received-heading">
          <h3 id="sales-received-heading"><span aria-hidden="true">2</span> Money received</h3>
          <p className="sales-breakdown-intro">Payments and refunds recorded so far for those same bills.</p>
          <dl className="sales-breakdown-amounts">
            <AmountRow label="Payments received" explanation="Customer payments across all payment methods."
              amount={summary.collected} currency={currency} />
            <AmountRow label="Less: refunds paid" explanation="Money already returned to customers."
              amount={summary.refunded} currency={currency} operation="−" />
            <AmountRow label="Money kept after refunds" explanation="Payments received minus refunds paid."
              amount={kept} currency={currency} total />
            {summary.tips > 0 && (
              <AmountRow label="Tips given on top" explanation="Tips guests added to their payments. Not sales: they belong to the staff."
                amount={summary.tips} currency={currency} />
            )}
          </dl>
          <div className="sales-breakdown-help">
            <h4>Why can these totals differ?</h4>
            <p>A bill counts in total billed even if it has not been fully paid. Refunds reduce the money kept,
              while the original bill total stays in this sales figure.</p>
            <p>Neither total is your profit. Expenses such as ingredients, salaries and rent are shown in Profit &amp; loss.</p>
          </div>
        </section>
      </div>

      <p className="sales-breakdown-timing">
        The date filter selects bills by their business date. Their payments and refunds may have been recorded later.
      </p>
      <details className="sales-breakdown-example">
        <summary>See a simple example</summary>
        <p>For example, items worth {moneyExact(1000, currency)} before tax, less a {moneyExact(100, currency)} discount,
          plus {moneyExact(45, currency)} tax, make a bill of <strong>{moneyExact(945, currency)}</strong>.
          This example has no service charge or rounding adjustment.</p>
        <p>If the customer pays {moneyExact(945, currency)} and you later refund {moneyExact(100, currency)},
          you keep <strong>{moneyExact(845, currency)}</strong>. The original total billed remains {moneyExact(945, currency)}.</p>
      </details>
    </SectionCard>
  );
}
