'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getDefaultApi } from '@/lib/dock-api';
import { formatDate, messageOf } from '@/lib/format';
import { useOrg } from '@/components/dashboard/org-context';
import { useInstanceConfig } from '@/lib/use-instance-config';
import { EmptyNote, ErrorNote, LoadingRows, PageHeader } from '@/components/dashboard/data-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface PlanRow {
  plan?: string;
  version?: number;
  baseFeeCents?: number;
  isCurrent?: boolean;
}

interface InvoiceRow {
  id: string;
  status?: string;
  totalCents?: number;
  periodStart?: string;
  periodEnd?: string;
}

interface UsageLineRow {
  unit: string;
  detail: string;
  amountCents: number;
}

interface UsageView {
  periodStart?: string;
  periodEnd?: string;
  currency: string;
  includedCents: number;
  usedCents: number;
  remainingCents: number;
  overageCents: number;
  liveCostCents: number;
  budgetCents: number | null;
  budgetExhausted: boolean;
  lines: UsageLineRow[];
}

interface SubscriptionView {
  plan: string;
  status: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  pendingPlan?: string | null;
}

function asSubscriptionView(data: unknown): SubscriptionView {
  if (!data || typeof data !== 'object') return { plan: '—', status: '—' };
  const record = data as Record<string, unknown>;
  const sub =
    record.subscription && typeof record.subscription === 'object'
      ? (record.subscription as Record<string, unknown>)
      : record;
  const planTerms =
    record.plan && typeof record.plan === 'object' ? (record.plan as Record<string, unknown>) : null;
  const plan =
    typeof sub.plan === 'string'
      ? sub.plan
      : typeof planTerms?.plan === 'string'
        ? planTerms.plan
        : '—';
  const status = typeof sub.status === 'string' ? sub.status : '—';
  const currentPeriodEnd =
    typeof sub.currentPeriodEnd === 'string'
      ? sub.currentPeriodEnd
      : sub.currentPeriodEnd instanceof Date
        ? sub.currentPeriodEnd.toISOString()
        : undefined;
  return {
    plan,
    status,
    currentPeriodEnd,
    cancelAtPeriodEnd: typeof sub.cancelAtPeriodEnd === 'boolean' ? sub.cancelAtPeriodEnd : undefined,
    pendingPlan: typeof sub.pendingPlan === 'string' ? sub.pendingPlan : sub.pendingPlan === null ? null : undefined,
  };
}

function formatUsdCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

function asUsageView(data: unknown): UsageView {
  if (!data || typeof data !== 'object') {
    return {
      currency: 'USD',
      includedCents: 0,
      usedCents: 0,
      remainingCents: 0,
      overageCents: 0,
      liveCostCents: 0,
      budgetCents: null,
      budgetExhausted: false,
      lines: [],
    };
  }
  const record = data as Record<string, unknown>;
  const asIso = (value: unknown) =>
    typeof value === 'string' ? value : value instanceof Date ? value.toISOString() : undefined;
  const asNum = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const lines = Array.isArray(record.lines)
    ? record.lines
        .filter((row) => row && typeof row === 'object')
        .map((row) => {
          const line = row as Record<string, unknown>;
          return {
            unit: typeof line.unit === 'string' ? line.unit : 'other',
            detail: typeof line.detail === 'string' ? line.detail : '—',
            amountCents: asNum(line.amountCents),
          };
        })
    : [];
  return {
    periodStart: asIso(record.periodStart),
    periodEnd: asIso(record.periodEnd),
    currency: typeof record.currency === 'string' ? record.currency : 'USD',
    includedCents: asNum(record.includedCents),
    usedCents: asNum(record.usedCents),
    remainingCents: asNum(record.remainingCents),
    overageCents: asNum(record.overageCents),
    liveCostCents: asNum(record.liveCostCents),
    budgetCents: typeof record.budgetCents === 'number' ? record.budgetCents : null,
    budgetExhausted: record.budgetExhausted === true,
    lines,
  };
}

const TABS = ['subscription', 'usage', 'budget', 'invoices'] as const;

/** Billing: plans and subscription, usage, budget, invoices. */
function BillingBody() {
  const router = useRouter();
  const params = useSearchParams();
  const { selectedOrgId } = useOrg();
  const [api] = useState(getDefaultApi);
  const billingOff = useInstanceConfig()?.billingEnabled === false;

  const tab = params.get('tab') ?? 'subscription';
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionView | null>(null);
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [budget, setBudget] = useState<Record<string, unknown> | null>(null);
  const [budgetError, setBudgetError] = useState(false);
  const [invoices, setInvoices] = useState<InvoiceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [planChoice, setPlanChoice] = useState('');
  const currentFee = (plans ?? []).find((p) => p.plan === subscription?.plan)?.baseFeeCents ?? 0;
  // Upgrades return 402 until Checkout exists.
  const needsPayment = (p: PlanRow) => (p.baseFeeCents ?? 0) > currentFee;
  const [budgetInput, setBudgetInput] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);

  const setTab = useCallback(
    (value: string) => {
      const next = new URLSearchParams(params.toString());
      next.set('tab', value);
      router.replace(`/billing?${next.toString()}`);
    },
    [params, router],
  );

  // Scope gates in render cover the unselected case; no sync resets needed.
  const refresh = useCallback(() => {
    if (billingOff) return;
    api
      .listPlans()
      .then((rows) => setPlans(rows as PlanRow[]))
      .catch(() => setPlans([]));
    if (!selectedOrgId) return;
    api
      .getSubscription(selectedOrgId)
      .then((s) => {
        setSubscription(asSubscriptionView(s));
        setError(null);
      })
      .catch((e: unknown) => setError(messageOf(e, 'Could not load billing.')));
    api.getUsage(selectedOrgId).then((u) => setUsage(asUsageView(u))).catch(() => setUsage(null));
    api
      .getBudget(selectedOrgId)
      .then((b) => {
        setBudget(b as Record<string, unknown>);
        setBudgetError(false);
      })
      .catch(() => setBudgetError(true));
    api
      .listInvoices(selectedOrgId)
      .then((rows) => setInvoices(rows as InvoiceRow[]))
      .catch(() => setInvoices([]));
  }, [api, selectedOrgId, billingOff]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function runAction(fn: () => Promise<unknown>, failure: string) {
    setActionError(null);
    try {
      await fn();
      refresh();
    } catch (e: unknown) {
      setActionError(`${failure}: ${messageOf(e, 'request failed')}`);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Billing" description="Plans, current spend, budgets, and invoices for the organization." />
      {actionError ? <ErrorNote message={actionError} /> : null}
      {billingOff ? (
        <EmptyNote
          title="Billing is not available on this instance."
          hint="No plans, limits, or invoices apply."
        />
      ) : !selectedOrgId ? (
        <EmptyNote title="Pick an organization." hint="Billing is scoped to an organization." />
      ) : error ? (
        <ErrorNote message={error} onRetry={refresh} />
      ) : (
        <Tabs value={TABS.includes(tab as (typeof TABS)[number]) ? tab : 'subscription'} onValueChange={setTab}>
          <TabsList aria-label="Billing sections">
            <TabsTrigger value="subscription">Subscription</TabsTrigger>
            <TabsTrigger value="usage">Usage</TabsTrigger>
            <TabsTrigger value="budget">Budget</TabsTrigger>
            <TabsTrigger value="invoices">Invoices</TabsTrigger>
          </TabsList>

          <TabsContent value="subscription" className="flex flex-col gap-3">
            {subscription === null ? (
              <LoadingRows rows={2} />
            ) : (
              <dl className="grid grid-cols-2 gap-4 rounded-md border p-4 sm:grid-cols-3">
                <div className="flex flex-col gap-1">
                  <dt className="text-xs text-muted-foreground">Plan</dt>
                  <dd className="text-sm font-medium capitalize">{subscription.plan}</dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-xs text-muted-foreground">Status</dt>
                  <dd>
                    <Badge variant="secondary">{subscription.status}</Badge>
                  </dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-xs text-muted-foreground">Period ends</dt>
                  <dd className="text-sm">{formatDate(subscription.currentPeriodEnd)}</dd>
                </div>
              </dl>
            )}
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="plan-choice">Change plan</Label>
                <Select value={planChoice} onValueChange={(v) => setPlanChoice(v ?? '')}>
                  <SelectTrigger id="plan-choice" className="w-48">
                    <SelectValue placeholder="Select plan" />
                  </SelectTrigger>
                  <SelectContent>
                    {(plans ?? []).map((p, i) => (
                      <SelectItem key={`${p.plan}-${i}`} value={p.plan ?? ''} disabled={needsPayment(p)}>
                        {p.plan ?? 'unknown'}
                        {needsPayment(p) ? ' (Requires payment)' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={!planChoice || !selectedOrgId}
                onClick={() =>
                  selectedOrgId && runAction(() => api.changePlan(selectedOrgId, planChoice), 'Could not change plan')
                }
              >
                Change plan
              </Button>
              <Button type="button" variant="ghost" onClick={() => setConfirmCancel(true)}>
                Cancel subscription…
              </Button>
            </div>
            {(plans ?? []).some(needsPayment) ? (
              <p className="text-xs text-muted-foreground">
                Plans marked &ldquo;Requires payment&rdquo; cost more than your current plan and need a confirmed payment, which is not available yet.
              </p>
            ) : null}
          </TabsContent>

          <TabsContent value="usage" className="flex flex-col gap-4">
            {usage === null ? (
              <LoadingRows rows={3} />
            ) : (
              <>
                <dl className="grid grid-cols-2 gap-4 rounded-md border p-4 sm:grid-cols-3 lg:grid-cols-4">
                  <div className="flex flex-col gap-1">
                    <dt className="text-xs text-muted-foreground">Period</dt>
                    <dd className="text-sm">
                      {formatDate(usage.periodStart)} → {formatDate(usage.periodEnd)}
                    </dd>
                  </div>
                  <div className="flex flex-col gap-1">
                    <dt className="text-xs text-muted-foreground">Included</dt>
                    <dd className="font-mono text-sm">{formatUsdCents(usage.includedCents)}</dd>
                  </div>
                  <div className="flex flex-col gap-1">
                    <dt className="text-xs text-muted-foreground">Used</dt>
                    <dd className="font-mono text-sm">{formatUsdCents(usage.usedCents)}</dd>
                  </div>
                  <div className="flex flex-col gap-1">
                    <dt className="text-xs text-muted-foreground">Remaining</dt>
                    <dd className="font-mono text-sm">{formatUsdCents(usage.remainingCents)}</dd>
                  </div>
                  <div className="flex flex-col gap-1">
                    <dt className="text-xs text-muted-foreground">Overage</dt>
                    <dd className="font-mono text-sm">{formatUsdCents(usage.overageCents)}</dd>
                  </div>
                  <div className="flex flex-col gap-1">
                    <dt className="text-xs text-muted-foreground">Live cost</dt>
                    <dd className="font-mono text-sm">{formatUsdCents(usage.liveCostCents)}</dd>
                  </div>
                  <div className="flex flex-col gap-1">
                    <dt className="text-xs text-muted-foreground">Budget</dt>
                    <dd className="font-mono text-sm">{formatUsdCents(usage.budgetCents)}</dd>
                  </div>
                  <div className="flex flex-col gap-1">
                    <dt className="text-xs text-muted-foreground">Budget status</dt>
                    <dd>
                      <Badge variant={usage.budgetExhausted ? 'destructive' : 'secondary'}>
                        {usage.budgetExhausted ? 'Exhausted' : 'Within budget'}
                      </Badge>
                    </dd>
                  </div>
                </dl>
                {usage.lines.length === 0 ? (
                  <EmptyNote
                    title="No usage yet."
                    hint="Compute, storage, and seat charges appear here during the billing period."
                  />
                ) : (
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Unit</TableHead>
                          <TableHead>Detail</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {usage.lines.map((line, index) => (
                          <TableRow key={`${line.unit}-${index}`}>
                            <TableCell>
                              <Badge variant="secondary" className="capitalize">{line.unit}</Badge>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">{line.detail}</TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {formatUsdCents(line.amountCents)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            )}
          </TabsContent>

          <TabsContent value="budget" className="flex flex-col gap-3">
            {budgetError ? (
              <ErrorNote message="Could not load the budget." onRetry={refresh} />
            ) : budget === null ? (
              <LoadingRows rows={2} />
            ) : (
              <dl className="grid grid-cols-1 gap-4 rounded-md border p-4">
                <div className="flex flex-col gap-1">
                  <dt className="text-xs text-muted-foreground">Monthly limit</dt>
                  <dd className="font-mono text-sm">{typeof budget.amountCents === 'number' ? formatUsdCents(budget.amountCents) : 'No cap'}</dd>
                </div>
              </dl>
            )}
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="budget-amount">Monthly limit (cents)</Label>
                <Input
                  id="budget-amount"
                  inputMode="numeric"
                  maxLength={10}
                  value={budgetInput}
                  onChange={(e) => setBudgetInput(e.target.value)}
                  placeholder="5000"
                  className="w-48"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={!selectedOrgId || !/^[1-9]\d*$/.test(budgetInput.trim()) || Number(budgetInput.trim()) > 2147483647}
                onClick={() =>
                  selectedOrgId &&
                  runAction(() => api.putBudget(selectedOrgId, Number(budgetInput.trim())), 'Could not save budget')
                }
              >
                Save budget
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!selectedOrgId || budget === null || budget.amountCents == null}
                onClick={() => selectedOrgId && runAction(() => api.putBudget(selectedOrgId, null), 'Could not remove cap')}
              >
                Remove cap
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="invoices">
            {invoices === null ? (
              <LoadingRows rows={3} />
            ) : invoices.length === 0 ? (
              <EmptyNote title="No invoices yet." />
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>ID</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Total</TableHead>
                      <TableHead>Period</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoices.map((inv) => (
                      <TableRow key={inv.id}>
                        <TableCell className="font-mono text-xs">{inv.id.slice(0, 8)}</TableCell>
                        <TableCell>
                          <Badge variant="secondary">{inv.status ?? '—'}</Badge>
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {inv.totalCents !== undefined ? `$${(inv.totalCents / 100).toFixed(2)}` : '—'}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {formatDate(inv.periodStart)} → {formatDate(inv.periodEnd)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}

      <Dialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel subscription?</DialogTitle>
            <DialogDescription>Compute stops at the end of the billing period. Snapshots are kept per retention.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmCancel(false)}>
              Keep subscription
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirmCancel(false);
                if (selectedOrgId) runAction(() => api.cancelSubscription(selectedOrgId), 'Could not cancel subscription');
              }}
            >
              Cancel subscription
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function BillingPage() {
  return (
    <Suspense>
      <BillingBody />
    </Suspense>
  );
}
