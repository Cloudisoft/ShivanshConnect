import { useState } from 'react';
import { VoicesTab } from './voice/VoicesTab';
import { ProviderConnectionsTab } from './voice/ProviderConnectionsTab';
import { CloneVoiceTab } from './voice/CloneVoiceTab';

const TABS = ['Voices', 'Provider Connections', 'Clone Voice'] as const;
type Tab = (typeof TABS)[number];

export function VoicesPage(): JSX.Element {
  const [tab, setTab] = useState<Tab>('Voices');

  return (
    <div>
      <h1 className="text-2xl font-semibold text-ink-900">Voices</h1>
      <p className="mt-1 text-sm text-ink-500">
        Connect voice providers, sync or clone voices, and preview them before attaching to an AI agent.
      </p>

      <div className="mt-6 border-b border-ink-200">
        <nav className="-mb-px flex gap-6 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={
                tab === t
                  ? 'whitespace-nowrap border-b-2 border-gold-500 pb-3 text-sm font-medium text-ink-900'
                  : 'whitespace-nowrap border-b-2 border-transparent pb-3 text-sm font-medium text-ink-500 hover:text-ink-700'
              }
            >
              {t}
            </button>
          ))}
        </nav>
      </div>

      <div className="mt-6">
        {tab === 'Voices' && <VoicesTab />}
        {tab === 'Provider Connections' && <ProviderConnectionsTab />}
        {tab === 'Clone Voice' && <CloneVoiceTab />}
      </div>
    </div>
  );
}
