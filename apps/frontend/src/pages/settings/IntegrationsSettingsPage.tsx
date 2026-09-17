import { Lock } from 'lucide-react';
import { Card } from '../../components/ui';

const SECTIONS = [
  { name: 'Vapi (AI voice agents)', note: 'Arrives with the AI Agents & Voices build phase.' },
  { name: 'Twilio / Telnyx (telephony)', note: 'Arrives with the Numbers & Dialing build phase.' },
  { name: 'SMTP (outbound email)', note: 'Arrives with the Notifications build phase.' },
  { name: 'Object storage (recordings & imports)', note: 'Arrives with the Leads & Recordings build phases.' },
  { name: 'Redis / job queues', note: 'Arrives with the Campaigns & Dialing build phase.' },
];

export function IntegrationsSettingsPage(): JSX.Element {
  return (
    <div>
      <h2 className="text-base font-semibold text-ink-900">Integrations</h2>
      <p className="mt-1 text-sm text-ink-500">
        These connect ShivanshConnect to outside providers. None are configurable yet in this
        phase - each becomes a real, working settings form only once its build phase lands, so
        nothing here is a placeholder you could mistake for a working integration.
      </p>
      <div className="mt-6 divide-y divide-ink-100 rounded-lg border border-ink-200 bg-white">
        {SECTIONS.map((section) => (
          <div key={section.name} className="flex items-center justify-between px-5 py-4">
            <div>
              <p className="text-sm font-medium text-ink-800">{section.name}</p>
              <p className="text-xs text-ink-500">{section.note}</p>
            </div>
            <Lock className="h-4 w-4 flex-shrink-0 text-ink-300" />
          </div>
        ))}
      </div>
      <Card className="mt-6">
        <p className="text-xs text-ink-500">
          See the root README for the full phase plan and what each future build phase covers.
        </p>
      </Card>
    </div>
  );
}
