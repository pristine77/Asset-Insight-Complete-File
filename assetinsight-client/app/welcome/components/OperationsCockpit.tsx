import { CheckCircle2 } from "lucide-react";
import { journeySteps } from "../data/constants";

export default function OperationsCockpit() {
  return (
    <section id="delivery" className="scroll-mt-8 bg-[#071d36] text-white">
      <div className="mx-auto grid w-full max-w-[1536px] gap-12 px-5 py-20 sm:px-8 lg:grid-cols-[0.8fr_1fr] lg:items-center lg:gap-20 lg:px-[60px]">
        <div className="max-w-[560px]">
          <h2 className="text-4xl font-semibold leading-[1.18] tracking-[-0.04em] sm:text-5xl">
            From field capture to a finished client package.
          </h2>
          <p className="mt-6 text-lg leading-8 text-slate-300">
            Keep photos, notes, lots, and review work moving in one clear path, so every package is organized before it reaches the client.
          </p>
          <p className="mt-8 inline-flex items-center gap-3 text-sm font-medium text-slate-200">
            <CheckCircle2 className="h-5 w-5 text-[#4590ff]" />
            One reliable handoff from capture to delivery
          </p>
        </div>

        <ol className="border-t border-white/15">
          {journeySteps.map((step, index) => (
            <li
              key={step.title}
              className="grid grid-cols-[48px_1fr] gap-5 border-b border-white/15 py-7"
            >
              <span className="grid h-10 w-10 place-items-center rounded-lg border border-[#4590ff]/60 text-sm font-semibold text-[#79adff]">
                0{index + 1}
              </span>
              <div>
                <div className="flex items-center gap-3">
                  <step.icon className="h-5 w-5 text-[#79adff]" strokeWidth={1.8} />
                  <h3 className="text-lg font-semibold">{step.title}</h3>
                </div>
                <p className="mt-2 max-w-lg text-sm leading-6 text-slate-300">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
