import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type LabelHTMLAttributes } from 'react';
import clsx from 'clsx';

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost' }
>(function Button({ className, variant = 'primary', ...props }, ref) {
  return (
    <button
      ref={ref}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-ink-900 text-white hover:bg-ink-800',
        variant === 'secondary' && 'border border-ink-300 bg-white text-ink-800 hover:bg-ink-50',
        variant === 'danger' && 'bg-red-600 text-white hover:bg-red-700',
        variant === 'ghost' && 'text-ink-600 hover:bg-ink-100',
        className,
      )}
      {...props}
    />
  );
});

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={clsx(
          'w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-ink-500 focus:outline-none focus:ring-1 focus:ring-ink-500',
          className,
        )}
        {...props}
      />
    );
  },
);

export function Label(props: LabelHTMLAttributes<HTMLLabelElement>): JSX.Element {
  return <label className={clsx('mb-1.5 block text-sm font-medium text-ink-700', props.className)} {...props} />;
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={clsx('rounded-lg border border-ink-200 bg-white p-6 shadow-sm', className)}
      {...props}
    />
  );
}

export function Alert({
  variant = 'error',
  children,
}: {
  variant?: 'error' | 'success' | 'info';
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div
      className={clsx(
        'rounded-md border px-3 py-2 text-sm',
        variant === 'error' && 'border-red-200 bg-red-50 text-red-700',
        variant === 'success' && 'border-green-200 bg-green-50 text-green-700',
        variant === 'info' && 'border-ink-200 bg-ink-50 text-ink-700',
      )}
    >
      {children}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}): JSX.Element {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize',
        tone === 'neutral' && 'bg-ink-100 text-ink-700',
        tone === 'success' && 'bg-green-100 text-green-700',
        tone === 'warning' && 'bg-gold-100 text-gold-800',
        tone === 'danger' && 'bg-red-100 text-red-700',
      )}
    >
      {children}
    </span>
  );
}
