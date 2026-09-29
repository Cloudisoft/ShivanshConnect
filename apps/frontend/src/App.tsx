import { Suspense } from 'react';
import { lazyPage } from './lib/lazyPage';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ProtectedRoute } from './components/ProtectedRoute';
import { EmptyStatePlaceholder } from './components/EmptyStatePlaceholder';
import { FullScreenSpinner } from './components/FullScreenSpinner';
import { NAV_ITEMS } from './lib/navigation';

// Every page is loaded on demand rather than bundled into the single
// initial JS payload - before this, the whole app (every settings tab,
// every campaign/agent/lead page, auth screens, all of it) shipped as one
// 1.2MB/322KB-gzipped chunk that had to be downloaded and parsed before
// even the login screen could render. Route-level code splitting means a
// visit only ever pays for the page it's actually on.
const LoginPage = lazyPage(() => import('./pages/auth/LoginPage'), (m) => m.LoginPage);
const SignupPage = lazyPage(() => import('./pages/auth/SignupPage'), (m) => m.SignupPage);
const ForgotPasswordPage = lazyPage(() => import('./pages/auth/ForgotPasswordPage'), (m) => m.ForgotPasswordPage);
const ResetPasswordPage = lazyPage(() => import('./pages/auth/ResetPasswordPage'), (m) => m.ResetPasswordPage);
const VerifyEmailPendingPage = lazyPage(() => import('./pages/auth/VerifyEmailPendingPage'), (m) => m.VerifyEmailPendingPage);
const AcceptInvitationPage = lazyPage(() => import('./pages/auth/AcceptInvitationPage'), (m) => m.AcceptInvitationPage);
const DashboardPage = lazyPage(() => import('./pages/DashboardPage'), (m) => m.DashboardPage);
const AnalyticsPage = lazyPage(() => import('./pages/AnalyticsPage'), (m) => m.AnalyticsPage);
const CampaignsPage = lazyPage(() => import('./pages/CampaignsPage'), (m) => m.CampaignsPage);
const CampaignDetailPage = lazyPage(() => import('./pages/CampaignDetailPage'), (m) => m.CampaignDetailPage);
const DialingSettingsPage = lazyPage(() => import('./pages/DialingSettingsPage'), (m) => m.DialingSettingsPage);
const DispositionsPage = lazyPage(() => import('./pages/DispositionsPage'), (m) => m.DispositionsPage);
const CallbacksPage = lazyPage(() => import('./pages/CallbacksPage'), (m) => m.CallbacksPage);
const QueuesPage = lazyPage(() => import('./pages/QueuesPage'), (m) => m.QueuesPage);
const InboundRoutesPage = lazyPage(() => import('./pages/InboundRoutesPage'), (m) => m.InboundRoutesPage);
const CdrPage = lazyPage(() => import('./pages/CdrPage'), (m) => m.CdrPage);
const LiveMonitorPage = lazyPage(() => import('./pages/LiveMonitorPage'), (m) => m.LiveMonitorPage);
const UsersPage = lazyPage(() => import('./pages/UsersPage'), (m) => m.UsersPage);
const LeadListsPage = lazyPage(() => import('./pages/LeadListsPage'), (m) => m.LeadListsPage);
const LeadsPage = lazyPage(() => import('./pages/LeadsPage'), (m) => m.LeadsPage);
const LeadDetailPage = lazyPage(() => import('./pages/LeadDetailPage'), (m) => m.LeadDetailPage);
const AgentsPage = lazyPage(() => import('./pages/AgentsPage'), (m) => m.AgentsPage);
const AgentDetailPage = lazyPage(() => import('./pages/AgentDetailPage'), (m) => m.AgentDetailPage);
const ScriptsPage = lazyPage(() => import('./pages/ScriptsPage'), (m) => m.ScriptsPage);
const VoicesPage = lazyPage(() => import('./pages/VoicesPage'), (m) => m.VoicesPage);
const PhoneNumbersPage = lazyPage(() => import('./pages/PhoneNumbersPage'), (m) => m.PhoneNumbersPage);
const MessagingPage = lazyPage(() => import('./pages/MessagingPage'), (m) => m.MessagingPage);
const SettingsLayout = lazyPage(() => import('./pages/settings/SettingsLayout'), (m) => m.SettingsLayout);
const OrganizationSettingsPage = lazyPage(() => import('./pages/settings/OrganizationSettingsPage'), (m) => m.OrganizationSettingsPage);
const ProfileSettingsPage = lazyPage(() => import('./pages/settings/ProfileSettingsPage'), (m) => m.ProfileSettingsPage);
const SecuritySettingsPage = lazyPage(() => import('./pages/settings/SecuritySettingsPage'), (m) => m.SecuritySettingsPage);
const RolesSettingsPage = lazyPage(() => import('./pages/settings/RolesSettingsPage'), (m) => m.RolesSettingsPage);
const ComplianceSettingsPage = lazyPage(() => import('./pages/settings/ComplianceSettingsPage'), (m) => m.ComplianceSettingsPage);
const IntegrationsSettingsPage = lazyPage(() => import('./pages/settings/IntegrationsSettingsPage'), (m) => m.IntegrationsSettingsPage);
const WebhookEventsSettingsPage = lazyPage(() => import('./pages/settings/WebhookEventsSettingsPage'), (m) => m.WebhookEventsSettingsPage);
const ExportHistorySettingsPage = lazyPage(() => import('./pages/settings/ExportHistorySettingsPage'), (m) => m.ExportHistorySettingsPage);
const SystemHealthSettingsPage = lazyPage(() => import('./pages/settings/SystemHealthSettingsPage'), (m) => m.SystemHealthSettingsPage);
const NotFoundPage = lazyPage(() => import('./pages/NotFoundPage'), (m) => m.NotFoundPage);

const placeholderNavItems = NAV_ITEMS.filter((item) => !item.builtInPhase1);

export default function App(): JSX.Element {
  return (
    <Suspense fallback={<FullScreenSpinner />}>
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
            <Route path="/queues" element={<QueuesPage />} />
            <Route path="/inbound-routes" element={<InboundRoutesPage />} />
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
              <Route path="system-health" element={<SystemHealthSettingsPage />} />
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
    </Suspense>
  );
}
