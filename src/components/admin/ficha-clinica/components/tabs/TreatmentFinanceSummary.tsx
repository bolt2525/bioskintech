import {
  formatTreatmentAmount, getPackagePaidTotal, getTreatmentFinanceLabel, hasTreatmentFinanceTotals,
  type TreatmentPackage,
} from '../../types/treatment';

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
        {financeAvailable
          ? `En Finanzas ${formatTreatmentAmount(pkg.finance_registered_total)}`
          : getTreatmentFinanceLabel(pkg, annotated)}
      </p>
      <details className="text-gray-600">
        <summary className="admin-focus-ring cursor-pointer rounded py-1">Histórico de importes</summary>
        <div className="space-y-1 pt-1">
          <p>Anotado {formatTreatmentAmount(annotated)}</p>
          {financeAvailable ? <p>Diferencia histórica {formatTreatmentAmount(annotated - pkg.finance_registered_total)}</p> : null}
          <p>Abono inicial {formatTreatmentAmount(Number(pkg.initial_payment))} · {getTreatmentFinanceLabel(initialFinance, Number(pkg.initial_payment))}</p>
        </div>
      </details>
    </div>
  );
}
