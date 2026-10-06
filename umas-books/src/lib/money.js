// The ONE place customer-facing euro amounts are formatted.
//   formatEuro(12.5, "fr") -> "12,50 €"   (non-breaking space before the euro sign, what Intl produces)
//   formatEuro(12.5, "en") -> "€12.50"    (no thousands separator, as the site always printed)
// null / undefined / "" / NaN give "" so a caller can print it unguarded.
// Numbers only: JSON APIs keep returning numbers, never formatted strings.
const formatters = {
  en: new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", useGrouping: false }),
  fr: new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }),
};

function formatEuro(amount, lang) {
  if (amount === null || amount === undefined || amount === "") return "";
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";
  return (lang === "fr" ? formatters.fr : formatters.en).format(n);
}

module.exports = { formatEuro };
