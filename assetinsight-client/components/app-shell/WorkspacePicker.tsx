"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, FileText, FolderOpen, ListTodo, LogOut, Moon, Sun, UsersRound } from "lucide-react";
import BrandLockup from "@/components/auth/BrandLockup";
import { useAuthContext } from "@/context/AuthContext";
import { useColorMode } from "@/components/providers/ColorModeProvider";
import styles from "./WorkspacePicker.module.css";

export default function WorkspacePicker() {
  const { user, loading, loggingOut, logout } = useAuthContext();
  const { resolvedTheme, toggleMode } = useColorMode();
  const router = useRouter();
  useEffect(() => {
    if (!loading && !loggingOut && user && user.isCrmAgent !== true) router.replace("/dashboard");
  }, [user, loading, loggingOut, router]);
  if (!user || user.isCrmAgent !== true || loading || loggingOut) return <div className="app-page" role="status">Opening workspace…</div>;
  return <div className={styles.page}>
    <header className={styles.topbar}>
      <BrandLockup compact />
      <div className={styles.actions}>
        <button className="app-button app-button--secondary app-button--icon" onClick={toggleMode} aria-label={resolvedTheme === "dark" ? "Use light theme" : "Use dark theme"}>{resolvedTheme === "dark" ? <Sun size={19} /> : <Moon size={19} />}</button>
        <button className="app-button app-button--secondary" onClick={() => void logout()} disabled={loggingOut}><LogOut size={17} aria-hidden /> Sign out</button>
      </div>
    </header>
    <main className={styles.main}>
      <div className={styles.heading}><h1>Choose your workspace</h1><p>Select where you want to work.</p></div>
      <div className={styles.options}>
        <section className={styles.option} aria-labelledby="listings-title">
          <span className={styles.icon}><FolderOpen size={26} aria-hidden /></span>
          <h2 id="listings-title">Listings</h2>
          <p>Create and review asset, lot listing, real estate and salvage reports.</p>
          <ul><li><FileText size={17} aria-hidden /> Reports and previews</li><li><FolderOpen size={17} aria-hidden /> Drafts and incoming work</li></ul>
          <Link href="/dashboard" prefetch={false} className="app-button app-button--primary">Open Listings <ArrowRight size={18} aria-hidden /></Link>
        </section>
        <section className={styles.option} aria-labelledby="crm-title">
          <span className={styles.icon}><UsersRound size={26} aria-hidden /></span>
          <h2 id="crm-title">CRM</h2>
          <p>Manage your assigned leads, follow-ups and appointments.</p>
          <ul><li><ListTodo size={17} aria-hidden /> Dashboard and tasks</li><li><UsersRound size={17} aria-hidden /> Transfers and Outlook</li></ul>
          <Link href="/crm" prefetch={false} className="app-button app-button--primary">Open CRM <ArrowRight size={18} aria-hidden /></Link>
        </section>
      </div>
      <p className={styles.account}>Signed in as <strong>{user.username || user.email}</strong></p>
    </main>
  </div>;
}
