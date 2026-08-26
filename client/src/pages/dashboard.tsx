/**
 * Management Dashboard (beta).
 *
 * Per-clinic performance broken down by status, service type, insurance and
 * referral origin. Four cross-tabs, all from ONE endpoint call.
 *
 * TWO RULES THIS PAGE EXISTS TO HOLD
 * ----------------------------------
 * 1. NOTHING IS SILENTLY DROPPED. Every cross-tab renders its own "Other /
 *    Unmapped" and "Unknown" columns, so each row's cells always sum to the row
 *    total shown beside them. 37 of 212 active contacts hold legacy insurance
 *    spellings that match none of the 16 canonical payers; a table that quietly
 *    omitted them would understate every clinic.
 * 2. NO LOCATION IS HARDCODED. `locations` arrives from the server and this file
 *    renders whatever it receives. A fourth clinic is a server-side edit only.
 *
 * Gating here is COSMETIC — GET /api/dashboard/summary enforces the real
 * boundary (requireDashboard). The <Redirect> just avoids showing an empty page.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Redirect } from "wouter";
import { PageLayout } from "@/components/layout/page-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Badge } from "@/components/ui/badge";
import { PageLoader } from "@/components/ui/page-loader";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ChartContainer, ChartTooltip, ChartLegend, ChartLegendContent,
} from "@/components/ui/chart";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";
import { AlertCircle, BarChart3, TableIcon } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { canAccessDashboard } from "@shared/access-control";
import {
  buildServiceTypeChart, buildInsuranceChart, buildOriginChart,
  insuranceChartHeight, type ChartSeries, type StackRow,
} from "@/lib/dashboard-charts";
import {
  getDashboardSummary,
  type DashboardSummary,
  type CrossTabRow,
  type Population,
} from "@/lib/dashboard-api";

/** Renders 0 rather than a blank cell — an empty cell reads as "no data". */
const n = (v: number) => <span className={v === 0 ? "text-muted-foreground" : ""}>{v}</span>;

function LocationLabel({
  summary, id,
}: { summary: DashboardSummary; id: string }) {
  const loc = summary.locations.find((l) => l.id === id);
  if (!loc) return <>{id}</>;
  return (
    <span className="flex items-center gap-1.5">
      {loc.label}
      {loc.locationAgnostic && (
        <Badge variant="outline" className="text-[10px] font-normal px-1 py-0">
          no office
        </Badge>
      )}
    </span>
  );
}

// ============================================================================
// Shared chart + view-toggle layer
//
// Table and graph toggle INDEPENDENTLY and may both be on — the client asked
// for that explicitly. Neither-on is a legal (empty) state, not an error.
// Default is both, so a first-time viewer opens the page fully populated with
// no configuration. State is per-card and NOT persisted; it resets on reload,
// which is expected — persistence is the next build.
// ============================================================================

type CardView = "table" | "chart";
const DEFAULT_VIEWS: CardView[] = ["table", "chart"];

function useCardViews() {
  const [views, setViews] = useState<CardView[]>(DEFAULT_VIEWS);
  return {
    views,
    showTable: views.includes("table"),
    showChart: views.includes("chart"),
    onChange: (v: string[]) => setViews(v as CardView[]),
  };
}

function ViewToggle({ views, onChange }: {
  views: CardView[]; onChange: (v: string[]) => void;
}) {
  return (
    <ToggleGroup type="multiple" value={views} onValueChange={onChange} size="sm">
      <ToggleGroupItem value="table" aria-label="Show table">
        <TableIcon className="h-4 w-4" />
      </ToggleGroupItem>
      <ToggleGroupItem value="chart" aria-label="Show graph">
        <BarChart3 className="h-4 w-4" />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

function NoViews() {
  return (
    <p className="text-sm text-muted-foreground text-center py-8">
      Both views are hidden. Use the toggle above to show the table, the graph, or both.
    </p>
  );
}

/**
 * Tooltip for a stacked row: every segment with a non-zero count, plus the row
 * total so it can be checked against the table beside it at a glance.
 *
 * Renders ONLY series labels supplied by the caller — all of which are canonical
 * constants or location names. No stored field value reaches this component.
 * insurance_payer is free text and has held a patient name and DOB in
 * production; a tooltip on this exact card leaked it in v189.
 */
function StackTooltip({ active, payload, series }: {
  active?: boolean;
  payload?: Array<{ payload?: StackRow }>;
  series: ChartSeries[];
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const parts = series
    .map((s) => ({ ...s, value: Number(row[s.key] ?? 0) }))
    .filter((s) => s.value > 0);
  return (
    <div className="rounded-lg border bg-background px-3 py-2 text-sm shadow-md min-w-[180px]">
      <div className="font-medium mb-1">{row.full}</div>
      {parts.length === 0 ? (
        <div className="text-muted-foreground text-xs">No records</div>
      ) : parts.map((s) => (
        <div key={s.key} className="flex items-center justify-between gap-4 text-xs py-0.5">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span className="h-2 w-2 rounded-[2px] shrink-0" style={{ background: s.color }} />
            {s.label}
          </span>
          <span className="font-medium tabular-nums">{s.value}</span>
        </div>
      ))}
      <div className="flex items-center justify-between gap-4 text-xs pt-1 mt-1 border-t font-medium">
        <span>Total</span><span className="tabular-nums">{row.__total}</span>
      </div>
    </div>
  );
}

/**
 * Horizontal stacked bars — the shape Card 1 established, extended to multiple
 * series.
 *
 * STACKED, not grouped, on every multi-series card. The page's core promise is
 * that a chart agrees with the table beside it, and only a stack makes a row's
 * segments visibly sum to that row's total. Grouped bars compare series to each
 * other but show no total, so the reconciliation the whole dashboard is built
 * around would become invisible exactly where it is easiest to doubt.
 */
function StackedBars({ rows, series, height, yAxisWidth }: {
  rows: StackRow[]; series: ChartSeries[]; height: number; yAxisWidth: number;
}) {
  const config = Object.fromEntries(
    series.map((s) => [s.key, { label: s.label, color: s.color }]),
  );
  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
      <BarChart data={rows} layout="vertical"
        margin={{ left: 4, right: 28, top: 4, bottom: 4 }}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" allowDecimals={false} />
        <YAxis type="category" dataKey="name" width={yAxisWidth}
          tickLine={false} axisLine={false} interval={0} />
        <ChartTooltip cursor={{ fillOpacity: 0.1 }}
          content={<StackTooltip series={series} />} />
        <ChartLegend content={<ChartLegendContent />} />
        {series.map((s) => (
          <Bar key={s.key} dataKey={s.key} stackId="stack" fill={s.color} />
        ))}
      </BarChart>
    </ChartContainer>
  );
}

/** Card 1 — Location × Status. The only card with a chart toggle tonight. */
function StatusCard({ summary }: { summary: DashboardSummary }) {
  const { views, showTable, showChart, onChange } = useCardViews();
  const { rows, totals, buckets, labels } = summary.byStatus;

  const chartData = summary.locations.map((loc) => {
    const r = rows.find((x) => x.location === loc.id);
    return { name: loc.label, pipeline: r?.pipeline ?? 0 };
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base font-medium">Location &times; Status</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Pipeline = Waitlist + Pending + Scheduled. Other Active is counted separately
            so Pipeline + Other Active = Active.
          </p>
        </div>
        <ViewToggle views={views} onChange={onChange} />
      </CardHeader>
      <CardContent className="space-y-6">
        {!showTable && !showChart && <NoViews />}
        {showChart && (
          <ChartContainer
            config={{ pipeline: { label: "Pipeline", color: "hsl(var(--chart-1))" } }}
            className="h-[260px] w-full"
          >
            <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 24 }}>
              <CartesianGrid horizontal={false} />
              <XAxis type="number" allowDecimals={false} />
              <YAxis type="category" dataKey="name" width={110} tickLine={false} axisLine={false} />
              <ChartTooltip
                cursor={{ fillOpacity: 0.1 }}
                content={({ active, payload, label }) =>
                  active && payload?.length ? (
                    <div className="rounded-lg border bg-background px-3 py-2 text-sm shadow-md">
                      <div className="font-medium">{label}</div>
                      <div className="text-muted-foreground">
                        Pipeline: <span className="font-medium text-foreground">{payload[0].value}</span>
                      </div>
                    </div>
                  ) : null
                }
              />
              <Bar dataKey="pipeline" fill="var(--color-pipeline)" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ChartContainer>
        )}
        {showTable && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Location</TableHead>
                  {buckets.map((b) => (
                    <TableHead key={b} className="text-right">{labels[b] ?? b}</TableHead>
                  ))}
                  <TableHead className="text-right font-semibold">Pipeline</TableHead>
                  <TableHead className="text-right font-semibold">Active</TableHead>
                  {summary.population === "all" && (
                    <>
                      <TableHead className="text-right">Inactive</TableHead>
                      <TableHead className="text-right font-semibold">Total</TableHead>
                    </>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.locations.map((loc) => {
                  const r = rows.find((x) => x.location === loc.id);
                  if (!r) return null;
                  return (
                    <TableRow key={loc.id}>
                      <TableCell className="font-medium">
                        <LocationLabel summary={summary} id={loc.id} />
                      </TableCell>
                      {buckets.map((b) => (
                        <TableCell key={b} className="text-right tabular-nums">
                          {n(r[b as keyof typeof r] as number)}
                        </TableCell>
                      ))}
                      <TableCell className="text-right tabular-nums font-semibold">{n(r.pipeline)}</TableCell>
                      <TableCell className="text-right tabular-nums font-semibold">{n(r.active)}</TableCell>
                      {summary.population === "all" && (
                        <>
                          <TableCell className="text-right tabular-nums">{n(r.inactive)}</TableCell>
                          <TableCell className="text-right tabular-nums font-semibold">{n(r.total)}</TableCell>
                        </>
                      )}
                    </TableRow>
                  );
                })}
                <TableRow className="border-t-2 font-semibold bg-muted/40">
                  <TableCell>All locations</TableCell>
                  {buckets.map((b) => (
                    <TableCell key={b} className="text-right tabular-nums">
                      {totals[b as keyof typeof totals] as number}
                    </TableCell>
                  ))}
                  <TableCell className="text-right tabular-nums">{totals.pipeline}</TableCell>
                  <TableCell className="text-right tabular-nums">{totals.active}</TableCell>
                  {summary.population === "all" && (
                    <>
                      <TableCell className="text-right tabular-nums">{totals.inactive}</TableCell>
                      <TableCell className="text-right tabular-nums">{totals.total}</TableCell>
                    </>
                  )}
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Cards 2 and 3 — generic cross-tab renderer.
 *
 * `otherTooltip` powers the insurance card's "Other / Unmapped" explanation.
 * The Other and Unknown columns are NOT optional: they are what makes each row
 * reconcile to its own total.
 */
function CrossTabCard({
  summary, title, subtitle, columns, labels, rows, totals, otherLabel, otherNote, chart,
}: {
  summary: DashboardSummary;
  title: string;
  subtitle: string;
  columns: string[];
  labels?: Record<string, string>;
  rows: CrossTabRow[];
  totals: CrossTabRow;
  otherLabel: string;
  otherNote?: string;
  /** Rendered above the table when the graph view is on. */
  chart?: React.ReactNode;
}) {
  const { views, showTable, showChart, onChange } = useCardViews();
  const showUnknown = totals.unknown > 0;
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-4">
        <div>
          <CardTitle className="text-base font-medium">{title}</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
        </div>
        <ViewToggle views={views} onChange={onChange} />
      </CardHeader>
      <CardContent className="space-y-6">
        {!showTable && !showChart && <NoViews />}
        {showChart && chart}
        {showTable && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-background">Location</TableHead>
                {columns.map((c) => (
                  <TableHead key={c} className="text-right whitespace-nowrap">
                    {labels?.[c] ?? c}
                  </TableHead>
                ))}
                <TableHead className="text-right whitespace-nowrap">
                  {otherNote ? (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger className="underline decoration-dotted underline-offset-4">
                          {otherLabel}
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <p className="text-xs">{otherNote}</p>
                          <p className="text-xs mt-2 text-muted-foreground">
                            Not remapped — cleaning these is a TFC data decision.
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : otherLabel}
                </TableHead>
                {showUnknown && <TableHead className="text-right">Unknown</TableHead>}
                <TableHead className="text-right font-semibold">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.locations.map((loc) => {
                const r = rows.find((x) => x.location === loc.id);
                if (!r) return null;
                return (
                  <TableRow key={loc.id}>
                    <TableCell className="font-medium sticky left-0 bg-background">
                      <LocationLabel summary={summary} id={loc.id} />
                    </TableCell>
                    {columns.map((c) => (
                      <TableCell key={c} className="text-right tabular-nums">{n(r.counts[c] ?? 0)}</TableCell>
                    ))}
                    <TableCell className="text-right tabular-nums">{n(r.other)}</TableCell>
                    {showUnknown && <TableCell className="text-right tabular-nums">{n(r.unknown)}</TableCell>}
                    <TableCell className="text-right tabular-nums font-semibold">{n(r.total)}</TableCell>
                  </TableRow>
                );
              })}
              <TableRow className="border-t-2 font-semibold bg-muted/40">
                <TableCell className="sticky left-0 bg-muted/40">All locations</TableCell>
                {columns.map((c) => (
                  <TableCell key={c} className="text-right tabular-nums">{totals.counts[c] ?? 0}</TableCell>
                ))}
                <TableCell className="text-right tabular-nums">{totals.other}</TableCell>
                {showUnknown && <TableCell className="text-right tabular-nums">{totals.unknown}</TableCell>}
                <TableCell className="text-right tabular-nums">{totals.total}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
        )}
      </CardContent>
    </Card>
  );
}

function ServiceTypeChart({ summary }: { summary: DashboardSummary }) {
  const { rows, series } = buildServiceTypeChart(summary);
  return <StackedBars rows={rows} series={series} height={280} yAxisWidth={110} />;
}

function InsuranceChart({ summary }: { summary: DashboardSummary }) {
  const { rows, series } = buildInsuranceChart(summary);
  return (
    <StackedBars rows={rows} series={series}
      height={insuranceChartHeight(rows.length)} yAxisWidth={124} />
  );
}

/** Card 4 — Location × Origin. The CEO's referral-source ask. */
function OriginCard({ summary }: { summary: DashboardSummary }) {
  const { columns, labels, rows, totals } = summary.byOrigin;
  const { views, showTable, showChart, onChange } = useCardViews();
  const originChart = buildOriginChart(summary);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-4">
        <div>
          <CardTitle className="text-base font-medium">Location &times; Referral Origin</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            How each referral reached us. Every contact falls into exactly one category.
            Staff-entered records are not separately identifiable and appear under Online RFS Form.
          </p>
        </div>
        <ViewToggle views={views} onChange={onChange} />
      </CardHeader>
      <CardContent className="space-y-6">
        {!showTable && !showChart && <NoViews />}
        {showChart && (
          <StackedBars rows={originChart.rows} series={originChart.series} height={260} yAxisWidth={110} />
        )}
        {showTable && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Location</TableHead>
                {columns.map((c) => (
                  <TableHead key={c} className="text-right whitespace-nowrap">{labels[c] ?? c}</TableHead>
                ))}
                <TableHead className="text-right font-semibold">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.locations.map((loc) => {
                const r = rows.find((x) => x.location === loc.id);
                if (!r) return null;
                return (
                  <TableRow key={loc.id}>
                    <TableCell className="font-medium">
                      <LocationLabel summary={summary} id={loc.id} />
                    </TableCell>
                    {columns.map((c) => (
                      <TableCell key={c} className="text-right tabular-nums">
                        {n(r[c as keyof typeof r] as number)}
                      </TableCell>
                    ))}
                    <TableCell className="text-right tabular-nums font-semibold">{n(r.total)}</TableCell>
                  </TableRow>
                );
              })}
              <TableRow className="border-t-2 font-semibold bg-muted/40">
                <TableCell>All locations</TableCell>
                {columns.map((c) => (
                  <TableCell key={c} className="text-right tabular-nums">
                    {totals[c as keyof typeof totals] as number}
                  </TableCell>
                ))}
                <TableCell className="text-right tabular-nums">{totals.total}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const [population, setPopulation] = useState<Population>("active");

  if (!canAccessDashboard(user?.email)) return <Redirect to="/waitlist" replace />;

  const { data: summary, isLoading, error } = useQuery<DashboardSummary>({
    queryKey: ["/api/dashboard/summary", population],
    queryFn: () => getDashboardSummary(population),
  });

  if (isLoading) {
    return <PageLayout><PageLoader context="insights" /></PageLayout>;
  }

  if (error || !summary) {
    return (
      <PageLayout>
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="text-sm text-muted-foreground">
            {error instanceof Error ? error.message : "Failed to load dashboard"}
          </p>
        </div>
      </PageLayout>
    );
  }

  const dq = summary.dataQuality;

  return (
    <PageLayout>
      <div className="space-y-6">
        {/* Header + population toggle */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              Management Dashboard
              <Badge variant="outline" className="text-[10px]">Beta</Badge>
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Per-clinic performance. Location is the client&rsquo;s first-choice modality.
            </p>
          </div>
          <ToggleGroup
            type="single"
            value={population}
            onValueChange={(v) => v && setPopulation(v as Population)}
            size="sm"
          >
            <ToggleGroupItem value="active">Active ({summary.totals.active})</ToggleGroupItem>
            <ToggleGroupItem value="all">All ({summary.totals.all})</ToggleGroupItem>
          </ToggleGroup>
        </div>

        {/* The page explains its own arithmetic, so a CEO reading it alone can
            see why Pipeline and Active differ instead of assuming a bug. */}
        <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm">
          <span className="font-medium">{summary.totals.pipeline}</span> in pipeline
          <span className="text-muted-foreground"> (Waitlist + Pending + Scheduled)</span>
          {" + "}
          <span className="font-medium">{summary.totals.otherActive}</span> other active
          <span className="text-muted-foreground"> (Resources to Send, PM Review)</span>
          {" = "}
          <span className="font-medium">{summary.totals.active}</span> active
          <span className="text-muted-foreground"> of {summary.totals.all} total contacts.</span>
        </div>

        {dq.unreconciledRows.length > 0 && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm">
            <p className="font-medium text-destructive">Reconciliation failure — do not trust these numbers</p>
            <ul className="mt-1 text-xs list-disc pl-5">
              {dq.unreconciledRows.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </div>
        )}

        <StatusCard summary={summary} />

        <CrossTabCard
          summary={summary}
          title="Location × Service Type"
          subtitle="Who the request is for. Labels are display-only; stored values are unchanged."
          columns={summary.byServiceType.columns}
          labels={summary.byServiceType.labels}
          rows={summary.byServiceType.rows}
          totals={summary.byServiceType.totals}
          otherLabel="Other / Unmapped"
          chart={<ServiceTypeChart summary={summary} />}
        />

        <CrossTabCard
          summary={summary}
          title="Location × Insurance"
          subtitle="The 16 approved payers, plus an explicit column for records holding older spellings."
          columns={summary.byInsurance.columns}
          rows={summary.byInsurance.rows}
          totals={summary.byInsurance.totals}
          otherLabel="Other / Unmapped"
          otherNote={
            `${summary.byInsurance.totals.other} contacts across ` +
            `${summary.byInsurance.otherSummary.distinctValues} different non-standard spellings. ` +
            `The individual values are not shown: this is a free-text field and some entries ` +
            `contain patient details.`
          }
          chart={<InsuranceChart summary={summary} />}
        />

        <OriginCard summary={summary} />

        {/* Data-quality footer — this is what makes the beta a verification
            exercise rather than a demo. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">Data quality</CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-2">
            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <div className="text-2xl font-semibold tabular-nums">{dq.nonCanonicalInsurance}</div>
                <div className="text-xs text-muted-foreground">
                  contacts with a non-approved insurance spelling (shown as Other / Unmapped)
                </div>
              </div>
              <div>
                <div className="text-2xl font-semibold tabular-nums">{dq.nonCanonicalServiceType}</div>
                <div className="text-xs text-muted-foreground">
                  contacts with a non-standard service type
                </div>
              </div>
              <div>
                <div className="text-2xl font-semibold tabular-nums">{dq.nullModalityP1}</div>
                <div className="text-xs text-muted-foreground">
                  contacts with no first-choice modality recorded (all inactive)
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground border-t pt-2">
              {dq.note} Generated {new Date(summary.generatedAt).toLocaleString()} in {summary.queryMs}&thinsp;ms.
            </p>
          </CardContent>
        </Card>
      </div>
    </PageLayout>
  );
}
