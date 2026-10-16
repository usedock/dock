import type { ReactNode } from 'react';

export function HomeSection({
  title,
  hint,
  link,
  children,
}: {
  title: string;
  hint: string;
  link?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1 basis-40">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">{hint}</p>
        </div>
        {link}
      </div>
      {children}
    </section>
  );
}

export const ROW_GROUP = 'divide-y overflow-hidden rounded-lg border';
export const ROW_LINK = 'flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-muted';
