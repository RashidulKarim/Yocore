/**
 * Tiny shadcn-flavoured input/button primitives. We don't pull in the full
 * shadcn CLI for a six-page surface — these match the same Tailwind classes.
 */
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes } from 'react';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input(props, ref) {
    return <input ref={ref} className="input" {...props} />;
  },
);

export function Label({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="label">
      {children}
    </label>
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary';
  loading?: boolean;
}

export function Button({ variant = 'primary', loading, disabled, children, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={variant === 'primary' ? 'btn-primary w-full' : 'btn-secondary w-full'}
    >
      {loading ? 'Working\u2026' : children}
    </button>
  );
}

export function FieldError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return <p className="text-xs text-rose-600 mt-1">{children}</p>;
}

export function ErrorAlert({ children }: { children: React.ReactNode }) {
  return <div className="alert-error">{children}</div>;
}

export function InfoAlert({ children }: { children: React.ReactNode }) {
  return <div className="alert-info">{children}</div>;
}
