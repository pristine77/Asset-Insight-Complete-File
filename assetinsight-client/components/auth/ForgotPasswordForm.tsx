"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
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

const RECOVERY_FEATURES = [
  "Short-lived reset codes",
  "Secure account recovery",
  "Device approval protection",
];

export default function ForgotPasswordForm() {
  const router = useRouter();
  const { acceptAuthResponse } = useAuthContext();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<"request" | "reset">("request");
  const requestActive = useRef(false);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (requestActive.current) return;
    setError(null);
    setMessage(null);

    if (step === "reset") {
      if (!/^\d{6}$/.test(code.trim())) {
        setError("Enter the six-digit reset code sent to your email.");
        return;
      }
      if (password.length < 6) {
        setError("Password must be at least 6 characters.");
        return;
      }
      if (password !== confirmPassword) {
        setError("Passwords do not match.");
        return;
      }
    }

    requestActive.current = true;
    setLoading(true);
    const normalizedEmail = email.trim().toLowerCase();
    try {
      if (step === "request") {
        const response = await AuthService.forgotPassword({ email: normalizedEmail });
        setEmail(normalizedEmail);
        setStep("reset");
        setMessage(response.message || "If an account exists, a password reset code has been sent.");
      } else {
        const response = await AuthService.resetPasswordByCode({
          email: normalizedEmail,
          code: code.trim(),
          password,
        });
        acceptAuthResponse(response);
        setMessage(response.message || "Password reset successful.");
        window.setTimeout(
          () => router.replace(response.authState === "authenticated" ? "/me" : "/device-access"),
          800
        );
      }
    } catch (err: unknown) {
      if (step === "request") {
        setError(authErrorMessage(err, "We could not confirm the reset-code request. Check your connection and try again."));
      } else {
        setError(authErrorMessage(err, "Failed to reset password."));
      }
    } finally {
      requestActive.current = false;
      setLoading(false);
    }
  };

  const onResendCode = async () => {
    if (requestActive.current) return;
    requestActive.current = true;
    setError(null);
    setMessage(null);
    setLoading(true);
    try {
      const normalizedEmail = email.trim().toLowerCase();
      const response = await AuthService.forgotPassword({ email: normalizedEmail });
      setEmail(normalizedEmail);
      setMessage(response.message || "A new password reset code has been sent.");
    } catch (err: unknown) {
      setError(authErrorMessage(err, "We could not confirm a new reset code was sent. Check your email before trying again."));
    } finally {
      requestActive.current = false;
      setLoading(false);
    }
  };

  return (
    <AuthLightShell
      title="Recover your workspace without losing momentum."
      description="Reset access through a short-lived email code, then return to the work already waiting for you."
      features={RECOVERY_FEATURES}
    >
      <form onSubmit={onSubmit}>
        <AuthFormHeading
          label="Account recovery"
          title={step === "request" ? "Reset your password" : "Choose a new password"}
          description={
            step === "request"
              ? "Enter your account email and we will send you a reset code."
              : "Enter the code from your email and set a new password."
          }
        />

        {error ? (
          <div className="mt-7"><AuthNotice tone="error">{error}</AuthNotice></div>
        ) : null}
        {message ? (
          <div className="mt-7"><AuthNotice tone="success">{message}</AuthNotice></div>
        ) : null}

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
              disabled={step === "reset" || loading}
            />
          </label>

          {step === "reset" ? (
            <>
              <label className="block">
                <span className={AUTH_LABEL_CLASS}>Reset code</span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="6-digit code"
                  className={`${AUTH_INPUT_CLASS} font-mono tracking-[0.22em]`}
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D+/g, "").slice(0, 6))}
                  required
                  disabled={loading}
                />
              </label>
              <label className="block">
                <span className={AUTH_LABEL_CLASS}>New password</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="At least 6 characters"
                  className={AUTH_INPUT_CLASS}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={6}
                  required
                  disabled={loading}
                />
              </label>
              <label className="block">
                <span className={AUTH_LABEL_CLASS}>Confirm password</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="Repeat your password"
                  className={AUTH_INPUT_CLASS}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  minLength={6}
                  required
                  disabled={loading}
                />
              </label>
            </>
          ) : null}
        </div>

        <button type="submit" disabled={loading} className={`mt-8 w-full ${AUTH_PRIMARY_BUTTON_CLASS}`}>
          {loading ? <AuthSpinner /> : null}
          <span>
            {loading
              ? step === "request" ? "Sending code..." : "Updating password..."
              : step === "request" ? "Send reset code" : "Update password"}
          </span>
          {loading ? null : <ArrowRight className="h-4 w-4" />}
        </button>

        {step === "reset" ? (
          <button
            type="button"
            onClick={() => void onResendCode()}
            disabled={loading}
            className={`mt-3 w-full ${AUTH_SECONDARY_BUTTON_CLASS}`}
          >
            Resend reset code
          </button>
        ) : null}

        <p className="mt-7 text-center text-sm text-[var(--app-text-muted)]">
          Remembered your password?{" "}
          <Link className="font-medium text-[var(--app-accent)] hover:underline hover:underline-offset-4" href="/login">
            Back to sign in
          </Link>
        </p>
      </form>
    </AuthLightShell>
  );
}
