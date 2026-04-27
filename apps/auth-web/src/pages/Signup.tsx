import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { api, ApiError } from '../lib/api.js';
import { Input, Label, Button, FieldError, ErrorAlert, InfoAlert } from '../components/ui.js';

const signupSchema = z.object({
  email: z.string().email(),
  password: z
    .string()
    .min(12, 'Password must be at least 12 characters')
    .regex(/[A-Z]/, 'Must contain an uppercase letter')
    .regex(/[a-z]/, 'Must contain a lowercase letter')
    .regex(/[0-9]/, 'Must contain a digit')
    .regex(/[^A-Za-z0-9]/, 'Must contain a symbol'),
  firstName: z.string().trim().min(1, 'First name is required').max(80),
  lastName: z.string().trim().max(80).optional(),
  acceptTos: z.literal(true, { errorMap: () => ({ message: 'You must accept the Terms' }) }),
});

type SignupInputs = z.infer<typeof signupSchema>;

interface CurrentToS {
  termsOfService: { version: string; contentUrl: string } | null;
  privacyPolicy: { version: string; contentUrl: string } | null;
}

export function SignupPage() {
  const [params] = useSearchParams();
  const productSlug = params.get('product') ?? params.get('productSlug') ?? '';
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [tos, setTos] = useState<CurrentToS | null>(null);

  useEffect(() => {
    api<CurrentToS>('GET', '/v1/tos/current')
      .then(setTos)
      .catch(() => setTos({ termsOfService: null, privacyPolicy: null }));
  }, []);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupInputs>({ resolver: zodResolver(signupSchema) });

  async function onSubmit(values: SignupInputs) {
    setServerError(null);
    if (!productSlug) {
      setServerError('Missing product slug. Open the signup link from the product website.');
      return;
    }
    try {
      await api('POST', '/v1/auth/signup', {
        body: {
          email: values.email,
          password: values.password,
          name: { first: values.firstName, last: values.lastName || undefined },
          productSlug,
          acceptedTosVersion: tos?.termsOfService?.version,
          acceptedPrivacyVersion: tos?.privacyPolicy?.version,
        },
      });
      setSubmitted(true);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Network error');
    }
  }

  if (submitted) {
    return (
      <div className="card space-y-4">
        <h1 className="text-2xl font-semibold">Check your inbox</h1>
        <InfoAlert>
          We\u2019ve sent a verification link. Click it to finish creating your account.
        </InfoAlert>
        <Link to={`/login${productSlug ? `?product=${productSlug}` : ''}`} className="text-brand-600 hover:underline text-sm">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="card space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
      {serverError && <ErrorAlert>{serverError}</ErrorAlert>}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="firstName">First name</Label>
            <Input id="firstName" autoComplete="given-name" {...register('firstName')} />
            <FieldError>{errors.firstName?.message}</FieldError>
          </div>
          <div>
            <Label htmlFor="lastName">Last name</Label>
            <Input id="lastName" autoComplete="family-name" {...register('lastName')} />
            <FieldError>{errors.lastName?.message}</FieldError>
          </div>
        </div>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" {...register('email')} />
          <FieldError>{errors.email?.message}</FieldError>
        </div>
        <div>
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="new-password" {...register('password')} />
          <FieldError>{errors.password?.message}</FieldError>
        </div>

        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" className="mt-1" {...register('acceptTos')} />
          <span>
            I agree to the{' '}
            {tos?.termsOfService ? (
              <a href={tos.termsOfService.contentUrl} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">
                Terms of Service v{tos.termsOfService.version}
              </a>
            ) : (
              'Terms of Service'
            )}{' '}
            and{' '}
            {tos?.privacyPolicy ? (
              <a href={tos.privacyPolicy.contentUrl} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">
                Privacy Policy v{tos.privacyPolicy.version}
              </a>
            ) : (
              'Privacy Policy'
            )}
            .
          </span>
        </label>
        <FieldError>{errors.acceptTos?.message}</FieldError>

        <Button type="submit" loading={isSubmitting}>Create account</Button>
      </form>

      <Link to={`/login${productSlug ? `?product=${productSlug}` : ''}`} className="text-brand-600 hover:underline text-sm">
        Have an account? Sign in
      </Link>
    </div>
  );
}
