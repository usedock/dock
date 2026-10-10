'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * CLI/curl snippet block matching the marketing quickstart code block
 * (stone-900 ground, mono text) so the dashboard's "do it from the terminal"
 * callouts read as the same product. One copy button copies every line.
 */
export function CodeBlock({ lines, className }: { lines: string | string[]; className?: string }) {
  const rows = Array.isArray(lines) ? lines : [lines];
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(rows.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the text stays visible to select manually.
    }
  }

  return (
    <div className={cn('relative rounded-md bg-[#1c1917]', className)}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={copied ? 'Copied' : 'Copy'}
        onClick={copy}
        className="absolute top-2 right-2 text-white/50 hover:bg-white/10 hover:text-white"
      >
        {copied ? <Check /> : <Copy />}
      </Button>
      <pre className="overflow-x-auto p-3 pr-10 font-mono text-xs text-white/85">
        {rows.map((row, i) => (
          <div key={i} className={row.startsWith('#') ? 'text-white/40' : undefined}>
            {row}
          </div>
        ))}
      </pre>
    </div>
  );
}
