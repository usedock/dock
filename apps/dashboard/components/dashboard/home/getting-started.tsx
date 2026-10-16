import Link from 'next/link';
import { Check, Circle } from 'lucide-react';
import type { ChecklistItem } from '@/lib/home-summary';
import { HomeSection, ROW_GROUP } from './section';

export function GettingStarted({ items }: { items: ChecklistItem[] }) {
  return (
    <HomeSection title="Getting started" hint="Set up this workspace.">
      <ul className={ROW_GROUP}>
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            {item.done ? (
              <Check className="size-4 text-muted-foreground" aria-hidden="true" />
            ) : (
              <Circle className="size-4 text-muted-foreground" aria-hidden="true" />
            )}
            {item.done ? (
              <span className="text-muted-foreground">
                <span className="sr-only">Done: </span>
                {item.label}
              </span>
            ) : (
              <Link href={item.href} className="font-medium underline-offset-4 hover:underline">
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </HomeSection>
  );
}
