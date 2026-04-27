import { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { api, ApiError } from '../lib/api.js';
import { Input, Label, Button, FieldError, ErrorAlert, InfoAlert } from '../components/ui.js';

const schema = z.object({ email: z.string().email() });
type Inputs = z.infer<typeof schema>;

export function ForgotPasswordPage() {
  const [params] = useSearchParams();
  const productSlug = params.get('product') ?? params.get('productSlug') ?? '';
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Inputs>({ resolver: zodResolver(schema) });

  async function onSubmit(values: Inputs) {
    setServerError(null);
    try {
      await api('POST', '/v1/auth/forgot-password', {
        body: { email: values.email, productSlug: productSlug || undefined },
      });
      setSubmitted(true);
    } catch (err) {
      // Constant-time response means we should still show submitted UI on most errors.
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') {
        setServerError(err.message);
        return;
      }
      setSubmitted(true);
    }
  }

  if (submitted) {
    return (
      <div className="card space-y-4">
        <h1 className="text-2xl font-semibold">Check your inbox</h1>
        <InfoAlert>If an account exists, we\u2019ve sent a password reset link.</InfoAlert>
        <Link to={`/login${productSlug ? `?product=${productSlug}` : ''}`} className="text-brand-600 hover:underline text-sm">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="card space-y-6">
      <h1 className="text-2xl font-semibold">Reset your password</h1>
      {serverError && <ErrorAlert>{serverError}</ErrorAlert>}
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" {...register('email')} />
          <FieldError>{errors.email?.message}</FieldError>
        </div>
        <Button type="submit" loading={isSubmitting}>Send reset link</Button>
      </form>
      <Link to={`/login${productSlug ? `?product=${productSlug}` : ''}`} className="text-brand-600 hover:underline text-sm">
        Back to sign in
      </Link>
    </div>
  );
}
