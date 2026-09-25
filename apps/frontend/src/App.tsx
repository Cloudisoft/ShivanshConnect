import { Suspense, lazy } from 'react';
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
const LoginPage = lazy(() => import('./pages/auth/LoginPage').then((m) => ({ default: m.LoginPage })));
const SignupPage = lazy(() => import('./pages/auth/SignupPage').then((m) => ({ default: m.SignupPage })));
const ForgotPasswordPage = lazy(() => import('./pages/auth/ForgotPasswordPage').then((m) => ({ default: m.ForgotPasswordPage })));
const ResetPasswordPage = lazy(() => import('./pages/auth/ResetPasswordPage').then((m) => ({ default: m.ResetPasswordPage })));
const VerifyEmailPendingPage = lazy(() => import('./pages/auth/VerifyEmailPendingPage').then((m) => ({ default: m.VerifyEmailPendingPage })));
const AcceptInvitationPage = lazy(() => import('./pages/auth/AcceptInvitationPage').then((m) => ({ default: m.AcceptInvitationPage })));
const DashboardPage = lazy(() => import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })));
const CampaignsPage = lazy(() => import('./pages/CampaignsPage').then((m) => ({ default: m.CampaignsPage })));
const CampaignDetailPage = lazy(() => import('./pages/CampaignDetailPage').then((m) => ({ default: m.CampaignDetailPage })));
const DialingSettingsPage = lazy(() => import('./pages/DialingSettingsPage').then((m) => ({ default: m.DialingSettingsPage })));
const DispositionsPage = lazy(() => import('./pages/DispositionsPage').then((m) => ({ default: m.DispositionsPage })));
const CallbacksPage = lazy(() => import('./pages/CallbacksPage').then((m) => ({ default: m.CallbacksPage })));
const CdrPage = lazy(() => import('./pages/CdrPage').then((m) => ({ default: m.CdrPage })));
const LiveMonitorPage = lazy(() => import('./pages/LiveMonitorPage').then((m) => ({ default: m.LiveMonitorPage })));
const UsersPage = lazy(() => import('./pages/UsersPage').then((m) => ({ default: m.UsersPage })));
const LeadListsPage = lazy(() => import('./pages/LeadListsPage').then((m) => ({ default: m.LeadListsPage })));
const LeadsPage = lazy(() => import('./pages/LeadsPage').then((m) => ({ default: m.LeadsPage })));
const LeadDetailPage = lazy(() => import('./pages/LeadDetailPage').then((m) => ({ default: m.LeadDetailPage })));
const AgentsPage = lazy(() => import('./pages/AgentsPage').then((m) => ({ default: m.AgentsPage })));
const AgentDetailPage = lazy(() => import('./pages/AgentDetailPage').then((m) => ({ default: m.AgentDetailPage })));
const ScriptsPage = lazy(() => import('./pages/ScriptsPage').then((m) => ({ default: m.ScriptsPage })));
const VoicesPage = lazy(() => import('./pages/VoicesPage').then((m) => ({ default: m.VoicesPage })));
const PhoneNumbersPage = lazy(() => import('./pages/PhoneNumbersPage').then((m) => ({ default: m.PhoneNumbersPage })));
const MessagingPage = lazy(() => import('./pages/MessagingPage').then((m) => ({ default: m.MessagingPage })));
const SettingsLayout = lazy(() => import('./pages/settings/SettingsLayout').then((m) => ({ default: m.SettingsLayout })));
const OrganizationSettingsPage = lazy(() => import('./pages/settings/OrganizationSettingsPage').then((m) => ({ default: m.OrganizationSettingsPage })));
const ProfileSettingsPage = lazy(() => import('./pages/settings/ProfileSettingsPage').then((m) => ({ default: m.ProfileSettingsPage })));
const SecuritySettingsPage = lazy(() => import('./pages/settings/SecuritySettingsPage').then((m) => ({ default: m.SecuritySettingsPage })));
const RolesSettingsPage = lazy(() => import('./pages/settings/RolesSettingsPage').then((m) => ({ default: m.RolesSettingsPage })));
const ComplianceSettingsPage = lazy(() => import('./pages/settings/ComplianceSettingsPage').then((m) => ({ default: m.ComplianceSettingsPage })));
const IntegrationsSettingsPage = lazy(() => import('./pages/settings/IntegrationsSettingsPage').then((m) => ({ default: m.IntegrationsSettingsPage })));
const WebhookEventsSettingsPage = lazy(() => import('./pages/settings/WebhookEventsSettingsPage').then((m) => ({ default: m.WebhookEventsSettingsPage })));
const ExportHistorySettingsPage = lazy(() => import('./pages/settings/ExportHistorySettingsPage').then((m) => ({ default: m.ExportHistorySettingsPage })));
const SystemHealthSettingsPage = lazy(() => import('./pages/settings/SystemHealthSettingsPage').then((m) => ({ default: m.SystemHealthSettingsPage })));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })));

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
