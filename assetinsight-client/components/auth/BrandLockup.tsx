export default function BrandLockup({
  inverse = false,
  compact = false,
}: {
  inverse?: boolean;
  compact?: boolean;
}) {
  return (
    <span
      className={`cv-brand-lockup relative inline-block shrink-0 ${
        compact ? "h-10 w-[124px]" : "h-[50px] w-[156px]"
      }`}
      data-inverse={inverse}
      aria-label="Asset Insight"
      role="img"
    >
      <span
        aria-hidden="true"
        className="cv-brand-logo absolute inset-0 bg-contain bg-left bg-no-repeat"
      />
      <style>{`
        .cv-brand-logo {
          background-image: url("/brand/asset-insight-light-compact.png");
        }

        html[data-theme="dark"] .cv-brand-logo,
        .cv-brand-lockup[data-inverse="true"] .cv-brand-logo {
          background-image: url("/brand/asset-insight-dark-compact.png");
        }
      `}</style>
    </span>
  );
}
