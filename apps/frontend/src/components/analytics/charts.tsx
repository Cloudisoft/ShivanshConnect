import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card } from '../ui';

/**
 * Phase 12 chart primitives - dataviz skill's validated default
 * categorical palette (references/palette.md), light mode only (this app
 * has no dark mode). SEQUENTIAL_HUE is slot 1 (blue) for every
 * single-series chart; CATEGORICAL is the fixed 8-hue order for
 * multi-series/breakdown charts - never cycled independently per chart.
 */
export const SEQUENTIAL_HUE = '#2a78d6';
export const CATEGORICAL = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

const AXIS_STYLE = { fontSize: 12, fill: '#6B7383' };
const GRID_STROKE = '#EEF0F3';

function ChartTooltip({ active, payload, label }: any): JSX.Element | null {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-ink-200 bg-white px-3 py-2 text-xs shadow-md">
      <div className="font-medium text-ink-900">{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="text-ink-600">
          {p.name}: <span className="font-semibold text-ink-900">{typeof p.value === 'number' ? p.value.toLocaleString() : p.value}</span>
        </div>
      ))}
    </div>
  );
}

export function ChartCard({ title, subtitle, children, empty }: { title: string; subtitle?: string; children: React.ReactNode; empty?: boolean }): JSX.Element {
  return (
    <Card>
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
        {subtitle && <p className="text-xs text-ink-500">{subtitle}</p>}
      </div>
      {empty ? <div className="flex h-56 items-center justify-center text-sm text-ink-400">No data for this period yet.</div> : <div className="h-56">{children}</div>}
    </Card>
  );
}

export function SimpleBarChart({ data, xKey, yKey, color = SEQUENTIAL_HUE }: { data: Array<Record<string, any>>; xKey: string; yKey: string; color?: string }): JSX.Element {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID_STROKE} />
        <XAxis dataKey={xKey} tick={AXIS_STYLE} axisLine={{ stroke: GRID_STROKE }} tickLine={false} />
        <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: '#F7F8FA' }} />
        <Bar dataKey={yKey} fill={color} radius={[4, 4, 0, 0]} maxBarSize={28} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function CategoricalBarChart({ data, xKey, yKey }: { data: Array<Record<string, any>>; xKey: string; yKey: string }): JSX.Element {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
        <CartesianGrid horizontal={false} stroke={GRID_STROKE} />
        <XAxis type="number" tick={AXIS_STYLE} axisLine={false} tickLine={false} allowDecimals={false} />
        <YAxis type="category" dataKey={xKey} tick={AXIS_STYLE} axisLine={false} tickLine={false} width={110} />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: '#F7F8FA' }} />
        <Bar dataKey={yKey} radius={[0, 4, 4, 0]} maxBarSize={20}>
          {data.map((_, i) => (
            <Cell key={i} fill={CATEGORICAL[i % CATEGORICAL.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function SimpleLineChart({ data, xKey, yKey, color = SEQUENTIAL_HUE, unit }: { data: Array<Record<string, any>>; xKey: string; yKey: string; color?: string; unit?: string }): JSX.Element {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID_STROKE} />
        <XAxis dataKey={xKey} tick={AXIS_STYLE} axisLine={{ stroke: GRID_STROKE }} tickLine={false} />
        <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} unit={unit} />
        <Tooltip content={<ChartTooltip />} />
        <Line type="monotone" dataKey={yKey} stroke={color} strokeWidth={2} dot={{ r: 3, fill: color }} activeDot={{ r: 5 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function ProgressBar({ label, value, sublabel }: { label: string; value: number; sublabel?: string }): JSX.Element {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-medium text-ink-800">{label}</span>
        <span className="text-ink-500">{sublabel ?? `${value.toFixed(0)}%`}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-ink-100">
        <div className="h-full rounded-full bg-gold-500" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
    </div>
  );
}
