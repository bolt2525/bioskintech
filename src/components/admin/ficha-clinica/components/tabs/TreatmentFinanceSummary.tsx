import {
  formatTreatmentAmount, getPackagePaidTotal, getTreatmentFinanceLabel, hasTreatmentFinanceTotals,
  type TreatmentPackage,
} from '../../types/treatment';

/** Importes clínicos y asientos son fuentes distintas, no una conciliación. */
export default function TreatmentFinanceSummary({ pkg }: { pkg: TreatmentPackage }) {
  const annotated = getPackagePaidTotal(pkg);
  const financeAvailable = hasTreatmentFinanceTotals(pkg);
  const initialFinance = {
    finance_record_count: pkg.initial_finance_record_count,
    finance_registered_total: pkg.initial_finance_registered_total,
  };
  return (
    <div className="space-y-1 text-[11px] tabular-nums">
      <p className="font-semibold text-gray-800">
        Anotado {formatTreatmentAmount(annotated)} / {financeAvailable
          ? `En Finanzas ${formatTreatmentAmount(pkg.finance_registered_total)}`
          : getTreatmentFinanceLabel(pkg, annotated)}
        {financeAvailable ? <> / Diferencia {formatTreatmentAmount(annotated - pkg.finance_registered_total)}</> : null}
      </p>
      <p className="text-gray-600">
        Inicial anotado {formatTreatmentAmount(Number(pkg.initial_payment))} · {getTreatmentFinanceLabel(initialFinance, Number(pkg.initial_payment))}
      </p>
    </div>
  );
}
