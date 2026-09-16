/**
 * Survey snapshot — the mid-month glance.
 *
 * NOT CALLED "Survey Insights". The CRM already has an Insights tab, with this
 * icon, and a second thing called Insights that is a panel rather than a page
 * is a thing to explain forever. "Snapshot" is also the client's own word for
 * what he asked for.
 *
 * TWO TABLES. Providers, then locations, three numbers each. The client was
 * offered a full survey results view and cut it to this: "I really only want
 * the total active clients, the total surveys completed, and then the
 * percentage. Same thing for location — I don't want it broken down by
 * provider. Just a quick snapshot."
 *
 * There is no question breakdown, no comment listing, no chart and no
 * office-by-provider grid, and none of those is an oversight. He has watched
 * reports grow past their usefulness and was specific to prevent it.
 *
 * COLLAPSED BY DEFAULT. Most people opening Submissions came to look at a
 * submission. This sits above the list as one line until someone wants it, and
 * it fetches nothing until then — a page that got slower for everyone to serve
 * one person's monthly habit would be a bad trade.
 *
 * WHERE THE NUMBERS COME FROM. One endpoint, which reshapes the same data the
 * export workbook is built from. Nothing is computed here; a dash is a dash
 * because the server withheld the figure, and the reason is in the tooltip.
 *
 * NO PHI. Provider names are staff names; everything else is a count.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ClipboardList, Loader2, SlidersHorizontal, Pencil } from "lucide-react";
import { ActiveCountOverrides } from "@/components/active-count-overrides";

/** The calendar month, which is what he reads mid-month. */
function currentMonth(now: Date = new Date()): { from: string; to: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(new Date(Date.UTC(y, m + 1, 0))) };
}

interface ProviderRow {
  providerId: number | null;
  name: string;
  shortName: string;
  office: string;
  activeClients: number | null;
  surveys: number;
  percent: number | null;
  override: { pulled: number | null; setBy: string; setAt: string } | null;
}
interface OfficeRow {
  office: string;
  providers: number;
  activeClients: number | null;
  surveys: number;
  percent: number | null;
  missingCounts: number;
}
interface Snapshot {
  period: { from: string; to: string };
  providers: ProviderRow[];
  offices: OfficeRow[];
  total: OfficeRow;
  countsAsOf: string | null;
  submissionsInPeriod: number;
  overrideCount: number;
}

const OFFICE_LABEL: Record<string, string> = {
  ABQ: "Albuquerque", LL: "Los Lunas", RR: "Rio Rancho", "": "No office",
};
const officeLabel = (o: string) => OFFICE_LABEL[o] ?? o;

/** A withheld figure, with the reason a reader would otherwise have to guess. */
function Dash({ title }: { title: string }) {
  return <span className="text-muted-foreground" title={title}>—</span>;
}

export function SurveySnapshot() {
  const [open, setOpen] = useState(false);
  const month = currentMonth();
  const [from, setFrom] = useState(month.from);
  const [to, setTo] = useState(month.to);
  const [data, setData] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOverrides, setShowOverrides] = useState(false);
  /** Bumped when an override is saved, to re-read the figures it changed. */
  const [refresh, setRefresh] = useState(0);

  const rangeValid = Boolean(from) && Boolean(to) && from <= to;

  useEffect(() => {
    if (!open || !rangeValid) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/survey/snapshot?from=${from}&to=${to}`, {
      credentials: "include", cache: "no-store",
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || "Could not load the snapshot.");
        return r.json();
      })
      .then((j) => { if (!cancelled) setData(j); })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, from, to, rangeValid, refresh]);

  return (
    <div className="rounded border">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium hover:bg-muted/50"
        onClick={() => setOpen((v) => !v)}
        data-testid="button-toggle-survey-snapshot"
      >
        <ClipboardList className="h-4 w-4" />
        Survey snapshot
        <span className="ml-auto text-xs text-muted-foreground font-normal">
          {open ? "Hide" : "Show"}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 border-t space-y-3">
          {/* Same picker pattern as the export dialog. */}
          <div className="flex items-end gap-2 flex-wrap">
            <div className="space-y-1">
              <Label htmlFor="snapshot-from" className="text-[11px]">From</Label>
              <Input id="snapshot-from" type="date" value={from} className="h-7 text-xs w-36"
                onChange={(e) => setFrom(e.target.value)} data-testid="input-snapshot-from" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="snapshot-to" className="text-[11px]">To</Label>
              <Input id="snapshot-to" type="date" value={to} className="h-7 text-xs w-36"
                onChange={(e) => setTo(e.target.value)} data-testid="input-snapshot-to" />
            </div>
            <Button
              variant="outline" size="sm" className="h-7 text-xs gap-1.5 ml-auto"
              onClick={() => setShowOverrides((v) => !v)}
              disabled={!rangeValid}
              data-testid="button-toggle-active-counts"
            >
              <SlidersHorizontal className="h-3 w-3" />
              {showOverrides ? "Done" : "Adjust counts"}
            </Button>
          </div>

          {!rangeValid && (
            <p className="text-xs text-destructive">
              The start date must be on or before the end date.
            </p>
          )}

          {/*
            The override panel MOVED here from the export dialog — it is not a
            copy. This is now the only screen where a period is chosen and the
            numbers for it are on display, which is where correcting one
            belongs.
          */}
          {showOverrides && rangeValid && (
            <div className="rounded border bg-muted/30 p-2">
              <ActiveCountOverrides from={from} to={to} onChange={() => setRefresh((n) => n + 1)} />
            </div>
          )}

          {loading && !data && (
            <p className="text-xs text-muted-foreground flex items-center gap-2 py-3">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading…
            </p>
          )}
          {error && <p className="text-xs text-destructive py-2">{error}</p>}

          {data && rangeValid && (
            <>
              {/* ---------- TABLE ONE: providers ---------- */}
              <div>
                <p className="text-xs font-medium mb-1">By provider</p>
                <div className="rounded border overflow-x-auto">
                  <table className="w-full text-xs" data-testid="table-snapshot-providers">
                    <thead className="bg-muted/50">
                      <tr className="text-left">
                        <th className="px-2 py-1.5 font-medium">Provider</th>
                        <th className="px-2 py-1.5 font-medium text-right">Active clients</th>
                        <th className="px-2 py-1.5 font-medium text-right">Surveys</th>
                        <th className="px-2 py-1.5 font-medium text-right">%</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {data.providers.map((r) => (
                        <tr key={r.providerId ?? r.name} className="hover:bg-muted/30">
                          <td className="px-2 py-1 truncate max-w-[14rem]" title={r.name}>
                            {r.shortName}
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums">
                            {r.activeClients === null
                              ? <Dash title="No TherapyNotes reading for this period, and no figure was set by hand." />
                              : (
                                <span className="inline-flex items-center gap-1 justify-end">
                                  {r.activeClients}
                                  {/* Same principle as the workbook: a number a
                                      person typed is never shown silently. */}
                                  {r.override && (
                                    <span
                                      data-testid={`marker-override-${r.providerId}`}
                                      aria-label="Set by hand"
                                      title={
                                        `Set by hand by ${r.override.setBy} on ` +
                                        `${r.override.setAt.slice(0, 10)}. ` +
                                        (r.override.pulled === null
                                          ? "There was no TherapyNotes reading for this period."
                                          : `TherapyNotes had ${r.override.pulled}.`)
                                      }
                                    >
                                      <Pencil className="h-2.5 w-2.5 text-amber-600" />
                                    </span>
                                  )}
                                </span>
                              )}
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums">{r.surveys}</td>
                          <td className="px-2 py-1 text-right tabular-nums">
                            {r.percent === null
                              ? <Dash title="No active client count to divide by." />
                              : `${r.percent}%`}
                          </td>
                        </tr>
                      ))}
                      {data.providers.length === 0 && (
                        <tr><td colSpan={4} className="px-2 py-3 text-center text-muted-foreground">
                          No active providers.
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* ---------- TABLE TWO: locations ---------- */}
              <div>
                <p className="text-xs font-medium mb-1">By location</p>
                <div className="rounded border overflow-x-auto">
                  <table className="w-full text-xs" data-testid="table-snapshot-offices">
                    <thead className="bg-muted/50">
                      <tr className="text-left">
                        <th className="px-2 py-1.5 font-medium">Location</th>
                        <th className="px-2 py-1.5 font-medium text-right">Active clients</th>
                        <th className="px-2 py-1.5 font-medium text-right">Surveys</th>
                        <th className="px-2 py-1.5 font-medium text-right">%</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {data.offices.map((o) => (
                        <tr key={o.office} className="hover:bg-muted/30">
                          <td className="px-2 py-1">{officeLabel(o.office)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">
                            {o.activeClients === null
                              ? <Dash title={`${o.missingCounts} of ${o.providers} provider(s) here have no count, so a total would divide all the surveys by only some of the clients.`} />
                              : o.activeClients}
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums">{o.surveys}</td>
                          <td className="px-2 py-1 text-right tabular-nums">
                            {o.percent === null
                              ? <Dash title="Shown only when every provider here has a count." />
                              : `${o.percent}%`}
                          </td>
                        </tr>
                      ))}
                      <tr className="font-medium bg-muted/30">
                        <td className="px-2 py-1">Total</td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {data.total.activeClients === null
                            ? <Dash title={`${data.total.missingCounts} provider(s) have no count, so a practice total would be misleading.`} />
                            : data.total.activeClients}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">{data.total.surveys}</td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {data.total.percent === null
                            ? <Dash title="Shown only when every provider has a count." />
                            : `${data.total.percent}%`}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <p className="text-[11px] text-muted-foreground">
                Percentages are surveys ÷ active clients, rounded to a whole percent —
                the same figure the export workbook shows for this period.
                {data.countsAsOf
                  ? ` Client counts read from TherapyNotes on ${data.countsAsOf}.`
                  : " No TherapyNotes reading has been taken for this period yet."}
                {data.overrideCount > 0
                  ? ` ${data.overrideCount} figure${data.overrideCount === 1 ? "" : "s"} set by hand.`
                  : ""}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
