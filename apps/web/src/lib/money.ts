// Money is stored as a bigint count of minor units, and no table records a
// decimal exponent, so this renders two fractional digits for every currency.
// That is a display convention, not a conversion: the figure is the stored
// value, nothing is annualised, prorated or relabelled, and a currency whose
// minor unit is not a hundredth would be misread - which is why the value
// stays next to its own currency code instead of being called a salary period
// or an invoice total.
// Grouping is done here rather than with Intl.NumberFormat so the separators
// do not depend on the locale data of whichever machine renders it.
export function formatMinorAmount(minorUnits: number, currency: string): string {
  const whole = Math.floor(minorUnits / 100);
  const fraction = minorUnits % 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}.${String(fraction).padStart(2, '0')} ${currency}`;
}
