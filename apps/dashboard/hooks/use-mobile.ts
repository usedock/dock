import * as React from "react"

const MOBILE_BREAKPOINT = 768

function subscribe(callback: () => void) {
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
  mql.addEventListener("change", callback)
  return () => mql.removeEventListener("change", callback)
}

function getSnapshot() {
  return window.innerWidth < MOBILE_BREAKPOINT
}

export function useIsMobile() {
  // External media-query state belongs in the store, not in an effect,
  // so server snapshots stay false and updates subscribe to changes.
  return React.useSyncExternalStore(subscribe, getSnapshot, () => false)
}
