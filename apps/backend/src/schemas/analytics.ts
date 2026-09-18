import { z } from 'zod';
import { ANALYTICS_PERIODS } from '@shivanshconnect/shared';

/**
 * Phase 12: shared period-filter validation for /dashboard,
 * /dashboard/charts, /analytics/campaigns/:id and /analytics/agents.
 * `custom` requires both date_from and date_to (validated as an actual
 * date range, from <= to) - every other period value ignores them.
 */
export const periodQuerySchema = z
  .object({
    period: z.enum(ANALYTICS_PERIODS).default('today'),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.period === 'custom') {
      if (!val.date_from || Number.isNaN(Date.parse(val.date_from))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['date_from'], message: 'A valid date_from is required for a custom period.' });
      }
      if (!val.date_to || Number.isNaN(Date.parse(val.date_to))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['date_to'], message: 'A valid date_to is required for a custom period.' });
      }
      if (val.date_from && val.date_to && !Number.isNaN(Date.parse(val.date_from)) && !Number.isNaN(Date.parse(val.date_to)) && new Date(val.date_from) > new Date(val.date_to)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['date_from'], message: 'date_from must be on or before date_to.' });
      }
    }
  });

export type PeriodQuery = z.infer<typeof periodQuerySchema>;
