import { cn } from '@/lib/utils';

// Dock mark and wordmark, matching the Dock website logo.
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true">
        <rect x="2" y="13" width="20" height="8" rx="2" fill="currentColor" />
        <rect x="2" y="3" width="12" height="8" rx="2" fill="#c2410c" />
      </svg>
      <span className="text-xl font-semibold tracking-[-0.04em]">dock</span>
    </span>
  );
}
