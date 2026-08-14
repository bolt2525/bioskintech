/**
 * Ícono discreto de ayuda con tooltip — usar junto a labels de formulario.
 * Usage: <FieldHelp text="Descripción del campo" />
 */
import { HelpCircle } from 'lucide-react';
import { Tooltip } from '../../../ui/Tooltip';

export default function FieldHelp({ text }: { text: string }) {
  return (
    <Tooltip content={text}>
      <HelpCircle className="w-3.5 h-3.5 text-gray-300 hover:text-gray-500 cursor-help inline ml-1 align-middle shrink-0" />
    </Tooltip>
  );
}
