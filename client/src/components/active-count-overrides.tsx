/**
 * Total Active Clients — setting the number by hand for a reporting period.
 *
 * WHERE IT LIVES. Inside the Survey Insights snapshot on the Submissions page.
 * It was in the export dialog first, because that was then the only screen
 * where a period had been chosen; the snapshot is now that screen AND it shows
 * the figures being corrected, so the correction belongs beside them. It MOVED
 * rather than being copied — two places to set one number is two places for
 * them to disagree — and the three routes underneath did not change.
 *
 * WHAT IT SHOWS. Every active provider, the figure the nightly pull read, and
 * an input. Typing a number and leaving the field saves it; clearing the field
 * removes the override and the pulled figure comes back. There is no third
 * state and no "cleared" marker — the row is deleted, so the export falls
 * through to the pull exactly as it did before anyone typed anything.
 *
 * NO PHI. Provider names are staff names; everything else is a count.
 */
import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Loader2, RotateCcw, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface OverrideRow {
  providerId: number;
  name: string;
  shortName: string;
  office: string;
  pulledCount: number | null;
  pulledOn: string | null;
  override: { count: number; note: string | null; setBy: string; setAt: string } | null;
}

export function ActiveCountOverrides({
  from, to, onChange,
}: {
  from: string;
  to: string;
  /** Fired after a save or a clear, so the caller can re-read what changed. */
  onChange?: () => void;
}) {
  const [rows, setRows] = useState<OverrideRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** providerId -> what is currently in the box, as typed. */
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState<number | null>(null);
  const { toast } = useToast();

  // Reload whenever the period changes: an override belongs to a period, so a
  // list left over from the previous range would be showing the wrong numbers
  // against the right names, which is worse than showing nothing.
  useEffect(() => {
    let cancelled = false;
    if (!from || !to || from > to) return;
    setLoading(true);
    setError(null);
    fetch(`/api/survey/active-count-overrides?from=${from}&to=${to}`, {
      credentials: "include", cache: "no-store",
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || "Could not load the counts.");
        return r.json();
      })
      .then((j) => {
        if (cancelled) return;
        setRows(j.rows);
        const d: Record<number, string> = {};
        j.rows.forEach((r: OverrideRow) => {
          d[r.providerId] = r.override ? String(r.override.count) : "";
        });
        setDraft(d);
      })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [from, to]);

  const overriddenCount = useMemo(
    () => (rows ?? []).filter((r) => r.override).length, [rows],
  );

  /**
   * Save or clear one row, on blur.
   *
   * An empty box means clear. That is the whole "clearing" story: there is no
   * separate control to find and no way to end up with a blank denominator,
   * because removing the override restores the pulled figure.
   */
  async function commit(row: OverrideRow) {
    const typed = (draft[row.providerId] ?? "").trim();
    const current = row.override ? String(row.override.count) : "";
    if (typed === current) return;               // nothing changed

    setSaving(row.providerId);
    try {
      let res: Response;
      if (typed === "") {
        res = await fetch(
          `/api/survey/active-count-overrides/${row.providerId}?from=${from}&to=${to}`,
          { method: "DELETE", credentials: "include" },
        );
      } else {
        const n = Number(typed);
        if (!Number.isInteger(n) || n < 0) {
          throw new Error("Enter a whole number, or leave it empty to use the TherapyNotes figure.");
        }
        res = await fetch("/api/survey/active-count-overrides", {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providerId: row.providerId, from, to, count: n }),
        });
      }
      if (!res.ok) {
        throw new Error((await res.json().catch(() => ({})))?.error || "That change could not be saved.");
      }
      const body = await res.json().catch(() => ({}));
      setRows((prev) => (prev ?? []).map((r) =>
        r.providerId !== row.providerId ? r : {
          ...r,
          override: typed === "" ? null : {
            count: Number(typed),
            note: body?.override?.note ?? null,
            setBy: body?.override?.setBy ?? "you",
            setAt: body?.override?.setAt ?? new Date().toISOString(),
          },
        }));
      // The snapshot above is showing the figure that just changed.
      onChange?.();
    } catch (e) {
      // Put the box back to what is actually stored, so the screen never shows
      // a number the export will not use.
      setDraft((d) => ({ ...d, [row.providerId]: current }));
      toast({
        title: "Not saved",
        description: e instanceof Error ? e.message : "That change could not be saved.",
        variant: "destructive",
      });
    } finally {
      setSaving(null);
    }
  }

  if (loading && !rows) {
    return (
      <p className="text-xs text-muted-foreground flex items-center gap-2 py-2">
        <Loader2 className="h-3 w-3 animate-spin" /> Loading counts…
      </p>
    );
  }
  if (error) return <p className="text-xs text-destructive py-2">{error}</p>;
  if (!rows || rows.length === 0) {
    return <p className="text-xs text-muted-foreground py-2">No active providers to show.</p>;
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        The figure on the left is what was read from TherapyNotes for this period.
        Type a number to use yours instead — for clients discharged part-way through
        the period, or for test records. Leave a box empty to go back to the
        TherapyNotes figure. Anything you set applies to{" "}
        <strong>this reporting period only</strong>.
      </p>

      <div className="max-h-64 overflow-y-auto rounded border divide-y">
        {rows.map((r) => (
          <div key={r.providerId} className="flex items-center gap-2 px-2 py-1.5 text-xs">
            <span className="flex-1 truncate" title={r.name}>
              {r.shortName}
              {r.office ? <span className="text-muted-foreground"> · {r.office}</span> : null}
            </span>
            <span className="w-16 text-right tabular-nums text-muted-foreground"
                  title={r.pulledOn ? `Read from TherapyNotes on ${r.pulledOn}` : "No reading for this period"}>
              {r.pulledCount ?? "—"}
            </span>
            <Input
              type="number"
              min={0}
              inputMode="numeric"
              className="w-20 h-7 text-xs"
              placeholder="—"
              value={draft[r.providerId] ?? ""}
              disabled={saving === r.providerId}
              onChange={(e) => setDraft((d) => ({ ...d, [r.providerId]: e.target.value }))}
              onBlur={() => commit(r)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              data-testid={`input-active-count-override-${r.providerId}`}
            />
            <span className="w-6 shrink-0 flex items-center justify-center">
              {saving === r.providerId
                ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                : r.override
                  ? <Check className="h-3 w-3 text-emerald-600" />
                  : null}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 shrink-0"
              title="Use the TherapyNotes figure"
              disabled={!r.override || saving === r.providerId}
              onClick={() => {
                setDraft((d) => ({ ...d, [r.providerId]: "" }));
                commit({ ...r });
              }}
              data-testid={`button-clear-active-count-override-${r.providerId}`}
            >
              <RotateCcw className="h-3 w-3" />
            </Button>
          </div>
        ))}
      </div>

      <p className="text-[11px] text-muted-foreground">
        {overriddenCount === 0
          ? "Every figure will come from TherapyNotes."
          : `${overriddenCount} figure${overriddenCount === 1 ? "" : "s"} set by hand. ` +
            "The export marks each one and records what TherapyNotes had said."}
      </p>
    </div>
  );
}
