'use client';

import { useEffect, useState } from 'react';
import { getDefaultApi, type InstanceConfig } from './dock-api';

let pending: Promise<InstanceConfig> | null = null;

function loadInstanceConfig(): Promise<InstanceConfig> {
  pending ??= getDefaultApi()
    .getInstanceConfig()
    .catch((e: unknown) => {
      // Drop the failed promise so the next mount retries.
      pending = null;
      throw e;
    });
  return pending;
}

/** Instance facts plus whether the last fetch failed, so callers can show an error instead of loading forever. */
export function useInstanceConfigState(): { config: InstanceConfig | null; failed: boolean } {
  const [state, setState] = useState<{ config: InstanceConfig | null; failed: boolean }>({ config: null, failed: false });
  useEffect(() => {
    let live = true;
    loadInstanceConfig().then(
      (config) => live && setState({ config, failed: false }),
      () => live && setState({ config: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, []);
  return state;
}

/** Instance facts fetched once per page load; null until known or when the API is unreachable. */
export function useInstanceConfig(): InstanceConfig | null {
  return useInstanceConfigState().config;
}

/** Hides billing destinations only once the API reports billing off. */
export function withoutBillingWhenDisabled<T extends { href: string }>(items: T[], config: InstanceConfig | null): T[] {
  return config?.billingEnabled === false ? items.filter((item) => item.href !== '/billing') : items;
}
