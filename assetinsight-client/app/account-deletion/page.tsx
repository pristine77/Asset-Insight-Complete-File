import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Account and data deletion",
  description: "How to delete an Asset Insight account and request removal of associated report, media and activity data, including without app access.",
};

export default function AccountDeletionPage() {
  return (
    <main className="min-h-screen bg-[var(--app-bg)] px-4 py-8 text-[var(--app-text)] sm:px-8 sm:py-12">
      <article className="mx-auto max-w-3xl rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5 shadow-sm sm:p-10 [&_a]:rounded-sm [&_a]:underline [&_a]:underline-offset-4 [&_a]:focus-visible:outline-2 [&_a]:focus-visible:outline-offset-4 [&_a]:focus-visible:outline-[var(--app-accent)]">
        <Link className="text-sm font-semibold" href="/">Back to Asset Insight</Link>
        <p className="mt-10 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--app-text-muted)]">Account controls</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Delete your Asset Insight account and request data removal</h1>
        <p className="mt-5 leading-7 text-[var(--app-text-muted)]">You can read these instructions without signing in or installing the app. Account deletion and removal of associated work are separate operations in Asset Insight.</p>

        <div className="mt-8 space-y-9 leading-7 text-[var(--app-text-muted)]">
          <section aria-labelledby="before-deletion">
            <h2 id="before-deletion" className="text-xl font-semibold text-[var(--app-text)]">Before you continue</h2>
            <p className="mt-3">Export or download work you need and are authorized to keep. Account deletion removes your ability to sign in and cannot be undone through the app. It does not automatically delete report files or media. If you want those removed too, include them in the data-removal request below.</p>
          </section>

          <section aria-labelledby="delete-account">
            <h2 id="delete-account" className="text-xl font-semibold text-[var(--app-text)]">1. Delete the account</h2>
            <ol className="mt-3 list-decimal space-y-2 pl-5">
              <li>Sign in to the Asset Insight web app and open <Link href="/settings" prefetch={false}>Settings</Link>.</li>
              <li>Select <strong className="font-semibold text-[var(--app-text)]">Delete account</strong>, read the confirmation, and enter your password if requested.</li>
              <li>Confirm only when you are ready. Wait for the result; an error or interrupted request is not confirmation of deletion.</li>
            </ol>
            <p className="mt-3">Successful account deletion removes your account record and associated device registrations, observed IP addresses, access challenges and security audit records. It does not automatically purge reports, cloud drafts, uploaded media, CRM records, support records or report-activity history.</p>
          </section>

          <section aria-labelledby="request-data-removal">
            <h2 id="request-data-removal" className="text-xl font-semibold text-[var(--app-text)]">2. Request associated data removal or help accessing your account</h2>
            <p className="mt-3">Email <a className="break-all" href="mailto:manom8193@gmail.com?subject=Asset%20Insight%20account%20and%20data%20deletion">manom8193@gmail.com</a> with the subject “Asset Insight account and data deletion”. This option also works if you cannot sign in, your device is pending approval, or you no longer have the app.</p>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>Identify the email address associated with your Asset Insight account.</li>
              <li>Say whether you want account deletion, associated-data deletion, or both.</li>
              <li>Identify relevant reports, contracts, cloud drafts, media, CRM, support or activity records, where known. You can request review of all data associated with your account without knowing individual report IDs.</li>
            </ul>
            <p className="mt-3">Do not send passwords, reset codes, access tokens or unnecessary copies of personal documents. We may need to verify account ownership and the scope of records before acting. Opening the email link prepares a message in your email app; it does not send a request automatically. Sending a request is not confirmation that removal has completed.</p>
          </section>

          <section aria-labelledby="remaining-copies">
            <h2 id="remaining-copies" className="text-xl font-semibold text-[var(--app-text)]">What may remain separately</h2>
            <ul className="mt-3 list-disc space-y-3 pl-5">
              <li><strong className="font-semibold text-[var(--app-text)]">Reports and history:</strong> server report and media records are separate from your account. Report-activity history has no automatic expiry and can survive report deletion. A superadmin history-removal operation retains a minimal receipt to stop delayed synchronization from restoring that history. Ask for these records to be reviewed in your request.</li>
              <li><strong className="font-semibold text-[var(--app-text)]">Device-only work:</strong> offline drafts and original photos or videos on your phone, gallery, browser or computer are not removed by server account deletion. Keep necessary authorized copies before clearing local app or browser data. Gallery originals are managed separately in your device&apos;s photos or files app.</li>
              <li><strong className="font-semibold text-[var(--app-text)]">Shared and downloaded copies:</strong> files already downloaded or delivered to another service are not automatically removed. Uploaded YouTube videos must be managed separately in YouTube Studio; revoking the connection does not delete those videos.</li>
            </ul>
            <p className="mt-3">Ask us to confirm what has been removed, what is still pending and whether any records remain. These instructions do not mean that your account or data has already been deleted.</p>
          </section>

          <p className="border-t border-[var(--app-border)] pt-6">Read the <Link href="/privacy">Asset Insight privacy notice</Link> for data use, storage and optional integration controls.</p>
        </div>
      </article>
    </main>
  );
}
