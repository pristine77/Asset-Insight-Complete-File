import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy notice",
  description: "How Asset Insight uses account, report, media, CRM and device data, with account-deletion choices and optional YouTube controls.",
};

const sections = [
  {
    title: "Account and profile information",
    body: "Asset Insight is used on the web and in its mobile app. We store the account and profile information you provide, such as your name, email address, company and contact details, profile image, and professional documents if you upload them. We use this information to provide your account, identify the author and owner of work, manage access and assignments, and communicate about account and report activity. Email sign-in uses a password hash rather than storing your password as readable text.",
  },
  {
    title: "Reports, photos and videos",
    body: "We process the form details, contracts, lot information, descriptions, valuations, notes, photographs, videos and other files that you submit or save to cloud drafts. Submitted media may contain people, voices, addresses, identification numbers or embedded location and other metadata. Cloud processing and AI-assisted analysis use the supplied details and media to produce editable previews and report files. Authorized users review the results; do not upload personal or confidential information that you are not authorized to use.",
  },
  {
    title: "Camera, microphone, photos and location permissions",
    body: "Camera and photo-library access let you capture or select report media. Microphone access records audio with videos or CRM voice recordings when you use those features. Optional location access can add location information to your work; manually entered location names remain available. You can control these permissions in your device or browser settings. Revoking a permission may make a saved local file unavailable to the app; it does not automatically remove a file already uploaded to cloud storage.",
  },
  {
    title: "CRM and support information",
    body: "For users assigned CRM access, we store lead and customer contact details, tasks, coverage information, follow-up notes, attachments and recordings supplied through that workspace. Explicit voice transcription or text-rewrite actions send the selected content for processing. Support requests include your messages, attachments and related account or report information. These records are used to provide the requested workflow and support, and are available to users or administrators with the relevant access.",
  },
  {
    title: "Offline work and operational activity",
    body: "Mobile offline work is saved on your device with its form details, lot groups, media references, order and cover choices. Offline photographs are not cloud-backed up. Deleting originals, uninstalling the app, clearing app data or losing access to the device can make local work unavailable. While the app is active, reconnection can synchronize operational metadata, including draft identities, lot and photo counts, actions, timestamps, app version and synchronization status. Reconnection does not automatically upload offline photos or submit a report. Operational history also records server-confirmed processing, saved changes, submissions and deletions; this is distinct from media upload.",
  },
  {
    title: "Service providers and optional sharing",
    body: "Asset Insight uses hosting, database and media-storage services, email delivery, and AI processing providers to operate accounts, store selected work, process supplied media and generate reports. Report access follows the account, assignment, approval and release controls. Authorized auction delivery sends the selected report details and media to the configured Auctioneer service. Optional Outlook exports send selected CRM task details to Microsoft after the account is connected and the export is requested. The optional Google and YouTube connection has the automatic public-publication behavior and controls below. Copies downloaded by users or sent to another service are not removed by deleting an Asset Insight account.",
  },
  {
    title: "Device and network security data",
    body: "When you sign in, we collect security metadata about that browser or app installation. This can include the device platform and form factor, operating system, browser or app version, screen details, camera availability and capability ranges, and browser-origin storage quota or native disk capacity. We also record the IP address derived by our server from the validated network proxy chain.",
  },
  {
    title: "Camera privacy during device registration",
    body: "Camera permission is used only to confirm whether camera hardware exists and to collect sanitized capability information for an administrator's access review. Asset Insight does not retain raw browser media-device identifiers and does not capture or store photos, video, or audio during device registration.",
  },
  {
    title: "How the data is used",
    body: "Authorized administrators use this information to approve, reject, revoke, or restore access for a particular installation, investigate unusual access, and apply an exact-address IP block to a particular user where necessary. Security decisions and policy changes are recorded in an access-controlled audit history.",
  },
  {
    title: "Security data retention and access",
    body: "Device registrations, observed IP addresses, and security audit history are retained indefinitely to preserve the requested security record. Access is limited to authorized administrators and the services that enforce account security. Short-lived enrollment and approval-status challenges expire automatically.",
  },
  {
    title: "Security records when an account is deleted",
    body: "When a user or administrator account is deleted, device registrations, IP observations, access challenges, and security audit records associated with that account are deleted as part of the same account-deletion process.",
  },
  {
    title: "Report records and retention",
    body: "Account deletion does not automatically purge report or cloud-draft data, uploaded media, CRM or support records, or report-activity history. These are separate from the account and device-security records. Report-activity history has no automatic expiry and is retained independently of deleted reports. A superadmin can remove history, retaining a minimal removal receipt that prevents delayed activity from recreating it. Contact us to request deletion of associated data and to review the scope of records and any copies held by another service. A request is not confirmation that removal has completed.",
  },
];

const youtubeSections = [
  {
    title: "Optional YouTube connection",
    body: "Asset Insight uses YouTube API Services for optional Asset and Lot Listing video publication. An authorized administrator connects the shared channel through Google after reviewing this notice and the YouTube feature terms. Other authorized Asset Insight administrators and superadmins can manage this shared connection and its video publication status. When a channel is connected, explicitly submitting or resubmitting an Asset or Lot Listing report with eligible lot videos authorizes their automatic public publication to that shared channel. There is no separate per-video administrator review or visibility selection. Connecting a channel alone does not submit reports or authorize new video transfers. Google handles sign-in; Asset Insight does not collect or store your Google password.",
  },
  {
    title: "Data we access and store",
    body: "The connection reads the selected channel's ID and title. We store these details, encrypted access and refresh tokens, token expiry, the administrator's connection authorization, and system publication authorization records. Historical administrator video-review records may remain as audit history; automatic publication does not create a human review. For videos submitted through Asset Insight, we store the report and lot association, original media reference, title and description, upload progress and receipts, YouTube video ID and link, publication status, and operational errors. Credentials and private upload-session details remain on the server and are not included in reports or sent to appraiser browsers.",
  },
  {
    title: "How videos are shared",
    body: "Explicit Asset or Lot Listing submission queues eligible videos associated with saved lots. Public titles and descriptions use the saved lot number, Title and Description, bounded to YouTube's text limits; no new analysis is run for publication. Original video bytes, including audio and embedded metadata, are transferred without privacy redaction. Review the saved lot text and original footage before submitting, and include only content you are authorized to share publicly. Asset Insight does not automatically append private contact details, valuations, GPS information, or private notes from other report fields; the saved lot text or original footage may itself contain such information. Uploads start private as a staging step. Asset Insight automatically requests Public only after the current report's existing approval and release requirements are met, and shows Public only after YouTube confirms it. Public videos, titles, and descriptions can be viewed and found by anyone. Google's review, quota, channel permissions or other restrictions can prevent public visibility even after release. Private staging is not a selectable final visibility setting.",
  },
  {
    title: "Why we use this data",
    body: "We use connection and video data to upload authorized clips, verify publication, avoid duplicate uploads during retries, and display publication status and confirmed links to authorized administrators. New report Excel files do not include a YouTube column. Original clips remain in Asset Insight's report storage and media ZIP; these are the originals supplied to Asset Insight, not downloads from YouTube. Eligible videos already queued by an explicit report submission, including those previously waiting for manual review, may resume automatically under this publication policy. Uncertain final upload outcomes are checked against the same saved upload before any more data is sent; a possible completed upload is not automatically replaced. Capturing media, saving a draft, or connecting a channel does not scan or submit unrelated, unsubmitted historical reports to YouTube.",
  },
  {
    title: "Disconnecting, revoking access, and removing videos",
    body: "Admin → YouTube provides Revoke access and erase YouTube data, with a confirmation explaining its effects. This stops new authorized work, requests Google permission revocation, and queues removal of stored YouTube credentials, channel details, and video API records. The interface distinguishes pending work from completed removal; an operation already sent to Google may finish. You can also revoke access in your Google account permissions. The service checks authorization periodically and initiates local cleanup when revocation or deletion of the authorizing account is detected. These controls do not delete videos on YouTube, original report media, or reports. Manage or delete uploaded videos separately in YouTube Studio. Previously generated files and downloaded copies are not automatically rewritten.",
  },
  {
    title: "Stored records and privacy requests",
    body: "YouTube API records are refreshed or removed on a bounded maintenance schedule. Unverifiable stale data is not kept indefinitely. Cache removal retains minimal suppression and administrative receipts so delayed work cannot restore erased data or upload the same video again. It does not rewrite historical report submission provenance or links already saved in generated files. Original report information and user-supplied media are separate from this YouTube API cache. You can request broader data removal through the contact below, including if you no longer have an Asset Insight account. Do not send passwords or authorization tokens.",
  },
  {
    title: "Browser storage and external services",
    body: "Asset Insight uses authentication cookies and browser or device storage to maintain your session, settings, and locally saved work. Reading this notice does not load an embedded YouTube player. Following a Google or YouTube link, signing in through Google, or watching a video on YouTube opens that service, whose own privacy policy and cookie or storage controls apply.",
  },
];

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-[var(--app-bg)] px-4 py-8 text-[var(--app-text)] sm:px-8 sm:py-12">
      <article className="mx-auto max-w-3xl rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5 shadow-sm sm:p-10 [&_a]:rounded-sm [&_a]:focus-visible:outline-2 [&_a]:focus-visible:outline-offset-4 [&_a]:focus-visible:outline-[var(--app-accent)]">
        <Link href="/" className="text-sm font-semibold text-[var(--app-text-muted)] underline-offset-4 hover:text-[var(--app-text)] hover:underline">
          Back to Asset Insight
        </Link>
        <p className="mt-10 text-xs font-semibold uppercase tracking-[0.28em] text-[var(--app-text-muted)]">Privacy notice</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">Asset Insight privacy notice</h1>
        <p className="mt-5 text-base leading-7 text-[var(--app-text-muted)]">Last updated 18 October 2026</p>
        <p className="mt-3 leading-7 text-[var(--app-text-muted)]">This notice explains information used by the Asset Insight web and mobile apps, your data-removal choices, and the optional YouTube connection. You do not need to sign in to read it.</p>
        <nav aria-label="Privacy sections" className="mt-6 flex flex-wrap gap-x-6 gap-y-3 text-sm font-semibold underline underline-offset-4">
          <a href="#account-and-data-deletion">Account and data deletion</a>
          <a href="#youtube-privacy">YouTube and Google data</a>
        </nav>

        <div className="mt-10 space-y-9">
          {sections.map((section) => (
            <section key={section.title}>
              <h2 className="text-xl font-semibold tracking-tight">{section.title}</h2>
              <p className="mt-3 leading-7 text-[var(--app-text-muted)]">{section.body}</p>
            </section>
          ))}
        </div>

        <section aria-labelledby="account-and-data-deletion" className="mt-12 border-t border-[var(--app-border)] pt-10">
          <h2 id="account-and-data-deletion" className="text-2xl font-semibold tracking-tight">Account and data deletion</h2>
          <p className="mt-3 leading-7 text-[var(--app-text-muted)]">Use Settings → Delete account when signed in, or contact us if you cannot access your account. Request deletion of associated report, media, CRM, support and activity data separately through the contact below. Review what each option removes before continuing.</p>
          <Link className="mt-4 inline-block font-semibold underline underline-offset-4" href="/account-deletion">How to delete your account and request data removal</Link>
        </section>

        <section aria-labelledby="youtube-privacy" className="mt-12 border-t border-[var(--app-border)] pt-10">
          <h2 id="youtube-privacy" className="text-2xl font-semibold tracking-tight">YouTube and Google data</h2>
          <div className="mt-8 space-y-8">
            {youtubeSections.map((section) => (
              <section key={section.title}>
                <h3 className="text-lg font-semibold">{section.title}</h3>
                <p className="mt-3 leading-7 text-[var(--app-text-muted)]">{section.body}</p>
              </section>
            ))}
          </div>
          <ul className="mt-8 space-y-3 text-sm leading-6 text-[var(--app-text-muted)] [&_a]:underline [&_a]:underline-offset-4">
            <li><Link href="/terms/youtube">Asset Insight YouTube feature terms</Link></li>
            <li><a href="https://policies.google.com/privacy">Google Privacy Policy</a></li>
            <li><a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a></li>
            <li><a href="https://security.google.com/settings/security/permissions">Revoke access in Google account permissions</a></li>
            <li><a href="https://studio.youtube.com/">Manage published videos in YouTube Studio</a></li>
          </ul>
          <p className="mt-8 break-words leading-7 text-[var(--app-text-muted)]">Privacy questions and data-removal requests: <a className="underline underline-offset-4" href="mailto:manom8193@gmail.com">manom8193@gmail.com</a>.</p>
        </section>
      </article>
    </main>
  );
}
