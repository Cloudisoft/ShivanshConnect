import type { LucideIcon } from 'lucide-react';
import { Construction } from 'lucide-react';

interface Props {
  title: string;
  icon?: LucideIcon;
}

/**
 * Honest placeholder for a sidebar module not yet built in this phase.
 * Deliberately plain - no fake metrics, no "Coming soon" gimmick button,
 * just a clear statement of status so the sidebar IA is fully navigable
 * today and modules light up as their build phase lands.
 */
export function EmptyStatePlaceholder({ title, icon: Icon = Construction }: Props): JSX.Element {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-ink-900">{title}</h1>
      <div className="mt-8 flex flex-col items-center justify-center rounded-lg border border-dashed border-ink-300 bg-white px-6 py-20 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-ink-100">
          <Icon className="h-6 w-6 text-ink-400" />
        </div>
        <p className="mt-4 text-sm font-medium text-ink-700">
          This module is scheduled for a later build phase.
        </p>
        <p className="mt-1 max-w-sm text-sm text-ink-500">
          It isn't part of this release yet, so there's nothing to show here. It will appear once
          its phase is built.
        </p>
      </div>
    </div>
  );
}
