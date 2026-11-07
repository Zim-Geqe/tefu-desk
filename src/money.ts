export function assertCurrency(value: string): string {
  const currency = value.toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Currency must be a three-letter ISO code');
  try { new Intl.NumberFormat('en', { style: 'currency', currency }).format(0); }
  catch { throw new Error('Currency is not recognized by this runtime'); }
  return currency;
}

export function formatMinor(amount: number, currency: string): string {
  const exponent = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return new Intl.NumberFormat('en', { style: 'currency', currency, minimumFractionDigits: exponent, maximumFractionDigits: exponent }).format(amount / (10 ** exponent));
}

export function calculate(items: Array<{ quantity: number; unitPriceMinor: number }>): number {
  return items.reduce((sum, item) => {
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10000) throw new Error('Invalid quantity');
    if (!Number.isSafeInteger(item.unitPriceMinor) || item.unitPriceMinor < 0) throw new Error('Invalid item price');
    const line = item.quantity * item.unitPriceMinor;
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(sum + line)) throw new Error('Order total exceeds supported range');
    return sum + line;
  }, 0);
}
