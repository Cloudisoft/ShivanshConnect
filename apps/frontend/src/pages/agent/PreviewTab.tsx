import { useState } from 'react';
import { Send } from 'lucide-react';
import type { AgentPreviewMessage } from '@shivanshconnect/shared';
import { useAgentPreview } from '../../hooks/useAgents';
import { Alert, Button, Card, Input, Label } from '../../components/ui';
import { ApiClientError } from '../../lib/apiClient';

export function PreviewTab({ agentId }: { agentId: string }): JSX.Element {
  const preview = useAgentPreview(agentId);
  const [message, setMessage] = useState('');
  const [firstName, setFirstName] = useState('Alex');
  const [company, setCompany] = useState('Acme Co');
  const [history, setHistory] = useState<AgentPreviewMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim()) return;
    setError(null);
    const nextHistory = [...history, { role: 'user' as const, content: message }];
    setHistory(nextHistory);
    setMessage('');
    try {
      const result = await preview.mutateAsync({
        message,
        history,
        lead: { first_name: firstName, company },
      });
      setHistory([...nextHistory, { role: 'assistant' as const, content: result.reply }]);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'LLM_NOT_CONFIGURED') {
        setNotConfigured(true);
      } else {
        setError(err instanceof ApiClientError ? err.message : 'Preview failed.');
      }
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <h3 className="text-sm font-semibold text-ink-900">Sample lead</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="preview_first_name">First name</Label>
            <Input id="preview_first_name" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="preview_company">Company</Label>
            <Input id="preview_company" value={company} onChange={(e) => setCompany(e.target.value)} />
          </div>
        </div>
      </Card>

      {notConfigured && (
        <Alert variant="info">AI Agent preview requires an LLM provider to be configured in Settings.</Alert>
      )}
      {error && <Alert>{error}</Alert>}

      <Card>
        <h3 className="text-sm font-semibold text-ink-900">Conversation preview</h3>
        <div className="mt-3 max-h-96 space-y-3 overflow-y-auto">
          {history.length === 0 && <p className="text-sm text-ink-500">Send a message to preview how the agent would respond.</p>}
          {history.map((m, i) => (
            <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div
                className={
                  m.role === 'user'
                    ? 'max-w-md rounded-lg bg-ink-900 px-3 py-2 text-sm text-white'
                    : 'max-w-md rounded-lg bg-ink-100 px-3 py-2 text-sm text-ink-900'
                }
              >
                {m.content}
              </div>
            </div>
          ))}
        </div>
        <form className="mt-4 flex gap-2" onSubmit={handleSend}>
          <Input
            placeholder="Type a message as the caller..."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={notConfigured}
          />
          <Button type="submit" disabled={preview.isPending || notConfigured || !message.trim()}>
            <Send className="h-4 w-4" /> {preview.isPending ? 'Sending...' : 'Send'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
