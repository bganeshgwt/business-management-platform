// Keep legacy demo terminal names out of payment selectors and saved receipts.
export function normalizePaymentLabels(value) {
  if (Array.isArray(value)) return value.map(normalizePaymentLabels);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    (key === 'name' || key === 'method_name') && typeof item === 'string'
      && /^Card\s*\(HDFC machine\)$/i.test(item.trim())
      ? 'Card'
      : normalizePaymentLabels(item),
  ]));
}
