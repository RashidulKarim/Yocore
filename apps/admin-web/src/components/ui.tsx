import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input(props, ref) {
    return <input ref={ref} className="input" {...props} />;
  },
);

export function Label({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return <label htmlFor={htmlFor} className="label">{children}</label>;
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
  loading?: boolean;
}
export function Button({ variant = 'primary', loading, disabled, children, className, ...rest }: ButtonProps) {
  const cls = variant === 'primary' ? 'btn-primary' : variant === 'danger' ? 'btn-danger' : 'btn-secondary';
  return (
    <button {...rest} disabled={disabled || loading} className={`${cls} ${className ?? ''}`}>
      {loading ? 'Working\u2026' : children}
    </button>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const upper = status.toUpperCase();
  if (upper === 'ACTIVE' || upper === 'PUBLISHED') return <span className="badge-green">{upper}</span>;
  if (upper === 'TRIALING' || upper === 'DRAFT' || upper === 'PENDING') return <span className="badge-yellow">{upper}</span>;
  if (upper === 'PAST_DUE' || upper === 'FAILED' || upper === 'DEAD' || upper === 'BANNED' || upper === 'SUSPENDED' || upper === 'REVOKED') return <span className="badge-red">{upper}</span>;
  return <span className="badge-slate">{upper}</span>;
}

export function ErrorAlert({ children }: { children: ReactNode }) {
  return <div className="rounded-md bg-rose-50 p-3 text-sm text-rose-800 ring-1 ring-inset ring-rose-200">{children}</div>;
}
export function InfoAlert({ children }: { children: ReactNode }) {
  return <div className="rounded-md bg-sky-50 p-3 text-sm text-sky-800 ring-1 ring-inset ring-sky-200">{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-12 text-center text-sm text-slate-500">{children}</div>;
}
