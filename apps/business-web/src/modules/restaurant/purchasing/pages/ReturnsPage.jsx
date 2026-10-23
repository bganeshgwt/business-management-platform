import { useCallback, useEffect, useState } from "react";
import PageHeader from "../../../../components/PageHeader";
import SectionCard from "../../../../components/SectionCard";
import ActionMenu from "../../../../components/ActionMenu";
import Icon from "@bmp/ui/Icon";
import Modal from "../../../../components/Modal";
import DataGrid from "../../../../components/DataGrid/DataGrid";
import DateRangeFilter from "../../../../components/DateRangeFilter";
import { ErrorMessage, Loading, SuccessMessage } from "../../../../components/Feedback";
import {
  createPurchaseReturn,
  createSupplierPayment,
  getOutstanding,
  getPurchaseReturn,
  getReturnCreditLimit,
  listPurchaseReturns,
  listSupplierPayments,
  updatePurchaseReturn,
  updateSupplierPayment,
  voidPurchaseReturn,
  voidSupplierPayment,
} from "../services/purchaseReturn.service";
import { getPurchaseBill, listPurchaseBills } from "../services/purchase.service";
import { listSuppliers } from "../services/supplier.service";
import { listInventoryItems } from "../../inventory/services/inventory.service";
import { getRestaurant, getSettings } from "../../setup/services/restaurant.service";
import { getErrorMessage, outletStorage } from "../../../../services/api";
import { listOutlets } from "../../../../services/outlet.service";
import { monthStart, today } from "@bmp/shared/dates";
import { money, moneyExact } from "@bmp/shared/format";
import useAuth from "../../../../hooks/useAuth";
import useQueryFilter from "../../../../hooks/useQueryFilter";
import { Chip, ReasonDialog, Tabs, Tile } from "../../inventory/pages/stockUi";
import { GST_RATES, PAYMENT_METHODS, methodLabel, niceDate, qty, unitMoney } from "../../inventory/pages/stockFormat";
import SupplierStatementPanel from "./SupplierStatementPanel";
import { printDebitNote } from "./debitNoteDocument";
import { round2 } from "./lineMath";
import "../../../../styles/stock.css";
import "../../../../styles/backoffice.css";

const EMPTY_LINE = { inventoryItemId: "", quantity: "", unitPrice: "", taxRate: "0" };

// A return line with a key of its own, so the line grid keeps each row (and
// the box being typed in) in place when a line above is removed. The key is
// never sent: the save names each field it sends.
let lastLineKey = 0;
const emptyLine = () => {
  lastLineKey += 1;
  return { ...EMPTY_LINE, key: `line-${lastLineKey}` };
};

// Where the most a return line can be credited at comes from, as the
// correction dialog says it: "Up to ₹320.00/kg before GST — …".
const LIMIT_WORDS = {
  bill: "what the bill charged",
  order: "the most its order was billed at",
  supplier: "the most this supplier has billed",
  cost: "what it costs",
};

const AGE_KEYS = ["notDue", "days1to30", "days31to60", "days61to90", "days90plus"];
const AGE_LABELS = {
  notDue: "Not due",
  days1to30: "1–30 late",
  days31to60: "31–60",
  days61to90: "61–90",
  days90plus: "90+",
};

const EMPTY_PAYMENT = {
  supplierId: "",
  paymentDate: today(),
  amount: "",
  paymentMethod: "cash",
  referenceNo: "",
  notes: "",
  paidFromTill: false,
  goodsReceiptId: "",
};

// A thin bar of how a supplier's dues are spread by age, so the worst debts
// stand out down a long list.
function AgeBar({ ageing, total }) {
  if (!total) {
    return <div className="stk-age" aria-hidden="true" />;
  }

  return (
    <div className="stk-age" title={AGE_KEYS.map((key) => `${AGE_LABELS[key]}: ${ageing[key]}`).join(" · ")}>
      {AGE_KEYS.map((key, index) =>
        ageing[key] > 0 ? (
          <span key={key} className={`age-${index}`} style={{ width: `${(ageing[key] / total) * 100}%` }} />
        ) : null
      )}
    </div>
  );
}

export default function ReturnsPage() {
  const { hasPermission, user } = useAuth();
  const canReturn = hasPermission("purchasing.returns");
  const canPay = hasPermission("purchasing.pay");
  // What is owed, paid and the statements are money pages: for someone who
  // pays suppliers or reads the reports, not a store keeper (the server says
  // the same).
  const seesMoney = canPay || hasPermission("reports.view");
  const canReadProfile = hasPermission("restaurant.settings.view");

  const [tabParam, setTab] = useQueryFilter("tab", seesMoney ? "owed" : "returns");
  const tab = seesMoney || tabParam === "returns" ? tabParam : "returns";
  const [statementSupplier, setStatementSupplier] = useQueryFilter("supplier");
  const [billParam, setBillParam] = useQueryFilter("bill");

  // Returns and payments a page at a time, for the dates picked (this month
  // to start with), from the server: the lists only grow.
  const [listFrom, setListFrom] = useQueryFilter("from", monthStart());
  const [listTo, setListTo] = useQueryFilter("to", today());
  const [paging, setPaging] = useState({ page: 1, pageSize: 25 });
  const [listVersion, setListVersion] = useState(0);
  const [listData, setListData] = useState(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [outstanding, setOutstanding] = useState(null);
  const [suppliers, setSuppliers] = useState([]);
  const [items, setItems] = useState([]);
  const [currency, setCurrency] = useState("₹");
  // Who the debit note is from: the restaurant's name, address and GSTIN.
  const [place, setPlace] = useState({ name: user.restaurantName || "", address: "", gstin: "" });
  const [showVoid, setShowVoid] = useState(false);
  // Whose till pays a supplier in cash: the outlet the person works at, or
  // the one picked in the top bar; no outlet is the main till. The payment
  // records that branch, so its drawer and day-end take it off.
  const [pickedOutlet, setPickedOutlet] = useState(null);
  const [loading, setLoading] = useState(seesMoney);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [returnForm, setReturnForm] = useState(null);
  const [supplierBills, setSupplierBills] = useState([]);
  const [billLines, setBillLines] = useState(null);
  const [lines, setLines] = useState(() => [emptyLine()]);
  const [paymentForm, setPaymentForm] = useState(null);
  const [editingPayment, setEditingPayment] = useState(null);
  const [editingReturn, setEditingReturn] = useState(null);
  const [voiding, setVoiding] = useState(null); // { kind, row }
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  // What a return with no bill may credit, per "supplier:item": the ceiling
  // and the GST rates the supplier billed, so the form shows them up front
  // instead of the save failing.
  const [limits, setLimits] = useState({});

  const loadOutstanding = useCallback(
    () =>
      seesMoney
        ? getOutstanding()
            .then(setOutstanding)
            .catch((err) => setError(getErrorMessage(err)))
            .finally(() => setLoading(false))
        : Promise.resolve(),
    [seesMoney]
  );

  useEffect(() => {
    loadOutstanding();
  }, [loadOutstanding]);

  // One page of the returns or payments tab.
  useEffect(() => {
    if (tab !== "returns" && tab !== "payments") {
      return;
    }

    const params = {
      from: listFrom || undefined,
      to: listTo || undefined,
      status: showVoid ? undefined : "posted",
      limit: paging.pageSize,
      offset: (paging.page - 1) * paging.pageSize,
    };

    (tab === "returns" ? listPurchaseReturns(params) : listSupplierPayments(params))
      .then((data) => {
        setListData({ tab, ...data });
        setListError("");
      })
      .catch((err) => setListError(getErrorMessage(err)))
      .finally(() => setListLoading(false));
  }, [tab, listFrom, listTo, showVoid, paging, listVersion]);

  // After a return, a payment, a correction or a void: the balances and the
  // page on screen.
  const load = () => {
    loadOutstanding();
    setListLoading(true);
    setListVersion((value) => value + 1);
  };

  // Another section: its own first page.
  const openTab = (next) => {
    if (next !== tab) {
      setPaging((current) => ({ ...current, page: 1 }));
    }

    setTab(next);
  };

  const refilter = (apply) => {
    setListLoading(true);
    setPaging((current) => ({ ...current, page: 1 }));
    apply();
  };

  useEffect(() => {
    listSuppliers()
      .then((rows) => setSuppliers(rows))
      .catch(() => setSuppliers([]));

    listInventoryItems()
      .then(setItems)
      .catch(() => setItems([]));

    getSettings()
      .then((settings) => {
        setCurrency(settings.currencySymbol);
        setPlace((current) => ({ ...current, gstin: settings.gstNumber || "" }));
      })
      .catch(() => undefined);

    // The address on a debit note needs restaurant.settings.view; without it
    // (a store keeper) the note carries the restaurant's name only.
    if (canReadProfile) {
      getRestaurant()
        .then((restaurant) => setPlace((current) => ({ ...current, name: restaurant.name, address: restaurant.address || "" })))
        .catch(() => undefined);
    }
  }, [canReadProfile]);

  useEffect(() => {
    const chosen = outletStorage.get();

    if (user.outletName || !chosen) {
      return;
    }

    listOutlets()
      .then((rows) => {
        const found = rows.find((row) => String(row.id) === String(chosen));
        setPickedOutlet(found ? found.name : null);
      })
      .catch(() => setPickedOutlet(null));
  }, [user.outletName]);

  const tillWhere = user.outletName || pickedOutlet;

  // A return printed as a debit note (A4, or 80 mm for the thermal printer):
  // the full return is read first, so the note carries every line and the
  // supplier's GSTIN and address as they are on record.
  const printNote = async (row, compact = false) => {
    try {
      const full = await getPurchaseReturn(row.id);
      printDebitNote(full, { ...place, name: place.name || user.restaurantName, currency }, { compact });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const openCorrection = async (row) => {
    setFormError("");

    try {
      const full = await getPurchaseReturn(row.id);
      setEditingReturn({
        ...full,
        items: full.items.map((item) => ({
          ...item,
          unitPrice: String(item.unitPrice),
          originalPrice: item.unitPrice,
        })),
        changeReason: "",
        notes: full.notes || "",
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const activeSuppliers = suppliers.filter((row) => row.status === "active");

  // The bills a return can be made against: this supplier's, still standing.
  const loadBillsFor = useCallback((supplierId) => {
    if (!supplierId) {
      setSupplierBills([]);
      return;
    }

    listPurchaseBills({ supplierId, status: "posted", limit: 100 })
      .then((page) => setSupplierBills(page.items))
      .catch(() => setSupplierBills([]));
  }, []);

  const pickBill = async (billId) => {
    setReturnForm((form) => ({ ...form, goodsReceiptId: billId }));

    if (!billId) {
      setBillLines(null);
      return;
    }

    try {
      const bill = await getPurchaseBill(billId);

      setBillLines(
        bill.lines
          .filter((line) => line.quantity - line.returnedQuantity > 0)
          .map((line) => ({
            inventoryItemId: line.inventoryItemId,
            itemName: line.itemName,
            unitShortName: line.unitShortName,
            available: Math.round((line.quantity - line.returnedQuantity) * 1000) / 1000,
            paid: line.netUnitPrice,
            taxRate: line.taxRate,
            quantity: "",
            unitPrice: String(line.netUnitPrice),
          }))
      );
    } catch (err) {
      setFormError(getErrorMessage(err));
    }
  };

  const openReturn = async (supplierId = "", billId = "") => {
    const supplier = supplierId || (activeSuppliers[0] ? String(activeSuppliers[0].id) : "");

    setReturnForm({ supplierId: String(supplier), returnDate: today(), reason: "", notes: "", goodsReceiptId: "" });
    setLines([emptyLine()]);
    setBillLines(null);
    setFormError("");
    loadBillsFor(supplier);

    if (billId) {
      await pickBill(String(billId));
    }
  };

  // "Return goods" on a bill opens the return form already pointed at it.
  useEffect(() => {
    if (!billParam || !canReturn) {
      return;
    }

    getPurchaseBill(billParam)
      .then((bill) => {
        setTab("returns");
        setReturnForm({
          supplierId: String(bill.supplierId),
          returnDate: today(),
          reason: "",
          notes: "",
          goodsReceiptId: String(bill.id),
        });
        setLines([emptyLine()]);
        setFormError("");
        loadBillsFor(String(bill.supplierId));
        setBillLines(
          bill.lines
            .filter((line) => line.quantity - line.returnedQuantity > 0)
            .map((line) => ({
              inventoryItemId: line.inventoryItemId,
              itemName: line.itemName,
              unitShortName: line.unitShortName,
              available: Math.round((line.quantity - line.returnedQuantity) * 1000) / 1000,
              paid: line.netUnitPrice,
              taxRate: line.taxRate,
              quantity: "",
              unitPrice: String(line.netUnitPrice),
            }))
        );
      })
      .catch((err) => setError(getErrorMessage(err)))
      .finally(() => setBillParam(""));
  }, [billParam, canReturn, loadBillsFor, setBillParam, setTab]);

  const saveReturn = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    const chosen = billLines
      ? billLines
          .filter((line) => Number(line.quantity) > 0)
          .map((line) => ({
            inventoryItemId: Number(line.inventoryItemId),
            quantity: Number(line.quantity),
            unitPrice: Number(line.unitPrice || 0),
          }))
      : lines
          .filter((line) => line.inventoryItemId && Number(line.quantity) > 0)
          .map((line) => ({
            inventoryItemId: Number(line.inventoryItemId),
            quantity: Number(line.quantity),
            unitPrice: Number(line.unitPrice || 0),
            taxRate: rateFor(line),
          }));

    try {
      const saved = await createPurchaseReturn({
        supplierId: Number(returnForm.supplierId),
        goodsReceiptId: returnForm.goodsReceiptId ? Number(returnForm.goodsReceiptId) : null,
        returnDate: returnForm.returnDate,
        reason: returnForm.reason,
        notes: returnForm.notes || null,
        items: chosen,
      });

      setReturnForm(null);
      // What can still go back has changed; the next form asks again.
      setLimits({});
      setSuccess(`${saved.returnNumber} recorded — ${moneyExact(saved.totalAmount, currency)} credit, stock reduced`);
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const openPayment = (supplierId = "", amount = "") => {
    const supplier = supplierId || (activeSuppliers[0] ? String(activeSuppliers[0].id) : "");

    setPaymentForm({ ...EMPTY_PAYMENT, supplierId: String(supplier), amount: amount ? String(amount) : "", paymentDate: today() });
    loadBillsFor(supplier);
    setFormError("");
  };

  const savePayment = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    try {
      await createSupplierPayment({
        supplierId: Number(paymentForm.supplierId),
        goodsReceiptId: paymentForm.goodsReceiptId ? Number(paymentForm.goodsReceiptId) : null,
        paymentDate: paymentForm.paymentDate,
        amount: Number(paymentForm.amount),
        paymentMethod: paymentForm.paymentMethod,
        referenceNo: paymentForm.referenceNo || null,
        notes: paymentForm.notes || null,
        paidFromTill: paymentForm.paymentMethod === "cash" && paymentForm.paidFromTill,
      });

      setPaymentForm(null);
      setSuccess("Payment recorded");
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const saveEditedPayment = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    try {
      await updateSupplierPayment(editingPayment.id, {
        amount: Number(editingPayment.amount),
        paymentDate: editingPayment.paymentDate,
        paymentMethod: editingPayment.paymentMethod,
        referenceNo: editingPayment.referenceNo || null,
        notes: editingPayment.notes || null,
        paidFromTill: editingPayment.paymentMethod === "cash" && editingPayment.paidFromTill,
        changeReason: editingPayment.changeReason,
      });

      setEditingPayment(null);
      setSuccess("Payment corrected — the change and its reason are in the activity log");
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const saveEditedReturn = async (event) => {
    event.preventDefault();
    setFormError("");
    setSaving(true);

    try {
      const saved = await updatePurchaseReturn(editingReturn.id, {
        returnDate: editingReturn.returnDate,
        reason: editingReturn.reason,
        notes: editingReturn.notes || null,
        lines: editingReturn.items.map((item) => ({ id: item.id, unitPrice: Number(item.unitPrice || 0) })),
        changeReason: editingReturn.changeReason,
      });

      setEditingReturn(null);
      setSuccess(`${saved.returnNumber} corrected — credit now ${moneyExact(saved.totalAmount, currency)}`);
      load();
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const changeLine = (index, field, value) =>
    setLines(lines.map((line, position) => (position === index ? { ...line, [field]: value } : line)));

  // The limits still to fetch for a return with no bill: one per item picked,
  // for the supplier chosen.
  const freeSupplier = returnForm && !returnForm.goodsReceiptId ? returnForm.supplierId : "";
  const wantedLimits = freeSupplier
    ? [...new Set(lines.map((line) => String(line.inventoryItemId)).filter(Boolean))]
        .filter((itemId) => !(`${freeSupplier}:${itemId}` in limits))
        .join(",")
    : "";

  useEffect(() => {
    if (!freeSupplier || !wantedLimits) {
      return;
    }

    Promise.all(
      wantedLimits.split(",").map((itemId) =>
        getReturnCreditLimit(freeSupplier, itemId)
          .then((limit) => [itemId, limit])
          .catch(() => [itemId, null])
      )
    ).then((pairs) =>
      setLimits((current) => ({
        ...current,
        ...Object.fromEntries(pairs.map(([itemId, limit]) => [`${freeSupplier}:${itemId}`, limit])),
      }))
    );
  }, [freeSupplier, wantedLimits]);

  const limitFor = (line) =>
    freeSupplier && line.inventoryItemId ? limits[`${freeSupplier}:${line.inventoryItemId}`] : undefined;

  // The GST rate a line goes out at: the one picked, when the supplier ever
  // billed the item at it; otherwise the rate they last billed it at.
  const allowedRates = (line) => {
    const limit = limitFor(line);
    return limit && limit.rates ? limit.rates : null;
  };
  const rateFor = (line) => {
    const allowed = allowedRates(line);
    return allowed && !allowed.includes(Number(line.taxRate)) ? allowed[0] : Number(line.taxRate || 0);
  };

  // Whether a credit price is over what the server will accept, to say so
  // beside the box before the person presses save.
  const overLimit = (limit, unitPrice, taxRate) => {
    const price = Number(unitPrice || 0);

    if (!limit || !limit.basis || price <= 0) {
      return limit && !limit.basis && price > 0;
    }

    if (limit.basis === "cost") {
      return price * (1 + taxRate / 100) > limit.maxUnitPrice + 0.0001;
    }

    return limit.maxUnitPrice !== null && price > limit.maxUnitPrice + 0.0001;
  };

  // No more can go back to a supplier than they supplied, less what already
  // went back to them (the server refuses more, naming the item).
  const overQuantity = (line) => {
    const limit = limitFor(line);
    return Boolean(limit) && typeof limit.maxQuantity === "number" && Number(line.quantity || 0) > limit.maxQuantity + 0.0005;
  };
  const freeOverQuantity = !billLines && lines.some(overQuantity);
  const freeOver =
    !billLines && (freeOverQuantity || lines.some((line) => overLimit(limitFor(line), line.unitPrice, rateFor(line))));
  const correctionOver = editingReturn
    ? editingReturn.items.some(
        (item) =>
          Number(item.unitPrice) !== Number(item.originalPrice) &&
          overLimit({ basis: item.maxBasis, maxUnitPrice: item.maxUnitPrice }, item.unitPrice, item.taxRate)
      )
    : false;

  const freeTotal = lines.reduce((sum, line) => {
    const taxable = round2(Number(line.quantity || 0) * Number(line.unitPrice || 0));
    return sum + taxable + round2((taxable * rateFor(line)) / 100);
  }, 0);
  const billTotal = (billLines || []).reduce((sum, line) => {
    const taxable = round2(Number(line.quantity || 0) * Number(line.unitPrice || 0));
    return sum + taxable + round2((taxable * Number(line.taxRate || 0)) / 100);
  }, 0);

  const listRows = listData && listData.tab === tab ? listData.items : [];
  // Still reading this tab's first page (or a new one): the grid's skeleton.
  const listBusy = listLoading || !listData || listData.tab !== tab;
  const listTotal = listData && listData.tab === tab ? listData.total : 0;
  const listPaging = {
    total: listTotal,
    page: paging.page,
    pageSize: paging.pageSize,
    onChange: ({ page, pageSize }) => {
      setListLoading(true);
      setPaging({ page: pageSize !== paging.pageSize ? 1 : page, pageSize });
    },
  };
  const owing = outstanding ? outstanding.suppliers.filter((row) => row.outstanding !== 0 || row.purchased > 0) : [];

  const returnColumns = [
    {
      key: "number",
      header: "Return",
      value: (row) => row.returnNumber,
      pin: true,
      mobile: "title",
      render: (row) => (
        <span className="bo-cell-stack">
          <strong className="mono">{row.returnNumber}</strong>
          {row.status === "void" && (
            <span>
              <Chip tone="danger">Voided</Chip>
            </span>
          )}
        </span>
      ),
    },
    {
      key: "date",
      header: "Date",
      type: "date",
      value: (row) => row.returnDate,
      render: (row) => <span className="nowrap">{niceDate(row.returnDate)}</span>,
      mobile: "subtitle",
    },
    { key: "supplier", header: "Supplier", value: (row) => row.supplierName, mobile: "show" },
    {
      key: "against",
      header: "Against",
      value: (row) => (row.billNumber ? `Bill ${row.billNumber}` : row.receiptNumber || row.poNumber || ""),
      render: (row) => (
        <span className="small">{row.billNumber ? `Bill ${row.billNumber}` : row.receiptNumber || row.poNumber || "—"}</span>
      ),
      mobile: "show",
    },
    {
      key: "reason",
      header: "Reason",
      value: (row) => row.reason || "",
      render: (row) => (
        <span className="bo-cell-stack small">
          <span>{row.reason}</span>
          {row.status === "void" && row.voidReason && <span className="muted">Voided: {row.voidReason}</span>}
        </span>
      ),
      mobile: "hide",
    },
    {
      key: "credit",
      header: "Credit",
      type: "money",
      exact: true,
      value: (row) => (row.status === "void" ? 0 : row.totalAmount),
      csv: (row) => row.totalAmount,
      total: "sum",
      render: (row) => (
        <span className="bo-cell-stack">
          <strong className={row.status === "void" ? "bo-struck" : ""}>{moneyExact(row.totalAmount, currency)}</strong>
          {row.taxAmount > 0 && <span className="muted small">incl. GST {moneyExact(row.taxAmount, currency)}</span>}
        </span>
      ),
      mobile: "show",
    },
    {
      key: "actions",
      header: "",
      label: "Actions",
      type: "actions",
      render: (row) => (
        <span className="row-actions">
          <button type="button" className="link-button" onClick={() => printNote(row)}>
            <Icon name="print" size={14} /> Debit note
          </button>
          {canReturn && row.status !== "void" && (
            <button type="button" className="link-button" onClick={() => openCorrection(row)}>
              Correct
            </button>
          )}
          <ActionMenu
            label={`More for ${row.returnNumber}`}
            items={[
              { label: "Print debit note (A4)", icon: "print", onClick: () => printNote(row) },
              { label: "Print on the 80 mm printer", icon: "receipt", onClick: () => printNote(row, true) },
              ...(canReturn && row.status !== "void"
                ? [
                    { separator: true },
                    { label: "Void return", icon: "ban", danger: true, onClick: () => setVoiding({ kind: "return", row }) },
                  ]
                : []),
            ]}
          />
        </span>
      ),
    },
  ];

  const paymentColumns = [
    {
      key: "date",
      header: "Date",
      type: "date",
      value: (row) => row.paymentDate,
      pin: true,
      mobile: "title",
      render: (row) => (
        <span className="bo-cell-stack">
          <span className="nowrap">{niceDate(row.paymentDate)}</span>
          <span className="muted small mono">PAY-{String(row.id).padStart(4, "0")}</span>
        </span>
      ),
      csv: (row) => row.paymentDate,
    },
    { key: "supplier", header: "Supplier", value: (row) => row.supplierName, mobile: "subtitle" },
    {
      key: "how",
      header: "How",
      value: (row) => methodLabel(row.paymentMethod),
      render: (row) => (
        <span className="bo-cell-stack">
          <span>{methodLabel(row.paymentMethod)}</span>
          {row.paidFromTill && (
            <span>
              {/* The branch whose drawer the cash left. */}
              <Chip tone="warning">From the till{row.tillName ? ` · ${row.tillName}` : ""}</Chip>
            </span>
          )}
          {row.referenceNo && <span className="muted small mono">{row.referenceNo}</span>}
        </span>
      ),
      mobile: "show",
    },
    {
      key: "till",
      header: "Till",
      value: (row) => (row.paidFromTill ? row.tillName || "Main counter" : ""),
      defaultHidden: true,
    },
    {
      key: "against",
      header: "Against",
      value: (row) => (row.billNumber ? `Bill ${row.billNumber}` : row.receiptNumber || row.poNumber || "Account"),
      render: (row) => (
        <span className="small">{row.billNumber ? `Bill ${row.billNumber}` : row.receiptNumber || row.poNumber || "Account"}</span>
      ),
      mobile: "show",
      width: 130,
    },
    {
      key: "by",
      header: "By",
      value: (row) => row.createdByName || "",
      render: (row) => (
        <span className="bo-cell-stack small">
          <span>{row.createdByName || "—"}</span>
          {row.status === "void" && (
            <span>
              <Chip tone="danger">Voided</Chip> <span className="muted">{row.voidReason}</span>
            </span>
          )}
        </span>
      ),
      mobile: "hide",
    },
    {
      key: "amount",
      header: "Amount",
      type: "money",
      exact: true,
      value: (row) => (row.status === "void" ? 0 : row.amount),
      csv: (row) => row.amount,
      total: "sum",
      render: (row) => <strong className={row.status === "void" ? "bo-struck" : ""}>{moneyExact(row.amount, currency)}</strong>,
      mobile: "show",
    },
  ];

  if (canPay) {
    paymentColumns.push({
      key: "actions",
      header: "",
      label: "Actions",
      type: "actions",
      render: (row) =>
        row.status !== "void" ? (
          <span className="row-actions">
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setFormError("");
                setEditingPayment({
                  ...row,
                  amount: String(row.amount),
                  originalAmount: row.amount,
                  originalDate: row.paymentDate,
                  changeReason: "",
                  referenceNo: row.referenceNo || "",
                  notes: row.notes || "",
                });
              }}
            >
              Correct
            </button>
            <ActionMenu
              label={`More for PAY-${String(row.id).padStart(4, "0")}`}
              items={[{ label: "Void payment", icon: "ban", danger: true, onClick: () => setVoiding({ kind: "payment", row }) }]}
            />
          </span>
        ) : null,
    });
  }

  const showStatement = (supplierId) => {
    setStatementSupplier(String(supplierId));
    setTab("statement");
  };

  // Who we owe: one row per supplier with dues (or an advance), spread by
  // how late they are. The totals row adds up every supplier shown — the
  // same sums the server's "still owed" figure makes.
  const owedColumns = [
    {
      key: "supplier",
      header: "Supplier",
      value: (row) => row.supplierName,
      pin: true,
      mobile: "title",
      render: (row) => (
        <span className="bo-cell-stack">
          <strong>{row.supplierName}</strong>
          {(row.nextDueDate || (row.creditDays !== null && row.creditDays !== undefined)) && (
            <span className="muted small">
              {[
                row.creditDays !== null && row.creditDays !== undefined ? `${row.creditDays} days credit` : "",
                row.nextDueDate ? `next due ${niceDate(row.nextDueDate)}` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
          {row.mostDaysLate > 0 && (
            <span>
              <Chip tone={row.mostDaysLate > 60 ? "danger" : "warning"}>oldest {row.mostDaysLate} days late</Chip>
            </span>
          )}
        </span>
      ),
    },
    {
      key: "terms",
      width: 100,
      // Hidden at first so the row (with Pay) fits a laptop screen; the
      // supplier cell says the credit days. The Columns menu shows it.
      defaultHidden: true,
      header: "Terms",
      type: "number",
      align: "left",
      value: (row) => row.creditDays,
      csv: (row) =>
        [row.creditDays !== null && row.creditDays !== undefined ? `${row.creditDays} days` : "", row.paymentTerms || ""]
          .filter(Boolean)
          .join(" · "),
      mobile: "hide",
      render: (row) => (
        <span className="bo-cell-stack small">
          <span>{row.creditDays !== null && row.creditDays !== undefined ? `${row.creditDays} days` : "—"}</span>
          {row.paymentTerms && !row.paymentTerms.includes(`${row.creditDays} day`) && (
            <span className="muted">{row.paymentTerms}</span>
          )}
        </span>
      ),
    },
    {
      // Sorts (and exports) by how late the oldest bill is; shows the bar.
      key: "age",
      header: "Age of dues",
      type: "number",
      align: "left",
      value: (row) => row.mostDaysLate,
      csv: (row) => (row.mostDaysLate > 0 ? `oldest ${row.mostDaysLate} days late` : ""),
      minWidth: 110,
      mobile: "show",
      render: (row) => <AgeBar ageing={row.ageing} total={row.owed} />,
    },
    ...AGE_KEYS.map((key) => ({
      key,
      header: AGE_LABELS[key],
      type: "money",
      value: (row) => row.ageing[key],
      total: "sum",
      mobile: "hide",
      render: (row) =>
        row.ageing[key] > 0 ? (
          <span className={key !== "notDue" ? "stk-var-short" : ""}>{money(row.ageing[key], currency)}</span>
        ) : (
          <span className="dg-blank">—</span>
        ),
    })),
    {
      key: "owed",
      header: "Owed",
      type: "money",
      value: (row) => row.owed,
      total: "sum",
      mobile: "show",
      render: (row) =>
        row.advance > 0 ? (
          <Chip tone="info">{money(row.advance, currency)} advance</Chip>
        ) : (
          <strong className={row.owed > 0 ? "text-danger" : ""}>{money(row.owed, currency)}</strong>
        ),
    },
    {
      key: "actions",
      header: "",
      label: "Actions",
      type: "actions",
      render: (row) => (
        <span className="row-actions">
          {/* Pay is the everyday action on this list; the statement and a
              return go behind the menu, so the row keeps to the width of the
              table. */}
          {canPay ? (
            <button type="button" className="chip-button" onClick={() => openPayment(row.supplierId, row.owed || "")}>
              <Icon name="cash" size={14} /> Pay
            </button>
          ) : (
            <button type="button" className="link-button" onClick={() => showStatement(row.supplierId)}>
              Statement
            </button>
          )}
          {(canPay || canReturn) && (
            <ActionMenu
              label={`More for ${row.supplierName}`}
              items={[
                ...(canPay ? [{ label: "Statement", icon: "file", onClick: () => showStatement(row.supplierId) }] : []),
                ...(canReturn ? [{ label: "Return goods", icon: "undo", onClick: () => openReturn(row.supplierId) }] : []),
              ]}
            />
          )}
        </span>
      ),
    },
  ];

  // A return against a bill: each line still on the bill, how much of it to
  // send back and at what credit. ctx.index is the line's place in billLines
  // (an editor never sorts or pages).
  const setBillLine = (index, patch) =>
    setBillLines(billLines.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const billLineCredit = (line) => {
    const taxable = round2(Number(line.quantity || 0) * Number(line.unitPrice || 0));
    return taxable + round2((taxable * line.taxRate) / 100);
  };
  const billLineColumns = [
    {
      key: "item",
      header: "Item",
      value: (line) => line.itemName,
      minWidth: 200,
      render: (line) => (
        <>
          {line.itemName}
          <span className="stk-line-note">
            Bought at {unitMoney(line.paid, currency)}/{line.unitShortName} before GST
          </span>
        </>
      ),
    },
    {
      key: "available",
      header: "Can return",
      type: "number",
      value: (line) => line.available,
      width: 104,
      render: (line) => qty(line.available, line.unitShortName),
    },
    {
      key: "quantity",
      header: "Return",
      type: "number",
      value: (line) => Number(line.quantity) || 0,
      width: 104,
      render: (line, ctx) => (
        <input
          type="number"
          min="0"
          max={line.available}
          step="0.001"
          value={line.quantity}
          placeholder="0"
          onChange={(event) => setBillLine(ctx.index, { quantity: event.target.value })}
          aria-label={`${line.itemName} to return`}
        />
      ),
    },
    {
      key: "price",
      header: "Credit / unit",
      type: "number",
      value: (line) => Number(line.unitPrice) || 0,
      width: 120,
      render: (line, ctx) => (
        <input
          type="number"
          min="0"
          max={line.paid}
          step="any"
          value={line.unitPrice}
          onChange={(event) => setBillLine(ctx.index, { unitPrice: event.target.value })}
          aria-label={`${line.itemName} credit per unit`}
        />
      ),
    },
    { key: "gst", header: "GST", type: "percent", value: (line) => line.taxRate, width: 90, render: (line) => `${line.taxRate}%` },
    {
      key: "credit",
      header: "Credit",
      type: "money",
      exact: true,
      width: 110,
      value: billLineCredit,
      render: (line) => moneyExact(billLineCredit(line), currency),
    },
  ];

  // A return not tied to a bill: any item, with the most the supplier can
  // credit for it said under the item, and the GST rates they billed it at.
  const supplierName = returnForm
    ? (suppliers.find((row) => String(row.id) === String(returnForm.supplierId)) || {}).name
    : "";
  const itemOf = (line) => items.find((row) => String(row.id) === String(line.inventoryItemId));
  const freeLineCredit = (line) => {
    const taxable = round2(Number(line.quantity || 0) * Number(line.unitPrice || 0));
    return taxable + round2((taxable * rateFor(line)) / 100);
  };
  const freeLineColumns = [
    {
      key: "item",
      header: "Item",
      value: (line) => (itemOf(line) || {}).name || "",
      minWidth: 210,
      render: (line, ctx) => {
        const item = itemOf(line);
        const limit = limitFor(line);

        return (
          <>
            <select
              value={line.inventoryItemId}
              onChange={(event) =>
                // The credit price is left for the person to fill: the
                // item's cost includes GST, a credit does not.
                changeLine(ctx.index, "inventoryItemId", event.target.value)
              }
              required
              aria-label={ctx.label}
            >
              <option value="">Select item</option>
              {items.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                  {option.currentStock === null
                    ? " (being counted)"
                    : ` (${qty(option.currentStock, option.unitShortName)} in stock)`}
                </option>
              ))}
            </select>
            {item && limit && limit.basis === "supplier" && (
              <span className="stk-line-note">
                Up to {unitMoney(limit.maxUnitPrice, currency)}/{item.unitShortName} before GST, the most{" "}
                {supplierName || "this supplier"} has billed it at · GST {limit.rates.map((r) => `${r}%`).join(" or ")}
              </span>
            )}
            {item && limit && limit.basis === "cost" && (
              <span className="stk-line-note">
                {supplierName || "This supplier"} has not billed it here: up to{" "}
                {unitMoney(limit.maxUnitPrice, currency)}/{item.unitShortName} with GST, what it costs
              </span>
            )}
            {item && limit && !limit.basis && (
              <span className="stk-line-note">
                No price on record for it: choose the bill it came on, or enter the credit as {currency}0
              </span>
            )}
            {item && limit && typeof limit.maxQuantity === "number" && (
              <span className={`stk-line-note ${limit.maxQuantity <= 0 ? "stk-var-short" : ""}`}>
                {limit.supplied <= 0
                  ? `${supplierName || "This supplier"} has not supplied it here, so none can go back to them`
                  : limit.maxQuantity <= 0
                    ? `All ${qty(limit.supplied, item.unitShortName)} they supplied has already gone back`
                    : `Up to ${qty(limit.maxQuantity, item.unitShortName)} can go back — they supplied ${qty(limit.supplied, item.unitShortName)}${limit.returned > 0 ? `, ${qty(limit.returned, item.unitShortName)} already returned` : ""}`}
              </span>
            )}
          </>
        );
      },
    },
    {
      key: "quantity",
      header: "Quantity",
      type: "number",
      value: (line) => Number(line.quantity) || 0,
      width: 104,
      render: (line, ctx) => {
        const item = itemOf(line);

        return (
          <>
            <input
              type="number"
              min="0.001"
              step="0.001"
              value={line.quantity}
              onChange={(event) => changeLine(ctx.index, "quantity", event.target.value)}
              required
              aria-label={ctx.label}
              aria-invalid={overQuantity(line) || undefined}
            />
            {overQuantity(line) && (
              <span className="stk-line-warn">
                More than the {qty(limitFor(line).maxQuantity, item ? item.unitShortName : "")} that can go back
              </span>
            )}
          </>
        );
      },
    },
    {
      key: "price",
      header: "Credit / unit",
      type: "number",
      value: (line) => Number(line.unitPrice) || 0,
      width: 120,
      render: (line, ctx) => {
        const over = overLimit(limitFor(line), line.unitPrice, rateFor(line));

        return (
          <>
            <input
              type="number"
              min="0"
              step="any"
              value={line.unitPrice}
              onChange={(event) => changeLine(ctx.index, "unitPrice", event.target.value)}
              required
              placeholder="Before GST"
              aria-label={`Credit per unit, line ${ctx.serial}`}
              aria-invalid={over || undefined}
            />
            {over && <span className="stk-line-warn">Over the limit</span>}
          </>
        );
      },
    },
    {
      key: "gst",
      header: "GST",
      type: "number",
      value: (line) => rateFor(line),
      width: 84,
      render: (line, ctx) => {
        const rates = allowedRates(line) || GST_RATES;

        return (
          <select
            value={rateFor(line)}
            onChange={(event) => changeLine(ctx.index, "taxRate", event.target.value)}
            aria-label={`GST rate, line ${ctx.serial}`}
            disabled={rates.length === 1}
            title={allowedRates(line) ? "The rate this supplier billed it at" : undefined}
          >
            {rates.map((option) => (
              <option key={option} value={option}>
                {option}%
              </option>
            ))}
          </select>
        );
      },
    },
    {
      key: "credit",
      header: "Credit",
      type: "money",
      exact: true,
      width: 110,
      value: freeLineCredit,
      render: (line) => moneyExact(freeLineCredit(line), currency),
    },
    {
      key: "remove",
      header: "",
      label: "Remove",
      type: "actions",
      render: (line, ctx) =>
        lines.length > 1 ? (
          <button
            type="button"
            className="stk-remove"
            aria-label={`Remove line ${ctx.serial}`}
            onClick={() => setLines(lines.filter((unused, i) => i !== ctx.index))}
          >
            <Icon name="x" size={16} />
          </button>
        ) : null,
    },
  ];

  // Correcting a return: only the credit per unit can change (the stock
  // already left), each checked against the most the supplier can credit.
  const correctionColumns = editingReturn
    ? [
        {
          key: "item",
          header: "Item",
          value: (item) => item.itemName,
          minWidth: 200,
          render: (item) => (
            <>
              {item.itemName}
              {item.maxBasis && item.maxUnitPrice !== null && (
                <span className="stk-line-note">
                  Up to {unitMoney(item.maxUnitPrice, currency)}/{item.unitShortName}
                  {item.maxBasis === "cost" ? " with GST" : " before GST"} — {LIMIT_WORDS[item.maxBasis]}
                </span>
              )}
              {item.maxBasis !== undefined && item.maxUnitPrice === null && (
                <span className="stk-line-note">No price on record: only {currency}0 can be credited</span>
              )}
            </>
          ),
        },
        {
          key: "returned",
          header: "Returned",
          type: "number",
          value: (item) => item.quantity,
          width: 104,
          render: (item) => qty(item.quantity, item.unitShortName),
        },
        {
          key: "price",
          header: "Credit / unit",
          type: "number",
          value: (item) => Number(item.unitPrice) || 0,
          width: 120,
          render: (item, ctx) => {
            const limit = { basis: item.maxBasis, maxUnitPrice: item.maxUnitPrice };
            const changed = Number(item.unitPrice) !== Number(item.originalPrice);
            const over = changed && overLimit(limit, item.unitPrice, item.taxRate);

            return (
              <>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={item.unitPrice}
                  onChange={(event) =>
                    setEditingReturn({
                      ...editingReturn,
                      items: editingReturn.items.map((row, i) =>
                        i === ctx.index ? { ...row, unitPrice: event.target.value } : row
                      ),
                    })
                  }
                  aria-label={`${item.itemName} credit per unit`}
                  aria-invalid={over || undefined}
                />
                {over && <span className="stk-line-warn">Over the limit</span>}
              </>
            );
          },
        },
        { key: "gst", header: "GST", type: "percent", value: (item) => item.taxRate, width: 90, render: (item) => `${item.taxRate}%` },
      ]
    : [];

  const tabs = [
    { key: "owed", label: "Who we owe", icon: "wallet", money: true },
    { key: "statement", label: "Supplier statement", short: "Statement", icon: "file", money: true },
    { key: "returns", label: "Returns", icon: "undo" },
    { key: "payments", label: "Payments", icon: "cash", money: true },
  ].filter((entry) => seesMoney || !entry.money);

  // What each list is, said once above it.
  const listHead = {
    owed: {
      icon: "wallet",
      title: "Who we owe",
      description: "Each supplier's unpaid bills by how late they are. Pay settles the oldest bills first.",
    },
    returns: {
      icon: "undo",
      title: "Returns",
      description: "Goods sent back to suppliers. Each one is a credit against what you owe them.",
    },
    payments: {
      icon: "cash",
      title: "Payments",
      description: "Money paid to suppliers, and what it was paid against.",
    },
  }[tab];

  return (
    <div className="stack stk-page">
      <PageHeader
        icon="wallet"
        title="Supplier accounts"
        description="What you owe each supplier and when it falls due, what you have paid, and what went back."
        action={
          <div className="stk-actions">
            {canPay && (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => openPayment()}
                disabled={activeSuppliers.length === 0}
              >
                <Icon name="cash" size={16} /> Record payment
              </button>
            )}
            {canReturn && (
              <button
                type="button"
                className="button"
                onClick={() => openReturn()}
                disabled={activeSuppliers.length === 0 || items.length === 0}
              >
                <Icon name="undo" size={16} /> Return goods
              </button>
            )}
          </div>
        }
      />

      <ErrorMessage message={error} />
      <SuccessMessage message={success} />

      {outstanding && (
        <div className="stat-grid">
          <Tile
            icon="wallet"
            label="Still owed"
            value={money(outstanding.totals.outstanding, currency)}
            tone={outstanding.totals.outstanding > 0 ? "danger" : undefined}
            note={(() => {
              const owedTo = outstanding.suppliers.filter((row) => row.owed > 0).length;
              return `to ${owedTo} supplier${owedTo === 1 ? "" : "s"}, after their advances`;
            })()}
          />
          <Tile
            icon="clock"
            label="Overdue"
            value={money(outstanding.totals.overdue, currency)}
            tone={outstanding.totals.overdue > 0 ? "warning" : undefined}
            note="past the credit days"
          />
          <Tile
            icon="arrow-right"
            label="Advances with suppliers"
            value={money(outstanding.totals.advance, currency)}
            tone={outstanding.totals.advance > 0 ? "info" : undefined}
            note={(() => {
              const held = outstanding.suppliers.filter((row) => row.advance > 0).length;
              return held
                ? `${held} supplier${held === 1 ? " holds" : "s hold"} it; it comes off their next bill by itself`
                : "nothing paid ahead";
            })()}
          />
          <Tile
            icon="receipt"
            label="Bought, all time"
            value={money(outstanding.totals.purchased, currency)}
            note={`${money(outstanding.totals.returned, currency)} returned · ${money(outstanding.totals.paid, currency)} paid`}
          />
        </div>
      )}

      {outstanding && outstanding.tillToday && outstanding.tillToday.count > 0 && (
        <div className="alert alert-notice">
          <span>
            <strong>{moneyExact(outstanding.tillToday.amount, currency)}</strong> went to suppliers from the till today (
            {outstanding.tillToday.count === 1 ? "1 payment" : `${outstanding.tillToday.count} payments`}) — the drawer
            holds that much less cash at the day-end count.{" "}
            <button type="button" className="link-button" onClick={() => openTab("payments")}>
              See payments
            </button>
          </span>
        </div>
      )}

      <Tabs tabs={tabs} active={tab} onChange={openTab} label="Supplier account sections" />

      {tab === "statement" && (
        <SupplierStatementPanel
          suppliers={suppliers}
          supplierId={statementSupplier}
          onSupplierChange={setStatementSupplier}
          currency={currency}
          restaurantName={user.restaurantName}
        />
      )}

      {tab !== "statement" && listHead && (
        <SectionCard
          icon={listHead.icon}
          title={listHead.title}
          description={listHead.description}
          actions={
            tab === "owed" ? (
              <div className="stk-legend" aria-hidden="true">
                {AGE_KEYS.map((key, index) => (
                  <span key={key}>
                    <i className={`age-${index}`} />
                    {AGE_LABELS[key]}
                  </span>
                ))}
              </div>
            ) : (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={showVoid}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    refilter(() => setShowVoid(checked));
                  }}
                />
                <span>Show voided entries</span>
              </label>
            )
          }
          flush
        >
          {loading ? (
            <div className="stk-pad">
              <Loading />
            </div>
          ) : tab === "owed" ? (
            <DataGrid
              id="supplier-dues"
              caption="Who we owe"
              columns={owedColumns}
              rows={owing}
              rowKey={(row) => row.supplierId}
              empty="Nothing owed to any supplier."
              emptyIcon="check-circle"
              emptyHint="Bills entered on credit show up here with their due dates."
              rowNoun={["supplier", "suppliers"]}
              currency={currency}
              exportName="supplier-dues"
            />
          ) : (
            <>
              <div className="stk-filterbar filters">
                <DateRangeFilter
                  from={listFrom}
                  to={listTo}
                  label={tab === "returns" ? "return dates" : "payment dates"}
                  onChange={(range) =>
                    refilter(() => {
                      setListFrom(range.from);
                      setListTo(range.to);
                    })
                  }
                />
              </div>
              {tab === "returns" ? (
                <DataGrid
                  id="purchase-returns"
                  caption="Purchase returns"
                  columns={returnColumns}
                  rows={listRows}
                  rowKey={(row) => row.id}
                  loading={listBusy}
                  error={listError}
                  onRetry={load}
                  empty="No returns in these dates."
                  emptyIcon="undo"
                  emptyHint="Damaged or wrong goods sent back to a supplier show here, each one printable as a debit note. Pick older dates to see earlier ones."
                  rowClassName={(row) => (row.status === "void" ? "dg-tone-muted" : "")}
                  server={listPaging}
                  exportName="purchase-returns"
                  currency={currency}
                />
              ) : (
                <DataGrid
                  id="supplier-payments"
                  caption="Supplier payments"
                  columns={paymentColumns}
                  rows={listRows}
                  rowKey={(row) => row.id}
                  loading={listBusy}
                  error={listError}
                  onRetry={load}
                  empty="No payments in these dates."
                  emptyIcon="cash"
                  emptyHint="Record a payment when you pay a supplier, so what you owe them comes down. Pick older dates to see earlier ones."
                  rowClassName={(row) => (row.status === "void" ? "dg-tone-muted" : "")}
                  server={listPaging}
                  exportName="supplier-payments"
                  currency={currency}
                />
              )}
            </>
          )}
        </SectionCard>
      )}

      {returnForm && (
        <Modal
          title="Return goods to a supplier"
          description="Stock goes back out, and the supplier owes you a credit (a debit note)."
          icon="undo"
          onClose={() => setReturnForm(null)}
          width={820}
        >
          <form className="stack stk-scope" onSubmit={saveReturn}>
            <ErrorMessage message={formError} />

            <div className="form-grid">
              <label className="field">
                <span>Supplier</span>
                <select
                  value={returnForm.supplierId}
                  onChange={(event) => {
                    setReturnForm({ ...returnForm, supplierId: event.target.value, goodsReceiptId: "" });
                    setBillLines(null);
                    loadBillsFor(event.target.value);
                  }}
                  required
                >
                  {activeSuppliers.map((supplier) => (
                    <option key={supplier.id} value={supplier.id}>
                      {supplier.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>From which bill</span>
                <select value={returnForm.goodsReceiptId} onChange={(event) => pickBill(event.target.value)}>
                  <option value="">Not from a recorded bill</option>
                  {supplierBills.map((bill) => (
                    <option key={bill.id} value={bill.id}>
                      {bill.billNumber ? `Bill ${bill.billNumber}` : bill.receiptNumber} · {niceDate(bill.billDate)} ·{" "}
                      {moneyExact(bill.totalAmount, currency)}
                    </option>
                  ))}
                </select>
                <small className="muted">Tied to a bill, the credit is checked against what was bought and its GST</small>
              </label>

              <label className="field">
                <span>Date</span>
                <input
                  type="date"
                  value={returnForm.returnDate}
                  min={
                    returnForm.goodsReceiptId
                      ? (supplierBills.find((bill) => String(bill.id) === String(returnForm.goodsReceiptId)) || {}).receivedDate
                      : undefined
                  }
                  max={today()}
                  onChange={(event) => setReturnForm({ ...returnForm, returnDate: event.target.value })}
                  required
                />
              </label>

              <label className="field">
                <span>Reason</span>
                <input
                  value={returnForm.reason}
                  onChange={(event) => setReturnForm({ ...returnForm, reason: event.target.value })}
                  placeholder="Damaged in transit, sour on arrival"
                  required
                  maxLength={200}
                />
              </label>
            </div>

            {billLines ? (
              billLines.length === 0 ? (
                <div className="alert alert-notice">Everything on this bill has already been returned.</div>
              ) : (
                <div className="stk-lines">
                  {/* Its own key: the grid reads rowKey once, so the bill's
                      lines and the free lines must never share one grid. */}
                  <DataGrid
                    variant="editor"
                    key="bill-lines"
                    caption="Lines on the bill to return"
                    columns={billLineColumns}
                    rows={billLines}
                    rowKey={(line) => line.inventoryItemId}
                    currency={currency}
                  />
                </div>
              )
            ) : (
              <div className="stk-lines stack">
                <DataGrid
                  variant="editor"
                  key="free-lines"
                  caption="Lines to return"
                  columns={freeLineColumns}
                  rows={lines}
                  rowKey={(line) => line.key}
                  currency={currency}
                />
                <div>
                  <button
                    type="button"
                    className="button button-secondary button-sm"
                    onClick={() => setLines([...lines, emptyLine()])}
                  >
                    <Icon name="plus" size={15} /> Add line
                  </button>
                </div>
              </div>
            )}

            <div className="stk-foot">
              <p className="muted small">
                Stock goes down at once. A credit price never changes what the item costs in recipes. Use ₹0 when
                the supplier replaces the goods instead of giving credit.
              </p>
              <dl className="stk-totals">
                <dt className="is-grand">Credit due</dt>
                <dd className="is-grand">{moneyExact(billLines ? billTotal : freeTotal, currency)}</dd>
              </dl>
            </div>

            <div className="form-actions">
              <button type="button" className="button button-secondary" onClick={() => setReturnForm(null)}>
                Cancel
              </button>
              <button
                type="submit"
                className="button"
                disabled={saving || freeOver}
                title={
                  freeOverQuantity
                    ? "More is going back than the supplier supplied"
                    : freeOver
                      ? "A credit is over what the supplier can give"
                      : undefined
                }
              >
                {saving ? "Saving…" : "Record return"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {paymentForm && (
        <Modal
          title="Record a supplier payment"
          description="Brings down what you owe them. Settles their oldest bills first unless you pick one."
          icon="cash"
          onClose={() => setPaymentForm(null)}
          width={560}
        >
          <form className="form-grid stk-scope" onSubmit={savePayment}>
            <ErrorMessage message={formError} />

            <label className="field">
              <span>Supplier</span>
              <select
                value={paymentForm.supplierId}
                onChange={(event) => {
                  setPaymentForm({ ...paymentForm, supplierId: event.target.value, goodsReceiptId: "" });
                  loadBillsFor(event.target.value);
                }}
                required
              >
                {activeSuppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Amount ({currency})</span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={paymentForm.amount}
                onChange={(event) => setPaymentForm({ ...paymentForm, amount: event.target.value })}
                required
                autoFocus
              />
            </label>

            <label className="field">
              <span>Date</span>
              <input
                type="date"
                value={paymentForm.paymentDate}
                max={today()}
                onChange={(event) => setPaymentForm({ ...paymentForm, paymentDate: event.target.value })}
                required
              />
            </label>

            <label className="field">
              <span>Paid by</span>
              <select
                value={paymentForm.paymentMethod}
                onChange={(event) => setPaymentForm({ ...paymentForm, paymentMethod: event.target.value })}
              >
                {PAYMENT_METHODS.map((method) => (
                  <option key={method.value} value={method.value}>
                    {method.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>For bill</span>
              <select
                value={paymentForm.goodsReceiptId}
                onChange={(event) => setPaymentForm({ ...paymentForm, goodsReceiptId: event.target.value })}
              >
                <option value="">The account (oldest bills first)</option>
                {supplierBills
                  .filter((bill) => bill.paymentMode === "credit")
                  .map((bill) => (
                    <option key={bill.id} value={bill.id}>
                      {bill.billNumber ? `Bill ${bill.billNumber}` : bill.receiptNumber} · {niceDate(bill.billDate)} ·{" "}
                      {moneyExact(bill.totalAmount, currency)}
                    </option>
                  ))}
              </select>
            </label>

            <label className="field">
              <span>Reference</span>
              <input
                value={paymentForm.referenceNo}
                onChange={(event) => setPaymentForm({ ...paymentForm, referenceNo: event.target.value })}
                placeholder="NEFT / UPI / cheque number"
                maxLength={50}
              />
            </label>

            {paymentForm.paymentMethod === "cash" && (
              <label className="checkbox field-wide">
                <input
                  type="checkbox"
                  checked={paymentForm.paidFromTill}
                  onChange={(event) => setPaymentForm({ ...paymentForm, paidFromTill: event.target.checked })}
                />
                <span>
                  Cash taken from {tillWhere ? `the ${tillWhere} till` : "the main counter till"} today — recorded against that
                  branch, so its drawer and day-end cash count take it off
                </span>
              </label>
            )}

            <label className="field field-wide">
              <span>Notes</span>
              <input value={paymentForm.notes} onChange={(event) => setPaymentForm({ ...paymentForm, notes: event.target.value })} />
            </label>

            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setPaymentForm(null)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving}>
                {saving ? "Saving…" : "Record payment"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {editingPayment && (
        <Modal
          title={`Correct payment PAY-${String(editingPayment.id).padStart(4, "0")}`}
          description="The change and its reason are kept with the payment."
          icon="edit"
          onClose={() => setEditingPayment(null)}
          width={560}
        >
          <form className="form-grid stk-scope" onSubmit={saveEditedPayment}>
            <ErrorMessage message={formError} />
            <p className="muted small field-wide">
              {editingPayment.supplierName} · was {moneyExact(editingPayment.originalAmount, currency)} on{" "}
              {niceDate(editingPayment.originalDate)}. The old figures and your reason go
              in the activity log.
            </p>
            <label className="field">
              <span>Amount ({currency})</span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={editingPayment.amount}
                onChange={(event) => setEditingPayment({ ...editingPayment, amount: event.target.value })}
                required
              />
            </label>
            <label className="field">
              <span>Date</span>
              <input
                type="date"
                value={editingPayment.paymentDate}
                max={today()}
                onChange={(event) => setEditingPayment({ ...editingPayment, paymentDate: event.target.value })}
                required
              />
            </label>
            <label className="field">
              <span>Paid by</span>
              <select
                value={editingPayment.paymentMethod}
                onChange={(event) => setEditingPayment({ ...editingPayment, paymentMethod: event.target.value })}
              >
                {PAYMENT_METHODS.map((method) => (
                  <option key={method.value} value={method.value}>
                    {method.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Reference</span>
              <input
                value={editingPayment.referenceNo}
                onChange={(event) => setEditingPayment({ ...editingPayment, referenceNo: event.target.value })}
                maxLength={50}
              />
            </label>
            <label className="field field-wide">
              <span>Why is it being changed?</span>
              <input
                value={editingPayment.changeReason}
                onChange={(event) => setEditingPayment({ ...editingPayment, changeReason: event.target.value })}
                placeholder="Typed 5,000 — paid 4,500"
                required
                maxLength={200}
              />
            </label>
            <div className="form-actions field-wide">
              <button type="button" className="button button-secondary" onClick={() => setEditingPayment(null)}>
                Cancel
              </button>
              <button type="submit" className="button" disabled={saving}>
                {saving ? "Saving…" : "Save correction"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {editingReturn && (
        <Modal
          title={`Correct return ${editingReturn.returnNumber}`}
          description="The change and its reason are kept with the return."
          icon="edit"
          onClose={() => setEditingReturn(null)}
          width={640}
        >
          <form className="stack stk-scope" onSubmit={saveEditedReturn}>
            <ErrorMessage message={formError} />
            <p className="muted small">
              Change the credit the supplier gave, the date or the reason. Quantities cannot change — the stock
              already left. To change them, void this return and record it again.
            </p>
            <div className="form-grid">
              <label className="field">
                <span>Date</span>
                <input
                  type="date"
                  value={editingReturn.returnDate}
                  min={editingReturn.goodsArrivedOn || undefined}
                  max={today()}
                  onChange={(event) => setEditingReturn({ ...editingReturn, returnDate: event.target.value })}
                />
                {editingReturn.goodsArrivedOn && (
                  <small className="muted">Not before {niceDate(editingReturn.goodsArrivedOn)}, when the goods arrived</small>
                )}
              </label>
              <label className="field">
                <span>Reason</span>
                <input
                  value={editingReturn.reason}
                  onChange={(event) => setEditingReturn({ ...editingReturn, reason: event.target.value })}
                  maxLength={200}
                />
              </label>
            </div>
            <div className="stk-lines">
              <DataGrid
                variant="editor"
                caption={`Lines on ${editingReturn.returnNumber}`}
                columns={correctionColumns}
                rows={editingReturn.items}
                rowKey={(item) => item.id}
                cardsBelow={480}
                currency={currency}
              />
            </div>
            <label className="field">
              <span>Why is it being changed?</span>
              <input
                value={editingReturn.changeReason}
                onChange={(event) => setEditingReturn({ ...editingReturn, changeReason: event.target.value })}
                placeholder="Supplier's credit note says ₹300"
                required
                maxLength={200}
              />
            </label>
            <div className="form-actions">
              <button type="button" className="button button-secondary" onClick={() => setEditingReturn(null)}>
                Cancel
              </button>
              <button
                type="submit"
                className="button"
                disabled={saving || correctionOver}
                title={correctionOver ? "A credit is over what the supplier can give" : undefined}
              >
                {saving ? "Saving…" : "Save correction"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {voiding && (
        <ReasonDialog
          title={voiding.kind === "payment" ? "Void this payment?" : `Void ${voiding.row.returnNumber}?`}
          message={
            voiding.kind === "payment"
              ? `${moneyExact(voiding.row.amount, currency)} to ${voiding.row.supplierName} stops counting as paid. It stays on the list, struck through, with your reason.`
              : `The goods go back into stock and the ${moneyExact(voiding.row.totalAmount, currency)} credit no longer counts. It stays on the list, struck through, with your reason.`
          }
          placeholder={voiding.kind === "payment" ? "Cheque bounced / entered twice" : "Supplier took the goods back after all"}
          confirmLabel={voiding.kind === "payment" ? "Void payment" : "Void return"}
          onCancel={() => setVoiding(null)}
          onConfirm={async (reason) => {
            if (voiding.kind === "payment") {
              await voidSupplierPayment(voiding.row.id, reason);
              setSuccess("Payment voided");
            } else {
              await voidPurchaseReturn(voiding.row.id, reason);
              setSuccess(`${voiding.row.returnNumber} voided and the goods put back in stock`);
            }

            setVoiding(null);
            load();
          }}
        />
      )}
    </div>
  );
}
