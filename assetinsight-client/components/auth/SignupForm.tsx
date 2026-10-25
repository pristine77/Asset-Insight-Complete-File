"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Eye, EyeOff } from "lucide-react";
import { AuthService, authErrorMessage } from "@/services/auth";
import AuthLightShell, {
  AUTH_INPUT_CLASS,
  AUTH_LABEL_CLASS,
  AUTH_PRIMARY_BUTTON_CLASS,
  AUTH_SECONDARY_BUTTON_CLASS,
  AUTH_TEXTAREA_CLASS,
  AuthFormHeading,
  AuthNotice,
  AuthSpinner,
} from "@/components/auth/AuthLightShell";

const SIGNUP_FEATURES = [
  "Guided company setup",
  "Secure email verification",
  "Client-ready report access",
];

export default function SignupForm() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [companyAddress, setCompanyAddress] = useState("");
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const canContinue = email.trim().length > 0 && password.length >= 6;
  const canSubmit = username.trim().length > 0 && companyName.trim().length > 0;

  const goToDetails = () => {
    if (!canContinue || loading) return;
    setError(null);
    setMessage(null);
    setStep(2);
  };

  const createAccount = async () => {
    if (!canContinue || !canSubmit || loading) return;
    setError(null);
    setMessage(null);
    setLoading(true);
    try {
      const response = await AuthService.signup({
        email,
        password,
        companyName: companyName || undefined,
        contactEmail: contactEmail || undefined,
        contactPhone: contactPhone || undefined,
        companyAddress: companyAddress || undefined,
        username,
      });
      setMessage(response.message || "Signup successful. Check your email for a verification code.");
      window.setTimeout(() => {
        router.replace(`/verify-email?email=${encodeURIComponent(email)}`);
      }, 800);
    } catch (err: unknown) {
      setError(authErrorMessage(err, "Unable to confirm account creation. Check your email for a verification code before trying again."));
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (step === 1) {
      goToDetails();
    } else {
      void createAccount();
    }
  };

  return (
    <AuthLightShell
      title="A clear workspace for every client package."
      description="Set up your account once, then keep valuation work, reports, and delivery organized in one place."
      features={SIGNUP_FEATURES}
    >
      <form onSubmit={onSubmit} className="py-2">
        <AuthFormHeading
          label="Create account"
          title="Build your workspace"
          description={
            step === 1
              ? "Start with the credentials you will use to sign in."
              : "Tell us who you are and where your valuation work belongs."
          }
        />

        <ol aria-label="Account setup progress" className="mt-7 grid grid-cols-2 border-b border-[var(--app-border)]">
          {[
            { value: 1 as const, label: "Credentials" },
            { value: 2 as const, label: "Company details" },
          ].map((item) => {
            const active = step === item.value;
            const available = item.value === 1 || canContinue;
            return (
              <li key={item.value}>
                <button
                  type="button"
                  disabled={!available || loading}
                  onClick={() => setStep(item.value)}
                  aria-current={active ? "step" : undefined}
                  className={`w-full border-b-2 px-2 pb-3 text-left text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] ${
                    active
                      ? "border-[var(--app-accent)] text-[var(--app-accent)]"
                      : "border-transparent text-[var(--app-text-muted)] hover:text-[var(--app-text)]"
                  }`}
                >
                  <span className="mr-2 font-mono text-xs">0{item.value}</span>
                  {item.label}
                </button>
              </li>
            );
          })}
        </ol>

        {error ? (
          <div className="mt-6">
            <AuthNotice tone="error">{error}</AuthNotice>
          </div>
        ) : null}
        {message ? (
          <div className="mt-6">
            <AuthNotice tone="success">{message}</AuthNotice>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="mt-7 space-y-5">
            <label className="block">
              <span className={AUTH_LABEL_CLASS}>Email address</span>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
                className={AUTH_INPUT_CLASS}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                disabled={loading}
              />
            </label>
            <div className="block">
              <label htmlFor="signup-password" className={AUTH_LABEL_CLASS}>
                Password
              </label>
              <span className="relative block">
                <input
                  id="signup-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  placeholder="At least 6 characters"
                  className={`${AUTH_INPUT_CLASS} pr-14`}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={6}
                  required
                  disabled={loading}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute right-2 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-md text-[var(--app-text-muted)] hover:bg-[var(--app-panel-alt)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
                >
                  {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </span>
            </div>
          </div>
        ) : (
          <div className="mt-7 grid gap-5 sm:grid-cols-2">
            <label className="block sm:col-span-2">
              <span className={AUTH_LABEL_CLASS}>Username</span>
              <input
                type="text"
                autoComplete="username"
                placeholder="Your username"
                className={AUTH_INPUT_CLASS}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
                disabled={loading}
              />
            </label>
            <label className="block sm:col-span-2">
              <span className={AUTH_LABEL_CLASS}>Company name</span>
              <input
                type="text"
                autoComplete="organization"
                placeholder="Your company"
                className={AUTH_INPUT_CLASS}
                value={companyName}
                onChange={(event) => setCompanyName(event.target.value)}
                required
                disabled={loading}
              />
            </label>
            <label className="block">
              <span className={AUTH_LABEL_CLASS}>Contact email</span>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="contact@company.com"
                className={AUTH_INPUT_CLASS}
                value={contactEmail}
                onChange={(event) => setContactEmail(event.target.value)}
                disabled={loading}
              />
            </label>
            <label className="block">
              <span className={AUTH_LABEL_CLASS}>Contact phone</span>
              <input
                type="tel"
                autoComplete="tel"
                placeholder="+44 20 0000 0000"
                className={AUTH_INPUT_CLASS}
                value={contactPhone}
                onChange={(event) => setContactPhone(event.target.value)}
                disabled={loading}
              />
            </label>
            <label className="block sm:col-span-2">
              <span className={AUTH_LABEL_CLASS}>Company address</span>
              <textarea
                rows={2}
                autoComplete="street-address"
                placeholder="Company address"
                className={AUTH_TEXTAREA_CLASS}
                value={companyAddress}
                onChange={(event) => setCompanyAddress(event.target.value)}
                disabled={loading}
              />
            </label>
          </div>
        )}

        <div className="mt-8 flex flex-col-reverse gap-4 sm:flex-row sm:items-center sm:justify-between">
          {step === 2 ? (
            <button type="button" onClick={() => setStep(1)} disabled={loading} className={AUTH_SECONDARY_BUTTON_CLASS}>
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
          ) : (
            <p className="text-sm text-[var(--app-text-muted)]">
              Already have an account?{" "}
              <Link className="font-medium text-[var(--app-accent)] hover:underline hover:underline-offset-4" href="/login">
                Sign in
              </Link>
            </p>
          )}
          <button
            type="submit"
            disabled={loading || (step === 1 ? !canContinue : !canSubmit)}
            className={AUTH_PRIMARY_BUTTON_CLASS}
          >
            {loading ? <AuthSpinner /> : null}
            <span>{loading ? "Creating account..." : step === 1 ? "Continue" : "Create account"}</span>
            {loading ? null : <ArrowRight className="h-4 w-4" />}
          </button>
        </div>
      </form>
    </AuthLightShell>
  );
}
