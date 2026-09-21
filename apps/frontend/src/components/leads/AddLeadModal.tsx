import { useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { Alert, Button, Card, Input, Label } from '../ui';
import { useCreateLead } from '../../hooks/useLeads';
import { ApiClientError } from '../../lib/apiClient';

export function AddLeadModal({
  leadListId,
  onClose,
}: {
  leadListId?: string;
  onClose: () => void;
}): JSX.Element {
  const createLead = useCreateLead();
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    phone: '',
    email: '',
  });
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createLead.mutateAsync({
        ...form,
        email: form.email || undefined,
        lead_list_id: leadListId ?? null,
      });
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not add this lead.');
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
      <Card className="relative w-full max-w-lg">
        <button className="absolute right-4 top-4 text-ink-400 hover:text-ink-700" onClick={onClose} type="button">
          <X className="h-4 w-4" />
        </button>
        <h2 className="text-sm font-semibold text-ink-900">Add lead</h2>
        <form className="mt-4 space-y-3" onSubmit={handleSubmit}>
          {error && <Alert>{error}</Alert>}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="first_name">First name</Label>
              <Input
                id="first_name"
                value={form.first_name}
                onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="last_name">Last name</Label>
              <Input
                id="last_name"
                value={form.last_name}
                onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="phone">Phone</Label>
            <Input
              id="phone"
              placeholder="(484) 555-1234"
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              required
            />
          </div>
          <div>
            <Label htmlFor="email">Email (optional)</Label>
            <Input
              id="email"
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
          </div>
          <Button type="submit" disabled={createLead.isPending}>
            {createLead.isPending ? 'Adding...' : 'Add lead'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
