"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { useAuthContext } from "@/context/AuthContext";
import { safeAppNextPath } from "@/lib/workspace";
import AuthLightShell, {
  AUTH_INPUT_CLASS,
  AUTH_LABEL_CLASS,
  AUTH_PRIMARY_BUTTON_CLASS,
  AuthFormHeading,
  AuthNotice,
  AuthSpinner,
} from "@/components/auth/AuthLightShell";

const LOGIN_FEATURES = [
  "Valuation workflows",
  "Saved reports",
  "Secure account access",
];

const REMEMBER_EMAIL_KEY = "cv-login-email";

export default function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const { login } = useAuthContext();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberEmail, setRememberEmail] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const supportEmail =
    process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "support@assetinsightvaluation.com";

  useEffect(() => {
    const emailParam = search.get("email");
    if (emailParam) {
      setEmail(emailParam);
      return;
    }
    const rememberedEmail = window.localStorage.getItem(REMEMBER_EMAIL_KEY);
    if (rememberedEmail) {
      setEmail(rememberedEmail);
      setRememberEmail(true);
    }
  }, [search]);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (rememberEmail) {
        window.localStorage.setItem(REMEMBER_EMAIL_KEY, email.trim());
      } else {
        window.localStorage.removeItem(REMEMBER_EMAIL_KEY);
      }

      const result = await login({ email, password });
      if (result.authState !== "authenticated") {
        router.replace(`/device-access?next=${encodeURIComponent(safeAppNextPath(search.get("next")))}`);
      } else {
        router.replace(safeAppNextPath(search.get("next")));
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to login");
    } finally {
      setLoading(false);
    }
  };

  const isBlocked = (error || "").toLowerCase().includes("blocked");

  return (
    <AuthLightShell
      title="Your valuation workspace, ready when you are."
      description={"Create reports, manage incoming work, and\ndeliver client-ready files from one clear workspace."}
      features={LOGIN_FEATURES}
    >
      <form onSubmit={onSubmit}>
        <AuthFormHeading
          label="Sign in"
          title="Welcome back"
          description="Use your Asset Insight account to continue."
        />

        {error ? (
          <div className="mt-7">
            <AuthNotice tone="error">
              {isBlocked ? (
                <>
                  <span className="font-semibold">Your account is blocked.</span>{" "}
                  Contact{" "}
                  <a className="font-semibold underline underline-offset-4" href={`mailto:${supportEmail}`}>
                    {supportEmail}
                  </a>{" "}
                  for assistance.
                </>
              ) : (
                error
              )}
            </AuthNotice>
          </div>
        ) : null}

        <div className="mt-9 space-y-5">
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
            <label htmlFor="login-password" className={AUTH_LABEL_CLASS}>
              Password
            </label>
            <span className="relative block">
              <input
                id="login-password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                placeholder="Enter your password"
                className={`${AUTH_INPUT_CLASS} pr-14`}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                disabled={loading}
              />
              <button
                type="button"
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute right-2 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-md text-[var(--app-text-muted)] transition-colors hover:bg-[var(--app-panel-alt)] hover:text-[var(--app-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
              >
                {showPassword ? (
                  <EyeOff className="h-5 w-5" strokeWidth={1.8} />
                ) : (
                  <Eye className="h-5 w-5" strokeWidth={1.8} />
                )}
              </button>
            </span>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-between gap-4">
          <label className="flex cursor-pointer items-center gap-3 text-sm text-[var(--app-text)]">
            <input
              type="checkbox"
              checked={rememberEmail}
              onChange={(event) => setRememberEmail(event.target.checked)}
              className="h-5 w-5 rounded border-[var(--app-control-border)] accent-[var(--app-accent)]"
            />
            Remember me
          </label>
          <Link
            href="/forgot-password"
            className="text-sm font-medium text-[var(--app-accent)] hover:underline hover:underline-offset-4"
          >
            Forgot password?
          </Link>
        </div>

        <button type="submit" disabled={loading} className={`mt-8 w-full ${AUTH_PRIMARY_BUTTON_CLASS}`}>
          {loading ? <AuthSpinner /> : null}
          <span>{loading ? "Signing in..." : "Sign in"}</span>
          {loading ? null : <ArrowRight className="h-4 w-4" />}
        </button>

        <p className="mt-6 text-center text-sm text-[var(--app-text)]">
          New to Asset Insight?{" "}
          <Link className="font-medium text-[var(--app-accent)] hover:underline hover:underline-offset-4" href="/signup">
            Create account
          </Link>
        </p>
      </form>
    </AuthLightShell>
  );
}
