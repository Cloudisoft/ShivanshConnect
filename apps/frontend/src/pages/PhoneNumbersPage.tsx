import { useState } from 'react';
import { NumbersTab } from './phoneNumbers/NumbersTab';
import { ProviderConnectionsTab } from './phoneNumbers/ProviderConnectionsTab';

const TABS = ['Phone Numbers', 'Provider Connections'] as const;
type Tab = (typeof TABS)[number];

export function PhoneNumbersPage(): JSX.Element {
  const [tab, setTab] = useState<Tab>('Phone Numbers');

  return (
    <div>
      <h1 className="text-2xl font-semibold text-ink-900">Phone Numbers (DIDs)</h1>
      <p className="mt-1 text-sm text-ink-500">
        Connect Twilio/Telnyx or bring your own number, then assign each number to an AI agent.
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
        {tab === 'Phone Numbers' && <NumbersTab />}
        {tab === 'Provider Connections' && <ProviderConnectionsTab />}
      </div>
    </div>
  );
}
