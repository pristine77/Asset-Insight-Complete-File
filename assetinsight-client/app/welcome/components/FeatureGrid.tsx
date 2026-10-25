import { ChevronRight } from "lucide-react";
import { workflows } from "../data/constants";

export default function FeatureGrid() {
  return (
    <section id="workflows" className="bg-[var(--app-bg)] scroll-mt-8">
      <div className="mx-auto grid w-full max-w-[1536px] gap-10 px-5 py-14 sm:px-8 lg:grid-cols-[400px_1fr] lg:gap-[60px] lg:px-[60px]">
        <div>
          <h2 className="max-w-[420px] text-3xl font-semibold leading-[1.3] tracking-[-0.035em] text-[var(--app-text)] sm:text-[2.15rem]">
            One workspace for every valuation workflow.
          </h2>
        </div>

        <div className="border-t border-[var(--app-border)] lg:-mt-14">
          {workflows.map((item) => (
            <article
              key={item.title}
              className="group grid grid-cols-[48px_1fr_24px] items-center gap-5 border-b border-[var(--app-border)] px-3 py-5 transition-colors hover:bg-[var(--app-panel-alt)] sm:px-5"
            >
              <item.icon
                aria-hidden="true"
                className="h-8 w-8 text-[var(--app-accent)]"
                strokeWidth={1.8}
              />
              <div>
                <h3 className="text-base font-semibold text-[var(--app-text)]">{item.title}</h3>
                <p className="mt-1 text-sm leading-5 text-[var(--app-text-muted)]">{item.description}</p>
              </div>
              <ChevronRight
                aria-hidden="true"
                className="h-5 w-5 text-[var(--app-text-muted)] transition-transform group-hover:translate-x-0.5"
                strokeWidth={1.8}
              />
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
