import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ProtectedRoute } from './components/ProtectedRoute';
import { EmptyStatePlaceholder } from './components/EmptyStatePlaceholder';
import { NAV_ITEMS } from './lib/navigation';
import { LoginPage } from './pages/auth/LoginPage';
import { SignupPage } from './pages/auth/SignupPage';
import { ForgotPasswordPage } from './pages/auth/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/auth/ResetPasswordPage';
import { VerifyEmailPendingPage } from './pages/auth/VerifyEmailPendingPage';
import { AcceptInvitationPage } from './pages/auth/AcceptInvitationPage';
import { DashboardPage } from './pages/DashboardPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { CampaignsPage } from './pages/CampaignsPage';
import { CampaignDetailPage } from './pages/CampaignDetailPage';
import { DialingSettingsPage } from './pages/DialingSettingsPage';
import { DispositionsPage } from './pages/DispositionsPage';
import { CallbacksPage } from './pages/CallbacksPage';
import { CdrPage } from './pages/CdrPage';
import { LiveMonitorPage } from './pages/LiveMonitorPage';
import { UsersPage } from './pages/UsersPage';
import { LeadListsPage } from './pages/LeadListsPage';
import { LeadsPage } from './pages/LeadsPage';
import { LeadDetailPage } from './pages/LeadDetailPage';
import { AgentsPage } from './pages/AgentsPage';
import { AgentDetailPage } from './pages/AgentDetailPage';
import { ScriptsPage } from './pages/ScriptsPage';
import { VoicesPage } from './pages/VoicesPage';
import { PhoneNumbersPage } from './pages/PhoneNumbersPage';
import { MessagingPage } from './pages/MessagingPage';
import { SettingsLayout } from './pages/settings/SettingsLayout';
import { OrganizationSettingsPage } from './pages/settings/OrganizationSettingsPage';
import { ProfileSettingsPage } from './pages/settings/ProfileSettingsPage';
import { SecuritySettingsPage } from './pages/settings/SecuritySettingsPage';
import { RolesSettingsPage } from './pages/settings/RolesSettingsPage';
import { ComplianceSettingsPage } from './pages/settings/ComplianceSettingsPage';
import { IntegrationsSettingsPage } from './pages/settings/IntegrationsSettingsPage';
import { WebhookEventsSettingsPage } from './pages/settings/WebhookEventsSettingsPage';
import { ExportHistorySettingsPage } from './pages/settings/ExportHistorySettingsPage';
import { NotFoundPage } from './pages/NotFoundPage';

const placeholderNavItems = NAV_ITEMS.filter((item) => !item.builtInPhase1);

export default function App(): JSX.Element {
  return (
    <Routes>
      {/* Public / auth routes */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPendingPage />} />
      <Route path="/accept-invitation" element={<AcceptInvitationPage />} />

      {/* Authenticated app */}
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/campaigns" element={<CampaignsPage />} />
          <Route path="/campaigns/:id" element={<CampaignDetailPage />} />
          <Route path="/dialing-settings" element={<DialingSettingsPage />} />
          <Route path="/dispositions" element={<DispositionsPage />} />
          <Route path="/callbacks" element={<CallbacksPage />} />
          <Route path="/cdr" element={<CdrPage />} />
          <Route path="/live-monitor" element={<LiveMonitorPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/lead-lists" element={<LeadListsPage />} />
          <Route path="/leads" element={<LeadsPage />} />
          <Route path="/leads/:id" element={<LeadDetailPage />} />
          <Route path="/ai-agents" element={<AgentsPage />} />
          <Route path="/ai-agents/:id" element={<AgentDetailPage />} />
          <Route path="/scripts" element={<ScriptsPage />} />
          <Route path="/voices" element={<VoicesPage />} />
          <Route path="/dids" element={<PhoneNumbersPage />} />
          <Route path="/messaging" element={<MessagingPage />} />

          <Route path="/settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="/settings/organization" replace />} />
            <Route path="organization" element={<OrganizationSettingsPage />} />
            <Route path="profile" element={<ProfileSettingsPage />} />
            <Route path="security" element={<SecuritySettingsPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="roles" element={<RolesSettingsPage />} />
            <Route path="compliance" element={<ComplianceSettingsPage />} />
            <Route path="integrations" element={<IntegrationsSettingsPage />} />
            <Route path="webhook-events" element={<WebhookEventsSettingsPage />} />
            <Route path="exports" element={<ExportHistorySettingsPage />} />
          </Route>

          {placeholderNavItems.map((item) => (
            <Route
              key={item.id}
              path={item.path}
              element={<EmptyStatePlaceholder title={item.label} icon={item.icon} />}
            />
          ))}
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
