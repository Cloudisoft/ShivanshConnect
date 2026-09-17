import { Loader2 } from 'lucide-react';

export function FullScreenSpinner(): JSX.Element {
  return (
    <div className="flex h-screen w-full items-center justify-center bg-ink-50">
      <Loader2 className="h-6 w-6 animate-spin text-ink-400" />
    </div>
  );
}
