import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Settings card: titled header, body, and an optional footer carrying a hint and the section's primary action. */
export function SettingsSection({
  title,
  description,
  headerAction,
  footer,
  footerHint,
  danger = false,
  flush = false,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  headerAction?: ReactNode;
  footer?: ReactNode;
  footerHint?: ReactNode;
  danger?: boolean;
  /** Body without padding, for lists and tables that draw their own rows. */
  flush?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className={cn('rounded-md border', danger && 'border-destructive/40')}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3">
        <div className="flex max-w-2xl flex-col gap-1">
          <h2 className={cn('text-sm font-medium', danger && 'text-destructive')}>{title}</h2>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {headerAction}
      </div>
      {children ? <div className={cn(flush ? 'border-t' : 'px-5 pb-5')}>{children}</div> : null}
      {footer || footerHint ? (
        <div
          className={cn(
            'flex flex-wrap items-center justify-between gap-3 border-t bg-muted/40 px-5 py-3',
            danger && 'border-destructive/40',
          )}
        >
          <div className="text-xs text-muted-foreground">{footerHint}</div>
          {footer}
        </div>
      ) : null}
    </section>
  );
}
