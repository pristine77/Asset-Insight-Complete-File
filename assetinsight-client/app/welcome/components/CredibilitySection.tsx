import { results } from "../data/constants";

export default function CredibilitySection() {
  return (
    <section id="teams" className="scroll-mt-8 bg-[var(--app-bg)]">
      <div className="mx-auto grid w-full max-w-[1536px] gap-12 px-5 py-20 sm:px-8 lg:grid-cols-[0.7fr_1fr] lg:gap-20 lg:px-[60px]">
        <div className="max-w-[520px]">
          <h2 className="text-4xl font-semibold leading-[1.2] tracking-[-0.04em] text-[var(--app-text)] sm:text-5xl">
            Built for appraisers, admins, and auction teams.
          </h2>
          <p className="mt-6 text-lg leading-8 text-[var(--app-text-muted)]">
            Everyone works from the same clear record, from the first inspection photo to the package a client can download and review.
          </p>
        </div>

        <div className="grid border-l border-t border-[var(--app-border)] sm:grid-cols-2">
          {results.map((item) => (
            <article
              key={item.title}
              className="border-b border-r border-[var(--app-border)] bg-[var(--app-panel)] p-6 sm:p-8"
            >
              <item.icon className="h-7 w-7 text-[var(--app-accent)]" strokeWidth={1.8} />
              <h3 className="mt-6 text-lg font-semibold text-[var(--app-text)]">{item.title}</h3>
              <p className="mt-2 text-sm leading-6 text-[var(--app-text-muted)]">{item.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
