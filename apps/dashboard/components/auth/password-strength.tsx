'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export type PasswordScore = 0 | 1 | 2 | 3 | 4;

const LABELS: Record<Exclude<PasswordScore, 0>, string> = {
  1: 'Too weak',
  2: 'Weak',
  3: 'Good',
  4: 'Strong',
};

// Deterministic local estimate. Length carries the score past the 12-char
// minimum; variety pushes Good to Strong. Common stems cap at Weak.
export function getPasswordStrength(password: string): PasswordScore {
  if (password.length === 0) return 0;
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);
  let points = 0;
  if (password.length >= 12) points += 1;
  if (password.length >= 16) points += 1;
  if (hasLower && hasUpper) points += 1;
  if (hasDigit) points += 1;
  if (hasSymbol) points += 1;
  let score = (points <= 2 ? 1 : points === 3 ? 2 : points === 4 ? 3 : 4) as PasswordScore;
  if (password.length < 12) score = 1;
  if (/^(?:password|123456|qwerty|letmein|welcome|abc123|admin|dock)/i.test(password)) score = 1;
  if (/(.)\1{3,}/.test(password) && score > 1) score = ((score - 1) as PasswordScore);
  return score;
}

function rules(password: string) {
  return [
    { id: 'length', label: '12+ characters', met: password.length >= 12 },
    { id: 'case', label: 'Upper + lower case', met: /[a-z]/.test(password) && /[A-Z]/.test(password) },
    { id: 'digit', label: 'A number', met: /\d/.test(password) },
    { id: 'symbol', label: 'A symbol', met: /[^A-Za-z0-9]/.test(password) },
  ];
}

// Live meter for the signup password field. Single-hue fill keeps the signal
// color rare; the mono label carries severity.
export function PasswordStrength({ password, id = 'signup-password-strength' }: { password: string; id?: string }) {
  const reduce = useReducedMotion();
  const score = getPasswordStrength(password);
  const items = rules(password);

  const segments = (
    <div aria-hidden="true" className="flex gap-1.5">
      {[1, 2, 3, 4].map((i) => {
        const active = i <= score;
        if (reduce) {
          return <span key={i} className={cn('h-1 flex-1 rounded-md', active ? 'bg-primary' : 'bg-muted')} />;
        }
        return (
          <span key={i} className="h-1 flex-1 rounded-md bg-muted">
            <motion.span
              className="block h-full w-full origin-left rounded-md bg-primary"
              initial={false}
              animate={{ scaleX: active ? 1 : 0, opacity: active ? 1 : 0 }}
              transition={{ duration: 0.25, ease: 'easeOut', delay: active ? (i - 1) * 0.04 : 0 }}
            />
          </span>
        );
      })}
    </div>
  );

  const label = score === 0 ? '' : LABELS[score as Exclude<PasswordScore, 0>];
  const labelRow = (
    <div className="flex items-baseline justify-between gap-3">
      {reduce ? (
        <p role="status" aria-live="polite" className={cn('min-h-4 font-mono text-[11px] tracking-[0.12em] uppercase', score <= 1 ? 'text-destructive' : score === 2 ? 'text-muted-foreground' : 'text-primary')}>
          {label}
        </p>
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={label}
            role="status"
            aria-live="polite"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className={cn('min-h-4 font-mono text-[11px] tracking-[0.12em] uppercase', score <= 1 ? 'text-destructive' : score === 2 ? 'text-muted-foreground' : 'text-primary')}
          >
            {label}
          </motion.p>
        </AnimatePresence>
      )}
      <span aria-hidden="true" className="font-mono text-[11px] text-muted-foreground tabular-nums">
        {score}/4
      </span>
    </div>
  );

  const checklist = (
    <ul className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5">
      {items.map((rule, index) => (
        <li key={rule.id} className={cn('flex items-center gap-1.5 text-xs transition-colors', rule.met ? 'text-foreground' : 'text-muted-foreground')}>
          {reduce ? (
            <Check aria-hidden="true" className={cn('size-3.5 shrink-0', rule.met ? 'text-primary' : 'opacity-40')} strokeWidth={2} />
          ) : (
            <motion.span
              key={String(rule.met)}
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.2, ease: 'easeOut', delay: index * 0.03 }}
              className="inline-flex shrink-0"
            >
              <Check aria-hidden="true" className={cn('size-3.5', rule.met ? 'text-primary' : 'opacity-40')} strokeWidth={2} />
            </motion.span>
          )}
          {rule.label}
        </li>
      ))}
    </ul>
  );

  // Always rendered (neutral when empty) so the form below never shifts.
  return (
    <div id={id} className="flex flex-col gap-1.5 pt-1 pb-0.5">
      {segments}
      {labelRow}
      {checklist}
    </div>
  );
}
