import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "YouTube feature terms",
  description: "Terms and user controls for Asset Insight's optional YouTube video publishing feature.",
};

export default function YoutubeTermsPage() {
  return (
    <main className="min-h-screen bg-slate-50 px-5 py-10 text-slate-950 sm:px-8 sm:py-16">
      <article className="mx-auto max-w-3xl rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm sm:p-12 [&_a]:underline [&_a]:underline-offset-4">
        <Link href="/">Back to Asset Insight</Link>
        <h1 className="mt-10 text-3xl font-semibold tracking-tight sm:text-4xl">YouTube feature terms</h1>
        <p className="mt-5 leading-7 text-slate-600">Last updated 18 October 2026</p>
        <div className="mt-8 space-y-8 leading-7 text-slate-600">
          <section>
            <h2 className="text-xl font-semibold text-slate-950">YouTube&apos;s terms and privacy</h2>
            <p className="mt-3">Asset Insight&apos;s optional video publishing feature uses YouTube API Services. By using these YouTube features, you agree to be bound by the <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a>. Review the <Link href="/privacy#youtube-privacy">Asset Insight privacy notice</Link> and <a href="https://policies.google.com/privacy">Google Privacy Policy</a> before connecting a channel or authorizing a video upload.</p>
          </section>
          <section>
            <h2 className="text-xl font-semibold text-slate-950">Authority and automatic public publication</h2>
            <p className="mt-3">Connect only a channel you are authorized to manage, and submit only videos you have the necessary rights and permissions to share publicly. Connecting makes this channel available to authorized Asset Insight administrators and superadmins for shared management. With a channel connected, explicitly submitting or resubmitting an Asset or Lot Listing report with eligible saved lot videos authorizes automatic public publication to that shared channel. No separate per-video administrator review or visibility choice is required. Publication uses the saved lot number, Title and Description, bounded to YouTube&apos;s limits, without new analysis. Original video bytes include their audio and embedded metadata without privacy redaction. Review that text and footage for personal or confidential content before submitting.</p>
          </section>
          <section>
            <h2 className="text-xl font-semibold text-slate-950">Visibility and report release</h2>
            <p className="mt-3">Public is the automatic publication target. Asset Insight initially transfers eligible videos privately as a staging step, then requests Public only when the current report&apos;s existing approval and release requirements are met. Private staging is not a selectable final visibility setting. Public content is available to anyone. The interface shows Public only after YouTube confirms it; YouTube review, upload limits, channel permissions or other restrictions may prevent that change. A saved link is not a guarantee of public availability. Eligible videos already queued by an explicit report submission, including those formerly waiting for manual review, may resume automatically. The service does not scan unrelated, unsubmitted historical reports to create uploads; capturing media, saving a draft or connecting a channel alone does not submit them.</p>
          </section>
          <section>
            <h2 className="text-xl font-semibold text-slate-950">Stopping access and removing data</h2>
            <p className="mt-3">Use Admin → YouTube to revoke access and request removal of the stored YouTube data, or use <a href="https://security.google.com/settings/security/permissions">Google account permissions</a> to revoke access directly. Original Asset Insight media and reports remain separate. These controls do not delete uploaded YouTube videos; use <a href="https://studio.youtube.com/">YouTube Studio</a> to manage them. Provider requests already in flight may finish. Previously generated or downloaded files are not automatically rewritten.</p>
          </section>
          <p className="break-words">Questions or data-removal requests: <a href="mailto:manom8193@gmail.com">manom8193@gmail.com</a>.</p>
        </div>
      </article>
    </main>
  );
}
