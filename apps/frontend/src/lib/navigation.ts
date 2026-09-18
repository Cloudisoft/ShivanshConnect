import {
  LayoutDashboard,
  Megaphone,
  Settings2,
  PhoneCall,
  Headphones,
  UserPlus,
  ListChecks,
  Tag,
  FileText,
  BarChart3,
  Bot,
  Mic,
  Phone,
  Route,
  ListOrdered,
  Users,
  MessageSquare,
  Settings,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  id: string;
  label: string;
  path: string;
  icon: LucideIcon;
  /** True once a module has a real page wired up (name kept from Phase 1
   * for git-history continuity - it now also covers later phases, e.g.
   * Phase 3's AI Agents). Everything still false routes to an honest
   * "scheduled for a later phase" placeholder. */
  builtInPhase1: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', path: '/dashboard', icon: LayoutDashboard, builtInPhase1: true },
  { id: 'campaigns', label: 'Campaigns', path: '/campaigns', icon: Megaphone, builtInPhase1: true },
  { id: 'dialing-settings', label: 'Dialing Settings', path: '/dialing-settings', icon: Settings2, builtInPhase1: true },
  { id: 'callbacks', label: 'Callbacks', path: '/callbacks', icon: PhoneCall, builtInPhase1: true },
  { id: 'live-monitor', label: 'Live Monitor', path: '/live-monitor', icon: Headphones, builtInPhase1: true },
  { id: 'leads', label: 'Leads', path: '/leads', icon: UserPlus, builtInPhase1: true },
  { id: 'lead-lists', label: 'Lead Lists', path: '/lead-lists', icon: ListChecks, builtInPhase1: true },
  { id: 'dispositions', label: 'Dispositions', path: '/dispositions', icon: Tag, builtInPhase1: true },
  { id: 'cdr', label: 'CDR', path: '/cdr', icon: FileText, builtInPhase1: true },
  { id: 'analytics', label: 'Analytics', path: '/analytics', icon: BarChart3, builtInPhase1: true },
  { id: 'ai-agents', label: 'AI Agents', path: '/ai-agents', icon: Bot, builtInPhase1: true },
  { id: 'voices', label: 'Voices', path: '/voices', icon: Mic, builtInPhase1: true },
  { id: 'dids', label: 'DIDs', path: '/dids', icon: Phone, builtInPhase1: true },
  { id: 'inbound-routes', label: 'Inbound Routes', path: '/inbound-routes', icon: Route, builtInPhase1: false },
  { id: 'queues', label: 'Queues', path: '/queues', icon: ListOrdered, builtInPhase1: false },
  { id: 'users', label: 'Users', path: '/users', icon: Users, builtInPhase1: true },
  { id: 'messaging', label: 'Messaging', path: '/messaging', icon: MessageSquare, builtInPhase1: false },
  { id: 'settings', label: 'Settings', path: '/settings', icon: Settings, builtInPhase1: true },
];
