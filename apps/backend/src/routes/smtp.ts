import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok } from '../lib/response.js';
import { encryptCredentials } from '../lib/crypto/credentials.js';
import { saveSmtpSettingsSchema, testSmtpSettingsSchema } from '../schemas/smtp.js';
import { sendTestEmail, type SmtpSettingsRow } from '../services/smtpProvider.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS } from '@shivanshconnect/shared';
import { ValidationError } from '../lib/errors.js';

/**
 * Phase 13: SMTP settings (master spec section 39). One row per org.
 * POST /settings/smtp saves/updates it (password encrypted at rest,
 * never returned); POST /settings/smtp/test sends a REAL test email via
 * nodemailer and reports nodemailer's own real success/failure.
 */
export async function smtpSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requirePermission('settings.manage'));

  // GET /api/v1/settings/smtp - never returns the password, not even
  // masked (username is enough of a preview; there is no safe partial
  // reveal of an SMTP password worth showing).
  app.get('/', async (req) => {
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const { data, error } = await supabase.from('smtp_settings').select('id, organization_id, host, port, username, encryption, from_name, from_email, status, last_tested_at, last_error, created_at, updated_at').eq('organization_id', orgId).maybeSingle();
    if (error) throw error;
    return ok(data ?? null);
  });

  // POST /api/v1/settings/smtp - create or update. `password` is optional
  // on update (omitting it keeps the currently-stored encrypted value).
  app.post('/', async (req) => {
    const body = saveSmtpSettingsSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: existing } = await supabase.from('smtp_settings').select('*').eq('organization_id', orgId).maybeSingle();
    if (!body.password && !existing) {
      throw new ValidationError('A password is required when configuring SMTP for the first time.');
    }

    const encryptedPassword = body.password ? encryptCredentials({ password: body.password }) : existing!.encrypted_password;

    const row = {
      organization_id: orgId,
      host: body.host,
      port: body.port,
      username: body.username,
      encrypted_password: encryptedPassword,
      encryption: body.encryption,
      from_name: body.from_name,
      from_email: body.from_email,
      // Changing settings invalidates the last connection check - never
      // claim "connected" for configuration that hasn't been tested yet.
      status: 'not_configured' as const,
      last_tested_at: null,
      last_error: null,
      created_by: req.user!.id,
    };

    let saved: Record<string, any>;
    if (existing) {
      const { data, error } = await supabase.from('smtp_settings').update(row).eq('id', existing.id).select('id, organization_id, host, port, username, encryption, from_name, from_email, status, last_tested_at, last_error, created_at, updated_at').single();
      if (error) throw error;
      saved = data;
    } else {
      const { data, error } = await supabase.from('smtp_settings').insert(row).select('id, organization_id, host, port, username, encryption, from_name, from_email, status, last_tested_at, last_error, created_at, updated_at').single();
      if (error) throw error;
      saved = data;
    }

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.SMTP_SETTINGS_SAVED,
      entityType: 'smtp_settings',
      entityId: saved.id,
      newValue: { host: body.host, port: body.port, username: body.username, from_email: body.from_email },
      ipAddress: req.ip,
    });

    return ok(saved, { message: 'SMTP settings saved.' });
  });

  // POST /api/v1/settings/smtp/test - a REAL send via nodemailer to a
  // caller-supplied recipient. Never a simulated/fake success.
  app.post('/test', async (req) => {
    const body = testSmtpSettingsSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: settings, error } = await supabase.from('smtp_settings').select('*').eq('organization_id', orgId).maybeSingle();
    if (error) throw error;
    if (!settings) {
      throw new ValidationError('SMTP is not configured yet. Save settings before testing.');
    }

    let success = true;
    let errorMessage: string | null = null;
    try {
      await sendTestEmail(settings as SmtpSettingsRow, body.recipient);
    } catch (err) {
      success = false;
      errorMessage = err instanceof Error ? err.message : 'The test email could not be sent.';
    }

    const { data: updated, error: updateError } = await supabase
      .from('smtp_settings')
      .update({
        status: success ? 'connected' : 'error',
        last_tested_at: new Date().toISOString(),
        last_error: success ? null : errorMessage,
      })
      .eq('id', settings.id)
      .select('id, organization_id, host, port, username, encryption, from_name, from_email, status, last_tested_at, last_error, created_at, updated_at')
      .single();
    if (updateError) throw updateError;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.SMTP_TEST_SENT,
      entityType: 'smtp_settings',
      entityId: settings.id,
      newValue: { recipient: body.recipient, success },
      ipAddress: req.ip,
    });

    return ok({ success, error: errorMessage, settings: updated }, { message: success ? 'Test email sent successfully.' : errorMessage ?? 'Test email failed.' });
  });
}
