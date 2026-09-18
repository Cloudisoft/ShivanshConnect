import { PROMPT_VARIABLES } from '@shivanshconnect/shared';

/**
 * The {{variable}} palette used across AI agent prompts/scripts
 * (pages/agent/ConfigurationTab.tsx, pages/agent/ScriptsTab.tsx,
 * pages/CampaignDetailPage.tsx) - extracted here as the one shared
 * component so Phase 13's SMS/email templates reuse it rather than
 * re-implementing the same click-to-copy chip list a fourth time.
 */
export function VariablePalette({ onInsert }: { onInsert?: (token: string) => void }): JSX.Element {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {PROMPT_VARIABLES.map((v) => (
        <code
          key={v}
          className="cursor-pointer rounded bg-ink-100 px-1.5 py-0.5 text-[11px] text-ink-600 hover:bg-ink-200"
          title={onInsert ? 'Click to insert' : 'Click to copy'}
          onClick={() => {
            const token = `{{${v}}}`;
            if (onInsert) onInsert(token);
            else navigator.clipboard?.writeText(token).catch(() => undefined);
          }}
        >
          {`{{${v}}}`}
        </code>
      ))}
    </div>
  );
}
