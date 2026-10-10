'use client';

import { motion, useReducedMotion } from 'motion/react';

// Single restrained entrance for auth forms. Collapses to nothing when the
// visitor prefers reduced motion.
export function AuthEntrance({ children }: { children: React.ReactNode }) {
  const reduce = useReducedMotion();
  if (reduce) return <>{children}</>;
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  );
}
