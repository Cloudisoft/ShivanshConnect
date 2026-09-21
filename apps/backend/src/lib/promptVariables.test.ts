import { describe, expect, it } from 'vitest';
import { renderTemplate } from './promptVariables.js';

/**
 * Phase 13 reuses this exact helper for SMS message bodies and email
 * subject/HTML rendering (services/smsDispatcher.ts,
 * services/emailDispatcher.ts) rather than duplicating the {{variable}}
 * substitution logic a third time - tested once here, not per call site.
 */
describe('renderTemplate', () => {
  it('substitutes known variables', () => {
    expect(renderTemplate('Hi {{first_name}} {{last_name}}, your appointment is confirmed', { first_name: 'Ada', last_name: 'Lovelace' })).toBe('Hi Ada Lovelace, your appointment is confirmed');
  });

  it('substitutes custom_field.<key> variables', () => {
    expect(renderTemplate('Order #{{custom_field.order_id}}', { custom_field: { order_id: 'A100' } })).toBe('Order #A100');
  });

  it('leaves an unmapped variable as literal text rather than an empty string', () => {
    expect(renderTemplate('Hi {{first_name}}, your code is {{promo_code}}', { first_name: 'Ada' })).toBe('Hi Ada, your code is {{promo_code}}');
  });

  it('tolerates extra whitespace inside the braces', () => {
    expect(renderTemplate('Hi {{ first_name }}', { first_name: 'Ada' })).toBe('Hi Ada');
  });

  it('is idempotent against a template with no variables', () => {
    expect(renderTemplate('No variables here.', {})).toBe('No variables here.');
  });
});
