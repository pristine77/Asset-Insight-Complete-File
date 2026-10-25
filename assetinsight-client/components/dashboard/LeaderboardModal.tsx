"use client";

import { Crown, Trophy, X } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { UserAvatar } from "@/components/user/UserAvatar";
import type { DashboardAnalytics } from "@/services/dashboard";
import styles from "./LeaderboardModal.module.css";

export default function LeaderboardModal({
  data,
  onClose,
}: {
  data: DashboardAnalytics["leaderboard"];
  onClose: () => void;
}) {
  const [metric, setMetric] = useState<"lots" | "reports">("lots");
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const entries = [...data.entries].sort((a, b) => b[metric] - a[metric] || b.lots - a.lots);
  return (
    <div className={styles.overlay} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="leaderboard-title">
        <div className={styles.particles} aria-hidden>
          {Array.from({ length: 18 }, (_, index) => {
            const angle = (index / 18) * Math.PI * 2;
            return (
              <i
                key={index}
                style={
                  {
                    "--i": index,
                    "--particle-x": `${Math.round(Math.cos(angle) * 290)}px`,
                    "--particle-y": `${Math.round(90 + Math.sin(angle) * 150)}px`,
                  } as CSSProperties
                }
              />
            );
          })}
        </div>
        <header className={styles.header}>
          <span className={styles.trophy}><Trophy size={24} aria-hidden /></span>
          <div>
            <p>Team performance</p>
            <h2 id="leaderboard-title">Leaderboard</h2>
          </div>
          <button onClick={onClose} aria-label="Close leaderboard"><X size={20} /></button>
        </header>
        <div className={styles.totals}>
          <span><strong>{data.totals.users}</strong> contributors</span>
          <span><strong>{data.totals.lots}</strong> lots</span>
          <span><strong>{data.totals.reports}</strong> reports</span>
        </div>
        <div className={styles.tabs} role="tablist" aria-label="Leaderboard metric">
          <button data-active={metric === "lots"} onClick={() => setMetric("lots")}>Lots</button>
          <button data-active={metric === "reports"} onClick={() => setMetric("reports")}>Reports</button>
        </div>
        <div className={styles.list}>
          {entries.length ? entries.map((entry, index) => (
            <div className={styles.row} key={entry.userId}>
              <span className={styles.rank} data-podium={index < 3}>{index === 0 ? <Crown size={17} /> : index + 1}</span>
              <UserAvatar user={{ username: entry.displayName, avatarUrl: entry.avatarUrl }} size={38} />
              <strong>{entry.displayName}</strong>
              <span><b>{entry.lots}</b> lots</span>
              <span><b>{entry.reports}</b> reports</span>
            </div>
          )) : <div className={styles.empty}>No team activity in this period.</div>}
        </div>
      </section>
    </div>
  );
}
