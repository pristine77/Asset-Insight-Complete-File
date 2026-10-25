"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { AuthService } from "@/services/auth";
import { useAuthContext } from "@/context/AuthContext";
import AuthLightShell, {
  AUTH_INPUT_CLASS,
  AUTH_LABEL_CLASS,
  AUTH_PRIMARY_BUTTON_CLASS,
  AuthFormHeading,
  AuthNotice,
  AuthSpinner,
} from "@/components/auth/AuthLightShell";

const RESET_FEATURES = [
  "Encrypted account access",
  "Secure recovery links",
  "Device approval protection",
];

export default function ResetPasswordForm({ token }: { token: string }) {
  const { acceptAuthResponse } = useAuthContext();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      const response = await AuthService.resetPassword({ token, password });
      acceptAuthResponse(response);
      setMessage(response.message || "Password reset successful.");
      window.setTimeout(
        () => router.replace(response.authState === "authenticated" ? "/me" : "/device-access"),
        800
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to reset password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLightShell
      title="Secure your account and get back to work."
      description="Choose a strong new password, then continue to the same reports and valuation workflows."
      features={RESET_FEATURES}
    >
      <form onSubmit={onSubmit}>
        <AuthFormHeading
          label="Reset password"
          title="Choose a new password"
          description="Use at least six characters and keep it unique to Asset Insight."
        />

        {error ? <div className="mt-7"><AuthNotice tone="error">{error}</AuthNotice></div> : null}
        {message ? <div className="mt-7"><AuthNotice tone="success">{message}</AuthNotice></div> : null}

        <div className="mt-8 space-y-5">
          <PasswordField
            label="New password"
            value={password}
            onChange={setPassword}
            visible={showPassword}
            onToggle={() => setShowPassword((current) => !current)}
            disabled={loading}
          />
          <PasswordField
            label="Confirm password"
            value={confirm}
            onChange={setConfirm}
            visible={showConfirm}
            onToggle={() => setShowConfirm((current) => !current)}
            disabled={loading}
          />
        </div>

        <button type="submit" disabled={loading} className={`mt-8 w-full ${AUTH_PRIMARY_BUTTON_CLASS}`}>
          {loading ? <AuthSpinner /> : null}
          <span>{loading ? "Updating password..." : "Update password"}</span>
          {loading ? null : <ArrowRight className="h-4 w-4" />}
        </button>
      </form>
    </AuthLightShell>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  visible,
  onToggle,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  visible: boolean;
  onToggle: () => void;
  disabled: boolean;
}) {
  const inputId = `reset-${label.toLowerCase().replace(/\s+/g, "-")}`;

  return (
    <div className="block">
      <label htmlFor={inputId} className={AUTH_LABEL_CLASS}>
        {label}
      </label>
      <span className="relative block">
        <input
          id={inputId}
          type={visible ? "text" : "password"}
          placeholder="At least 6 characters"
          autoComplete="new-password"
          className={`${AUTH_INPUT_CLASS} pr-14`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          minLength={6}
          required
          disabled={disabled}
        />
        <button
          type="button"
          onClick={onToggle}
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          className="absolute right-2 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-md text-[var(--app-text-muted)] hover:bg-[var(--app-panel-alt)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
        >
          {visible ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
        </button>
      </span>
    </div>
  );
}
