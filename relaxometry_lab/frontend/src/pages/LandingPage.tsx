import { landingContent, type FeatureCard, type ResourceCardContent } from "./landingContent";

function setDemoFlag() {
  sessionStorage.setItem("rl_demo", "1");
}

function ToolCard({ icon, iconBg, title, desc, tags, linkToTool, comingSoon }: FeatureCard) {
  const content = (
    <>
      {comingSoon && (
        <span className="absolute top-4 right-4 rounded-[10px] bg-[#f0f0f0] px-2.5 py-1 text-[10px] font-bold tracking-[.04em] text-muted">
          Coming Soon
        </span>
      )}
      <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-xl text-2xl" style={{ background: iconBg }}>
        {icon}
      </div>
      <div className="text-base font-bold text-navy">{title}</div>
      <div className="flex-1 text-[13px] leading-[1.55] text-muted">{desc}</div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {tags.map((t) => (
          <span
            key={t.label}
            className={`rounded-[10px] px-2.5 py-1 text-[10.5px] font-semibold ${
              t.gray ? "bg-[#eee] text-muted" : "bg-accent-light text-navy"
            }`}
          >
            {t.label}
          </span>
        ))}
      </div>
      {!comingSoon && linkToTool && (
        <div className="group-hover:translate-x-1 mt-1.5 text-lg text-accent transition-transform">→</div>
      )}
    </>
  );

  const baseClass =
    "group relative flex flex-col gap-2.5 rounded-2xl border-[1.5px] border-transparent bg-card px-6.5 py-7 shadow-card no-underline transition-[transform,box-shadow,border-color]";

  if (comingSoon || !linkToTool) {
    return <div className={`${baseClass} pointer-events-none opacity-60`}>{content}</div>;
  }
  return (
    <a
      href="/tool"
      className={`${baseClass} text-inherit hover:-translate-y-[3px] hover:border-accent hover:shadow-[0_8px_28px_rgba(35,74,110,.16)]`}
    >
      {content}
    </a>
  );
}

function ResourceCard({ icon, title, desc, href, external, isDemoLink }: ResourceCardContent) {
  return (
    <a
      href={href}
      onClick={isDemoLink ? setDemoFlag : undefined}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className="flex flex-col gap-1.5 rounded-xl border-[1.5px] border-transparent bg-card px-5 py-5.5 text-inherit no-underline shadow-card transition-[transform,box-shadow,border-color] hover:-translate-y-0.5 hover:border-border hover:shadow-[0_6px_20px_rgba(35,74,110,.14)]"
    >
      <div className="mb-1 text-[26px]">{icon}</div>
      <div className="text-sm font-bold text-navy">{title}</div>
      <div className="text-xs leading-[1.5] text-muted">{desc}</div>
    </a>
  );
}

export function LandingPage() {
  const { nav, hero, tools, workflow, dataFormats, resources, footer } = landingContent;

  return (
    <div className="flex h-full flex-col">
      <nav className="flex h-13 flex-shrink-0 items-center gap-3 bg-navy px-6 text-white shadow-[0_2px_6px_rgba(0,0,0,.25)]">
        <span className="mr-3 text-base font-bold tracking-wide text-white">{nav.brand}</span>
        <div className="mx-2 h-6 w-px bg-white/25" />
        <a
          href="/tool"
          className="ml-auto rounded-full border border-white/35 px-3.5 py-1 text-[13px] text-white/80 no-underline transition-colors hover:bg-white/10"
        >
          {nav.openTool}
        </a>
      </nav>

      <main className="flex-1 overflow-y-auto">
        {/* Hero */}
        <section className="relative overflow-hidden bg-[linear-gradient(160deg,#1a3a56_0%,#234a6e_55%,#2f5f8e_100%)] px-8 pt-20 pb-18 text-center text-white">
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage: "radial-gradient(circle, rgba(255,255,255,.07) 1px, transparent 1px)",
              backgroundSize: "22px 22px",
            }}
          />
          <div className="relative mx-auto max-w-[680px]">
            <div className="mb-6 inline-block rounded-full border border-white/35 px-3.5 py-1 text-[11px] font-semibold tracking-[.06em] text-white/75">
              {hero.badge}
            </div>
            <h1 className="mb-4 text-[52px] leading-[1.1] font-extrabold tracking-[-.02em] text-white">{hero.title}</h1>
            <p className="mx-auto mb-9 max-w-[520px] text-[17px] leading-[1.6] text-white/78">
              {hero.subtitlePrefix}
              <sub className="relative top-[0.12em] text-[0.55em]">2</sub>
              {hero.subtitleMid}
              <sub className="relative top-[0.12em] text-[0.55em]">1</sub>
              {hero.subtitleSuffix}
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              <a
                href="/tool"
                className="inline-flex items-center gap-1.5 rounded-lg border-none bg-white px-7 py-3 text-sm font-semibold text-navy no-underline transition-colors hover:bg-accent-light"
              >
                {hero.primaryCta}
              </a>
              <a
                href="/tool"
                onClick={setDemoFlag}
                className="inline-flex items-center gap-1.5 rounded-lg border-[1.5px] border-white/50 bg-transparent px-7 py-3 text-sm font-semibold text-white no-underline transition-colors hover:border-white hover:bg-white/10"
              >
                {hero.secondaryCta}
              </a>
            </div>
          </div>
        </section>

        {/* Tools */}
        <div className="mx-auto max-w-[1000px] px-8 py-14">
          <div className="mb-2 text-[11px] font-bold tracking-[.1em] text-accent uppercase">{tools.eyebrow}</div>
          <h2 className="mb-2 text-[26px] font-bold text-navy">{tools.title}</h2>
          <p className="mb-9 max-w-[540px] text-sm text-muted">{tools.subtitle}</p>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-5">
            {tools.cards.map((c) => (
              <ToolCard key={c.title} {...c} />
            ))}
          </div>
        </div>

        <div className="mx-auto max-w-[1000px] px-8">
          <hr className="border-t border-border" />
        </div>

        {/* How it works */}
        <div className="mx-auto max-w-[1000px] px-8 py-14">
          <div className="mb-2 text-[11px] font-bold tracking-[.1em] text-accent uppercase">{workflow.eyebrow}</div>
          <h2 className="mb-2 text-[26px] font-bold text-navy">{workflow.title}</h2>
          <p className="mb-9 max-w-[540px] text-sm text-muted">{workflow.subtitle}</p>

          <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
            {workflow.steps.map((s, i) => (
              <div key={s.title} className="relative flex flex-col items-center px-5 text-center">
                {i > 0 && <div className="absolute top-6 left-0 h-12 w-px bg-border" />}
                <div className="mb-3.5 flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-navy text-lg font-bold text-white">
                  {i + 1}
                </div>
                <div className="mb-1.5 text-sm font-bold text-navy">{s.title}</div>
                <div className="text-[12.5px] leading-[1.55] text-muted">{s.desc}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="mx-auto max-w-[1000px] px-8">
          <hr className="border-t border-border" />
        </div>

        {/* Data formats */}
        <div className="mx-auto max-w-[1000px] px-8 py-14">
          <div className="mb-2 text-[11px] font-bold tracking-[.1em] text-accent uppercase">{dataFormats.eyebrow}</div>
          <h2 className="mb-2 text-[26px] font-bold text-navy">{dataFormats.title}</h2>
          <p className="mb-9 max-w-[540px] text-sm text-muted">{dataFormats.subtitle}</p>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-5">
            {dataFormats.cards.map((c) => (
              <ToolCard key={c.title} {...c} />
            ))}
          </div>
        </div>

        <div className="mx-auto max-w-[1000px] px-8">
          <hr className="border-t border-border" />
        </div>

        {/* Resources */}
        <div className="mx-auto max-w-[1000px] px-8 py-14">
          <div className="mb-2 text-[11px] font-bold tracking-[.1em] text-accent uppercase">{resources.eyebrow}</div>
          <h2 className="mb-2 text-[26px] font-bold text-navy">{resources.title}</h2>
          <p className="mb-9 max-w-[540px] text-sm text-muted">{resources.subtitle}</p>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
            {resources.cards.map((c) => (
              <ResourceCard key={c.title} {...c} />
            ))}
          </div>
        </div>

        <footer className="px-8 py-8 text-center text-xs text-muted">{footer}</footer>
      </main>
    </div>
  );
}
