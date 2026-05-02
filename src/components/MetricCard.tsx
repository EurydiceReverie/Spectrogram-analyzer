import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface MetricCardProps {
  label: string;
  value: string;
  status?: "good" | "warning" | "bad" | "neutral";
  detail?: string;
  icon?: ReactNode;
  index?: number;
  reference?: string;  // 3.1: "How we measure this" tooltip text
}

// ── Color system ─────────────────────────────────────────────────────
// good    → #2FE0DA teal   — clean / within spec / authentic
// warning → #F97316 orange — elevated / needs attention
// bad     → #EF4444 red   — clipping / fake / severe issue
// neutral → foreground     — informational only
// ─────────────────────────────────────────────────────────────────────

const statusColors = {
  good:    "text-[#2FE0DA]",
  warning: "text-[#F97316]",
  bad:     "text-[#EF4444]",
  neutral: "text-foreground",
};

const statusDotColors = {
  good:    "bg-[#2FE0DA]",
  warning: "bg-[#F97316]",
  bad:     "bg-[#EF4444]",
  neutral: "bg-muted-foreground",
};

export function MetricCard({ label, value, status = "neutral", detail, icon, index = 0, reference }: MetricCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.04, ease: [0.4, 0, 0.2, 1] }}
      whileHover={{ y: -2, transition: { duration: 0.2 } }}
      className="liquid-card flex flex-col gap-2 p-4"
    >
      <div className="flex items-center justify-between">
        {/* Label — JetBrains Mono 10px, uppercase, tracking 0.15em, visible */}
        <span className="text-[10px] font-mono text-muted-foreground/80 uppercase tracking-[0.15em]">
          {label}
          {reference && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="ml-1 cursor-help text-muted-foreground/50 hover:text-muted-foreground/80">ⓘ</span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs text-[11px] font-mono leading-relaxed">
                {reference}
              </TooltipContent>
            </Tooltip>
          )}
        </span>
        <div className="flex items-center gap-2">
          {icon}
          <div className={`h-2 w-2 rounded-full ${statusDotColors[status]}`} />
        </div>
      </div>

      {/* Value — Space Grotesk 16px semibold, tight line-height */}
      <span className={`font-heading text-base font-semibold leading-tight ${statusColors[status]}`}>
        {value}
      </span>

      {detail && (
        <span className="text-[11px] font-mono text-muted-foreground/70">
          {detail}
        </span>
      )}
    </motion.div>
  );
}
