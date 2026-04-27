import { useState } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { api, ApiError } from '../lib/api.js';
import { Input, Label, Button, FieldError, ErrorAlert, InfoAlert } from '../components/ui.js';

const schema = z
  .object({
    password: z
      .string()
      .min(12)
      .regex(/[A-Z]/, 'Must contain an uppercase letter')
      .regex(/[a-z]/, 'Must contain a lowercase letter')
      .regex(/[0-9]/, 'Must contain a digit')
      .regex(/[^A-Za-z0-9]/, 'Must contain a symbol'),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });

type Inputs = z.infer<typeof schema>;

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const productSlug = params.get('product') ?? '';
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Inputs>({ resolver: zodResolver(schema) });

  async function onSubmit(values: Inputs) {
    setServerError(null);
    try {
      await api('POST', '/v1/auth/reset-password', {
        body: { token, newPassword: values.password },
      });
      navigate(`/login${productSlug ? `?product=${productSlug}` : ''}`, { replace: true });
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Network error');
    }
  }

  if (!token) {
    return (
      <div className="card space-y-4">
        <h1 className="text-2xl font-semibold">Invalid reset link</h1>
        <ErrorAlert>The reset token is missing. Request a new link.</ErrorAlert>
        <Link to="/forgot" className="text-brand-600 hover:underline text-sm">Back to forgot password</Link>
      </div>
    );
  }

  return (
    <div className="card space-y-6">
      <h1 className="text-2xl font-semibold">Choose a new password</h1>
      <InfoAlert>Pick a strong password you don\u2019t use anywhere else.</InfoAlert>
      {serverError && <ErrorAlert>{serverError}</ErrorAlert>}
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div>
          <Label htmlFor="password">New password</Label>
          <Input id="password" type="password" autoComplete="new-password" {...register('password')} />
          <FieldError>{errors.password?.message}</FieldError>
        </div>
        <div>
          <Label htmlFor="confirm">Confirm password</Label>
          <Input id="confirm" type="password" autoComplete="new-password" {...register('confirm')} />
          <FieldError>{errors.confirm?.message}</FieldError>
        </div>
        <Button type="submit" loading={isSubmitting}>Reset password</Button>
      </form>
    </div>
  );
}
