import type { ClipboardEvent } from 'react';
import { normalizePlaceholders } from '@shivanshconnect/shared';

/**
 * Attach to a script/prompt textarea's onPaste: when the pasted text
 * contains placeholders in some other convention ([First Name],
 * <Phone Number>, %email%, {FirstName}, ...), rewrites them to this app's
 * {{variable}} syntax before inserting, and reports what changed via
 * setNotice. If there's nothing to normalize, the paste is left to the
 * browser's default handling untouched (native undo stack, etc. keep
 * working normally).
 */
export function handlePlaceholderPaste(
  e: ClipboardEvent<HTMLTextAreaElement>,
  currentValue: string,
  setValue: (next: string) => void,
  setNotice?: (message: string | null) => void,
): void {
  const pasted = e.clipboardData.getData('text');
  if (!pasted) return;

  const { text: normalized, replaced, unrecognized } = normalizePlaceholders(pasted);
  if (replaced.length === 0 && unrecognized.length === 0) return;

  e.preventDefault();
  const target = e.currentTarget;
  const start = target.selectionStart;
  const end = target.selectionEnd;
  const next = currentValue.slice(0, start) + normalized + currentValue.slice(end);
  setValue(next);

  if (setNotice) {
    const parts: string[] = [];
    if (replaced.length > 0) {
      parts.push(`Converted ${replaced.length} placeholder${replaced.length === 1 ? '' : 's'} to {{variable}} format.`);
    }
    if (unrecognized.length > 0) {
      parts.push(`Couldn't auto-map ${unrecognized.length} placeholder-like value${unrecognized.length === 1 ? '' : 's'} - review: ${unrecognized.join(', ')}.`);
    }
    setNotice(parts.join(' '));
  }

  const cursor = start + normalized.length;
  requestAnimationFrame(() => target.setSelectionRange(cursor, cursor));
}
