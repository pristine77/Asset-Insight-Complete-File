"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthService, authErrorMessage } from "@/services/auth";
import { useAuthContext } from "@/context/AuthContext";
import AuthLightShell, {
  AUTH_INPUT_CLASS,
  AUTH_LABEL_CLASS,
  AUTH_PRIMARY_BUTTON_CLASS,
  AUTH_SECONDARY_BUTTON_CLASS,
  AuthFormHeading,
  AuthNotice,
  AuthSpinner,
} from "@/components/auth/AuthLightShell";

const VERIFICATION_FEATURES = [
  "Six-digit verification",
  "Protected account setup",
  "Secure device handoff",
];

export default function VerifyEmailForm() {
  const router = useRouter();
  const { acceptAuthResponse } = useAuthContext();
  const search = useSearchParams();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const emailParam = search.get("email");
    if (emailParam) setEmail((current) => current || emailParam);
  }, [search]);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setLoading(true);
    try {
      const response = await AuthService.verifyEmail({
        email,
        verificationCode: code,
      });
      acceptAuthResponse(response);
      setMessage(response.message || "Email verified successfully.");
      window.setTimeout(() => {
        router.replace(response.authState === "authenticated" ? "/dashboard" : "/device-access");
      }, 800);
    } catch (err: unknown) {
      setError(authErrorMessage(err, "Failed to verify email"));
    } finally {
      setLoading(false);
    }
  };

  const onResend = async () => {
    setError(null);
    setMessage(null);
    setLoading(true);
    try {
      const response = await AuthService.resendVerificationCode(email);
      setMessage(response.message || "Verification code resent.");
    } catch (err: unknown) {
      setError(authErrorMessage(err, "Unable to confirm the verification-code request. Check your email before trying again."));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLightShell
      title="One quick check before your workspace opens."
      description="Confirm your email to protect account access and keep client work connected to the right team."
      features={VERIFICATION_FEATURES}
    >
      <form onSubmit={onSubmit}>
        <AuthFormHeading
          label="Verify email"
          title="Check your inbox"
          description="Enter the six-digit code sent to your email address."
        />

        {error ? <div className="mt-7"><AuthNotice tone="error">{error}</AuthNotice></div> : null}
        {message ? <div className="mt-7"><AuthNotice tone="success">{message}</AuthNotice></div> : null}

        <div className="mt-8 space-y-5">
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
          <label className="block">
            <span className={AUTH_LABEL_CLASS}>Verification code</span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              className={`${AUTH_INPUT_CLASS} font-mono tracking-[0.25em]`}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D+/g, "").slice(0, 6))}
              required
              disabled={loading}
            />
          </label>
        </div>

        <button
          type="submit"
          disabled={loading || code.length !== 6}
          className={`mt-8 w-full ${AUTH_PRIMARY_BUTTON_CLASS}`}
        >
          {loading ? <AuthSpinner /> : null}
          <span>{loading ? "Verifying..." : "Verify email"}</span>
          {loading ? null : <ArrowRight className="h-4 w-4" />}
        </button>
        <button
          type="button"
          disabled={loading || !email}
          onClick={() => void onResend()}
          className={`mt-3 w-full ${AUTH_SECONDARY_BUTTON_CLASS}`}
        >
          Resend verification code
        </button>

        <p className="mt-7 text-center text-sm text-[var(--app-text-muted)]">
          Already verified?{" "}
          <Link className="font-medium text-[var(--app-accent)] hover:underline hover:underline-offset-4" href="/login">
            Back to sign in
          </Link>
        </p>
      </form>
    </AuthLightShell>
  );
}
