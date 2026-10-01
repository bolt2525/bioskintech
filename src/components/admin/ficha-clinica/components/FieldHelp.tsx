/**
 * Ícono discreto de ayuda con tooltip — usar junto a labels de formulario.
 * Usage: <FieldHelp text="Descripción del campo" />
 */
import { HelpCircle } from 'lucide-react';
import { Tooltip } from '../../../ui/Tooltip';

export default function FieldHelp({ text }: { text: string }) {
  return (
    <Tooltip content={text}>
      <button type="button" className="admin-focus-ring ml-1 inline-flex min-h-8 min-w-8 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600" aria-label="Mostrar ayuda del campo">
        <HelpCircle className="h-3.5 w-3.5 shrink-0" />
      </button>
    </Tooltip>
  );
}
