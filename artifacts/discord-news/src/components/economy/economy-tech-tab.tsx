import { Map as MapIcon, ReceiptText } from "lucide-react";

export function EconomyTechTab() {
  return (
    <Placeholder
      icon={ReceiptText}
      title="經濟科技"
      description="提升稅收效率與經濟產能的科技研發將在之後的版本推出。"
    />
  );
}

function Placeholder({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof MapIcon;
  title: string;
  description: string;
}) {
  return (
    <section className="rounded-2xl border border-white/15 bg-black/55 p-10 text-center backdrop-blur">
      <Icon className="mx-auto mb-3 h-10 w-10 text-white/35" />
      <h2 className="mb-2 font-serif text-lg font-bold text-white/85">{title}</h2>
      <p className="mx-auto max-w-md text-sm leading-relaxed text-white/55">
        {description}
      </p>
      <span className="mt-4 inline-block rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs text-white/50">
        即將推出
      </span>
    </section>
  );
}
