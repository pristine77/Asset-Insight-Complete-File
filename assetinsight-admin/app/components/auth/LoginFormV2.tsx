"use client";

import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useAdminTheme } from "@/app/components/providers/AdminThemeProvider";

type Particle = {
  x: number;
  y: number;
  anchorX: number;
  anchorY: number;
  phase: number;
  speed: number;
  orbit: number;
  radius: number;
  color: string;
};

type Edge = {
  from: number;
  to: number;
  color: string;
  pulseOffset: number;
  pulseSpeed: number;
  flickerPhase: number;
  branchSeed: number;
  surgeOffset: number;
  breakProgress: number;
};

function IconWrapper({
  children,
  className = "h-5 w-5",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function MailIcon({ className }: { className?: string }) {
  return (
    <IconWrapper className={className}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </IconWrapper>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <IconWrapper className={className}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 1 1 8 0v3" />
    </IconWrapper>
  );
}

function EyeIcon({ className }: { className?: string }) {
  return (
    <IconWrapper className={className}>
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="3" />
    </IconWrapper>
  );
}

function EyeOffIcon({ className }: { className?: string }) {
  return (
    <IconWrapper className={className}>
      <path d="M3 3 21 21" />
      <path d="M10.6 10.7A3 3 0 0 0 13.3 13.4" />
      <path d="M9.9 5.2A10.7 10.7 0 0 1 12 5c6 0 9.5 7 9.5 7a18.2 18.2 0 0 1-4 4.8" />
      <path d="M6.3 6.3A18.3 18.3 0 0 0 2.5 12S6 19 12 19a10.8 10.8 0 0 0 2.1-.2" />
    </IconWrapper>
  );
}

function ArrowRightIcon({ className }: { className?: string }) {
  return (
    <IconWrapper className={className}>
      <path d="M5 12h14" />
      <path d="m13 5 7 7-7 7" />
    </IconWrapper>
  );
}

const ADMIN_FEATURES = [
  "CRM leads",
  "User profiles",
  "File imports",
  "Upload assignments",
  "Report previews",
  "Report downloads",
];

function ParticleField({ theme }: { theme: "light" | "dark" }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    let animationFrame = 0;
    let particles: Particle[] = [];
    let tick = 0;
    const pointer = {
      x: 0,
      y: 0,
      active: false,
    };
    const RULES = {
      maxDistance: 210,
      maxNeighbors: 5,
      repelDistance: 36,
      spring: 0.055,
      pulseMin: 0.0018,
      pulseVariance: 0.0032,
    };

    const palette =
      theme === "dark"
        ? {
            red: "rgba(251, 146, 146, 0.99)",
            blue: "rgba(125, 211, 252, 0.99)",
            redLine: "rgba(248, 113, 113, 0.34)",
            blueLine: "rgba(96, 165, 250, 0.34)",
            redGlow: "rgba(252, 165, 165, 0.95)",
            blueGlow: "rgba(147, 197, 253, 0.95)",
          }
        : {
            red: "rgba(220, 38, 38, 0.98)",
            blue: "rgba(29, 78, 216, 0.98)",
            redLine: "rgba(220, 38, 38, 0.28)",
            blueLine: "rgba(29, 78, 216, 0.28)",
            redGlow: "rgba(248, 113, 113, 0.92)",
            blueGlow: "rgba(96, 165, 250, 0.92)",
          };

    const getEdgeColor = (index: number) => (index % 2 === 0 ? palette.redLine : palette.blueLine);
    const getPulseColor = (index: number) => (index % 2 === 0 ? palette.redGlow : palette.blueGlow);

    const resize = () => {
      const { innerWidth, innerHeight, devicePixelRatio } = window;
      const ratio = Math.min(devicePixelRatio || 1, 1.5);

      canvas.width = innerWidth * ratio;
      canvas.height = innerHeight * ratio;
      canvas.style.width = `${innerWidth}px`;
      canvas.style.height = `${innerHeight}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);

      const count = Math.max(56, Math.min(104, Math.floor(innerWidth / 13)));
      const cols = Math.max(6, Math.ceil(Math.sqrt((count * innerWidth) / Math.max(innerHeight, 1))));
      const rows = Math.max(5, Math.ceil(count / cols));
      const cellWidth = innerWidth / cols;
      const cellHeight = innerHeight / rows;

      particles = Array.from({ length: count }, (_, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        const anchorX = (col + 0.5) * cellWidth + (Math.random() - 0.5) * cellWidth * 0.42;
        const anchorY = (row + 0.5) * cellHeight + (Math.random() - 0.5) * cellHeight * 0.42;
        const isRed = index % 2 === 0;

        return {
          x: anchorX,
          y: anchorY,
          anchorX,
          anchorY,
          phase: Math.random() * Math.PI * 2,
          speed: 0.55 + Math.random() * 0.95,
          orbit: 10 + Math.random() * 28,
          radius: 1.9 + Math.random() * 2.5,
          color: isRed ? palette.red : palette.blue,
        };
      });
    };

    const draw = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      tick += 1;
      const t = tick * 0.012;

      context.clearRect(0, 0, width, height);

      for (const particle of particles) {
        const targetX =
          particle.anchorX +
          Math.cos(t * particle.speed + particle.phase) * particle.orbit;
        const targetY =
          particle.anchorY +
          Math.sin(t * (particle.speed * 0.82) + particle.phase) * particle.orbit * 0.76;

        particle.x += (targetX - particle.x) * RULES.spring;
        particle.y += (targetY - particle.y) * RULES.spring;

        if (pointer.active) {
          const pdx = pointer.x - particle.x;
          const pdy = pointer.y - particle.y;
          const pdistanceSq = pdx * pdx + pdy * pdy;

          if (pdistanceSq < 220 * 220 && pdistanceSq > 0.001) {
            const pdistance = Math.sqrt(pdistanceSq);
            const influence = (1 - pdistance / 220) * 8.5;
            particle.x -= (pdx / pdistance) * influence * 0.12;
            particle.y -= (pdy / pdistance) * influence * 0.12;
          }
        }
      }

      for (let i = 0; i < particles.length; i += 1) {
        for (let j = i + 1; j < particles.length; j += 1) {
          const a = particles[i];
          const b = particles[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distanceSq = dx * dx + dy * dy;

          if (distanceSq < RULES.repelDistance * RULES.repelDistance && distanceSq > 0.01) {
            const distance = Math.sqrt(distanceSq);
            const force = (1 - distance / RULES.repelDistance) * 0.42;
            const pushX = (dx / distance) * force;
            const pushY = (dy / distance) * force;
            a.x -= pushX;
            a.y -= pushY;
            b.x += pushX;
            b.y += pushY;
          }
        }
      }

      const edges: Edge[] = [];
      const neighborCounts = new Array(particles.length).fill(0);

      for (let i = 0; i < particles.length; i += 1) {
        for (let j = i + 1; j < particles.length; j += 1) {
          if (neighborCounts[i] >= RULES.maxNeighbors || neighborCounts[j] >= RULES.maxNeighbors) {
            continue;
          }

          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const distanceSq = dx * dx + dy * dy;

          if (distanceSq > RULES.maxDistance * RULES.maxDistance) continue;

          edges.push({
            from: i,
            to: j,
            color: getEdgeColor(i),
            pulseOffset: (i * 0.173 + j * 0.119) % 1,
            pulseSpeed: RULES.pulseMin + ((i + j) % 7) * (RULES.pulseVariance / 7),
            flickerPhase: (i + 1) * 0.71 + j * 0.37,
            branchSeed: ((i * 17 + j * 13) % 100) / 100,
            surgeOffset: (i + j) * 0.29,
            breakProgress: 0,
          });

          neighborCounts[i] += 1;
          neighborCounts[j] += 1;
        }
      }

      for (const edge of edges) {
        const from = particles[edge.from];
        const to = particles[edge.to];
        const dx = from.x - to.x;
        const dy = from.y - to.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        const nearPointer =
          pointer.active &&
          ((((from.x - pointer.x) * (from.x - pointer.x)) + ((from.y - pointer.y) * (from.y - pointer.y))) < 210 * 210 ||
            (((to.x - pointer.x) * (to.x - pointer.x)) + ((to.y - pointer.y) * (to.y - pointer.y))) < 210 * 210);

        const dynamicBreak = nearPointer
          ? Math.min(1, Math.max(0, 1 - distance / RULES.maxDistance) * 0.72 + 0.22)
          : 0;

        const opacity = (1 - distance / RULES.maxDistance) * (1 - dynamicBreak * 0.7);
        const stroke = edge.color.replace(/[\d.]+\)$/u, `${Math.max(0.02, opacity)})`);
        const flicker = Math.max(0, Math.sin(tick * 0.032 + edge.flickerPhase)) ** 10;
        const surge = Math.max(0, Math.sin(tick * 0.012 + edge.surgeOffset)) ** 18;
        const pointerBoost = nearPointer ? 0.24 : 0;
        const energetic = flicker + pointerBoost > 0.8 || surge + pointerBoost > 0.62;
        const energyStrength = Math.min(1, Math.max(flicker, surge) + pointerBoost);
        const breakOffset = dynamicBreak * Math.min(24, distance * 0.18);
        const offsetX = distance > 0 ? (-dy / distance) * breakOffset : 0;
        const offsetY = distance > 0 ? (dx / distance) * breakOffset : 0;
        const startX = from.x + offsetX;
        const startY = from.y + offsetY;
        const endX = to.x - offsetX;
        const endY = to.y - offsetY;

        context.beginPath();
        context.moveTo(startX, startY);
        context.lineTo(endX, endY);
        context.strokeStyle = stroke;
        context.lineWidth = energetic ? 1.35 + energyStrength * 1.2 : 1.05;
        context.stroke();

        const progress = (edge.pulseOffset + tick * edge.pulseSpeed) % 1;
        const pulseX = startX + (endX - startX) * progress;
        const pulseY = startY + (endY - startY) * progress;
        const pulseColor = getPulseColor(edge.from);

        context.beginPath();
        context.arc(pulseX, pulseY, 1.8 + energyStrength * 1.4, 0, Math.PI * 2);
        context.fillStyle = pulseColor;
        context.fill();

        if (energetic && energyStrength > 0.72) {
          const midX = startX + (endX - startX) * (0.25 + edge.branchSeed * 0.5);
          const midY = startY + (endY - startY) * (0.25 + edge.branchSeed * 0.5);
          const normalX = -dy / distance;
          const normalY = dx / distance;
          const branchLength = 8 + energyStrength * 16;
          const branchDirection = edge.branchSeed > 0.5 ? 1 : -1;
          const branchX = midX + normalX * branchLength * branchDirection;
          const branchY = midY + normalY * branchLength * branchDirection;

          context.beginPath();
          context.moveTo(midX, midY);
          context.lineTo(branchX, branchY);
          context.strokeStyle = pulseColor.replace(/[\d.]+\)$/u, `${0.24 + energyStrength * 0.58})`);
          context.lineWidth = 0.9 + energyStrength * 0.8;
          context.stroke();

          context.beginPath();
          context.moveTo(midX, midY);
          context.lineTo(pulseX, pulseY);
          context.strokeStyle = pulseColor.replace(/[\d.]+\)$/u, `${0.15 + energyStrength * 0.4})`);
          context.lineWidth = 0.8 + energyStrength * 0.9;
          context.stroke();
        }
      }

      for (const particle of particles) {
        context.beginPath();
        context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
        context.fillStyle = particle.color;
        context.shadowBlur = 8;
        context.shadowColor = particle.color;
        context.fill();
      }

      context.shadowBlur = 0;
      animationFrame = window.requestAnimationFrame(draw);
    };

    const handlePointerMove = (event: PointerEvent) => {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.active = true;
    };

    const handlePointerLeave = () => {
      pointer.active = false;
    };

    resize();
    draw();

    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerleave", handlePointerLeave);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerleave", handlePointerLeave);
    };
  }, [theme]);

  return <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full opacity-90" />;
}

function LoginShell({
  children,
  embedded,
}: {
  children: React.ReactNode;
  embedded: boolean;
}) {
  const { mode } = useAdminTheme();
  const isDark = mode === "dark";
  const theme = isDark ? "dark" : "light";

  if (embedded) {
    return <div className="w-full">{children}</div>;
  }

  return (
    <div className={`relative min-h-screen overflow-x-clip transition-colors ${isDark ? "bg-slate-950 text-slate-50" : "bg-slate-100 text-slate-950"}`}>
      <div className="fixed inset-0 z-0">
        <ParticleField theme={theme} />

        <div
          className={`absolute inset-0 ${
            isDark
              ? "bg-[radial-gradient(circle_at_top_left,_rgba(220,38,38,0.28),_transparent_28%),radial-gradient(circle_at_top_right,_rgba(37,99,235,0.24),_transparent_26%),linear-gradient(135deg,_rgba(2,6,23,0.88),_rgba(15,23,42,0.74))]"
              : "bg-[radial-gradient(circle_at_top_left,_rgba(220,38,38,0.18),_transparent_28%),radial-gradient(circle_at_top_right,_rgba(37,99,235,0.16),_transparent_26%),linear-gradient(135deg,_rgba(255,255,255,0.94),_rgba(241,245,249,0.82))]"
          }`}
        />
      </div>

      <div className="relative z-10 grid min-h-screen w-full lg:grid-cols-[1.05fr_0.95fr]">
        <section className="hidden items-center px-6 py-12 sm:px-10 lg:flex lg:px-16 xl:px-24">
          <div className="max-w-xl">
            <div className="mb-10 inline-flex items-center gap-5">
              <div
                className={`relative h-32 w-32 overflow-hidden rounded-[2.2rem] ${
                  isDark ? "bg-white/6 ring-2 ring-white/85 ring-offset-4 ring-offset-slate-950" : "bg-white shadow-[0_20px_50px_rgba(15,23,42,0.10)]"
                }`}
              >
                <Image src="/logo.png" alt="Asset Insight logo" fill sizes="128px" className="object-contain p-1" priority />
              </div>
              <div>
                <p className={`text-[0.7rem] font-semibold uppercase tracking-[0.38em] ${isDark ? "text-slate-400" : "text-slate-500"}`}>
                  Asset Insight
                </p>
                <p className={`text-sm font-medium ${isDark ? "text-slate-200" : "text-slate-700"}`}>Admin access</p>
              </div>
            </div>

            <div className="space-y-5">
              <h1 className="hidden max-w-lg font-sans text-5xl font-semibold leading-none tracking-[-0.05em] text-balance sm:block sm:text-6xl">
                Asset Insight admin portal.
              </h1>
              <p className={`hidden max-w-lg text-base leading-7 sm:block sm:text-lg ${isDark ? "text-slate-300" : "text-slate-600"}`}>
                Sign in to access reports, approvals, users, and internal operations.
              </p>
              <div className="flex max-w-2xl flex-wrap gap-3 pt-2">
                {ADMIN_FEATURES.map((feature) => (
                  <span
                    key={feature}
                    className={`rounded-full px-4 py-2 text-sm font-medium backdrop-blur-xl ${
                      isDark
                        ? "border border-white/12 bg-white/8 text-slate-100 shadow-[0_10px_30px_rgba(2,6,23,0.18)]"
                        : "border border-white/70 bg-white/55 text-slate-700 shadow-[0_12px_30px_rgba(15,23,42,0.08)]"
                    }`}
                  >
                    {feature}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="flex min-h-screen items-center px-6 py-10 sm:px-10 lg:min-h-0 lg:px-12 lg:py-12 xl:px-16">
          <div className="w-full">{children}</div>
        </section>
      </div>
    </div>
  );
}

export default function LoginFormV2({ embedded = false }: { embedded?: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/reports";
  const { mode } = useAdminTheme();
  const isDark = mode === "dark";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.message || "Login failed");
      }
      router.push(next);
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to login");
    } finally {
      setLoading(false);
    }
  }

  return (
    <LoginShell embedded={embedded}>
      <form
        onSubmit={onSubmit}
        className={`ml-auto w-full max-w-xl rounded-[2rem] p-6 backdrop-blur-2xl transition-colors sm:p-8 ${
          isDark
            ? "border border-white/10 bg-slate-900/55 shadow-[0_30px_120px_rgba(2,6,23,0.55)]"
            : "border border-white/60 bg-white/75 shadow-[0_30px_120px_rgba(15,23,42,0.14)]"
        }`}
      >
        <div className="space-y-3">
          <p className={`text-sm font-semibold uppercase tracking-[0.28em] ${isDark ? "text-slate-400" : "text-slate-500"}`}>
            Admin portal
          </p>
          <div className="space-y-2">
            <h2 className={`text-3xl font-semibold tracking-[-0.04em] sm:text-4xl ${isDark ? "text-white" : "text-slate-950"}`}>
              Sign in to manage reports, approvals, and operations.
            </h2>
            <p className={`hidden max-w-lg text-sm leading-6 sm:block sm:text-base ${isDark ? "text-slate-300" : "text-slate-600"}`}>
              Built for speed and clarity, with a cleaner visual hierarchy and motion-led background that still keeps the login action front and center.
            </p>
          </div>
        </div>

        <div className="mt-8 space-y-5">
          <label className="block space-y-2">
            <span className={`text-sm font-medium ${isDark ? "text-slate-200" : "text-slate-700"}`}>Email address</span>
            <span className="relative block">
              <MailIcon className={`pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 ${isDark ? "text-slate-500" : "text-slate-400"}`} />
              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={loading}
                placeholder="admin@assetinsight.com"
                className={`h-14 w-full rounded-2xl pl-12 pr-4 text-sm outline-none transition disabled:cursor-not-allowed disabled:opacity-70 ${
                  isDark
                    ? "border border-white/10 bg-white/5 text-white placeholder:text-slate-500 focus:border-red-400 focus:ring-4 focus:ring-red-400/10"
                    : "border border-slate-200/80 bg-white/90 text-slate-900 placeholder:text-slate-400 focus:border-red-500 focus:ring-4 focus:ring-red-500/10"
                }`}
              />
            </span>
          </label>

          <label className="block space-y-2">
            <span className={`text-sm font-medium ${isDark ? "text-slate-200" : "text-slate-700"}`}>Password</span>
            <span className="relative block">
              <LockIcon className={`pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 ${isDark ? "text-slate-500" : "text-slate-400"}`} />
              <input
                type={showPassword ? "text" : "password"}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={loading}
                placeholder="Enter your password"
                className={`h-14 w-full rounded-2xl pl-12 pr-14 text-sm outline-none transition disabled:cursor-not-allowed disabled:opacity-70 ${
                  isDark
                    ? "border border-white/10 bg-white/5 text-white placeholder:text-slate-500 focus:border-blue-400 focus:ring-4 focus:ring-blue-400/10"
                    : "border border-slate-200/80 bg-white/90 text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
                }`}
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                disabled={loading}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className={`absolute right-3 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full transition disabled:cursor-not-allowed ${
                  isDark
                    ? "text-slate-400 hover:bg-white/10 hover:text-white"
                    : "text-slate-500 hover:bg-slate-900/5 hover:text-slate-700"
                }`}
              >
                {showPassword ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
              </button>
            </span>
          </label>
        </div>

        {error ? (
          <div className={`mt-5 rounded-2xl px-4 py-3 text-sm ${isDark ? "border border-red-400/20 bg-red-400/10 text-red-200" : "border border-red-500/25 bg-red-500/10 text-red-700"}`}>
            {error}
          </div>
        ) : null}

        <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className={`text-sm ${isDark ? "text-slate-300" : "text-slate-600"}`}>
            Protected access only for verified internal administrators.
          </p>

          <button
            type="submit"
            disabled={loading}
            className={`inline-flex h-14 items-center justify-center gap-2 rounded-full px-6 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-70 ${
              isDark
                ? "bg-white text-slate-950 hover:scale-[1.01] hover:bg-slate-200"
                : "bg-slate-950 text-white hover:scale-[1.01] hover:bg-slate-800"
            }`}
          >
            <span>{loading ? "Signing in..." : "Enter dashboard"}</span>
            <ArrowRightIcon className={`h-4 w-4 ${loading ? "animate-pulse" : ""}`} />
          </button>
        </div>
      </form>
    </LoginShell>
  );
}
