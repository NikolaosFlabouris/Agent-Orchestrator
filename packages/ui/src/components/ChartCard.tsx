import type { ReactNode } from 'react';

export interface ChartCardProps {
  title: ReactNode;
  /** Right-aligned controls in the panel header (toggles, legends). */
  actions?: ReactNode;
  /** When true, render the empty-state placeholder instead of children. */
  empty?: boolean;
  emptyLabel?: string;
  /** Optional DOM id on the card's <section>, for hash deep-links. */
  id?: string;
  children: ReactNode;
}

/** Titled panel wrapper for the Reports page charts/tables. Owns the card
 *  chrome, the header (title + optional actions slot), and a graceful
 *  empty-state placeholder so a no-data range renders a message rather than
 *  an empty/zero-height chart. Built reusable for later reporting tasks. */
export function ChartCard({
  title,
  actions,
  empty = false,
  emptyLabel = 'No data in this range',
  id,
  children,
}: ChartCardProps) {
  return (
    <section
      id={id}
      className="rounded-lg border border-gray-800 bg-gray-900 p-4"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-gray-200">{title}</h2>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {empty ? (
        <div className="flex h-40 items-center justify-center text-sm text-gray-600">
          {emptyLabel}
        </div>
      ) : (
        children
      )}
    </section>
  );
}
