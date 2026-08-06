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
      {/* Wraps below `sm`: a long title plus the actions slot (toggles, a
          search box, selects) overflows a 375px card on one line, so the
          actions take their own full-width row there and sit back beside the
          title from `sm` up. */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 className="text-sm font-medium text-gray-200">{title}</h2>
        {actions && (
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            {actions}
          </div>
        )}
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
