/**
 * Column settings popover: visibility + ordering + reset.
 *
 * Up/down buttons rather than drag-and-drop, deliberately. DnD inside a table
 * is fiddly (drag handles in <th>, live preview, touch and keyboard support)
 * and buys nothing here — the list is short and reordering is rare.
 */
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Settings2, ChevronUp, ChevronDown, RotateCcw } from "lucide-react";
import type { WaitlistColumnDef } from "./waitlist-columns";

interface Props {
  allColumns: WaitlistColumnDef[];
  /** Current order, by id — includes hidden columns. */
  order: string[];
  visible: string[];
  onChange: (next: { order: string[]; visible: string[] }) => void;
  onReset: () => void;
  isResetting?: boolean;
  /** Snapshot the current arrangement under a name. */
  onSaveAsView?: (name: string) => void;
  savedViewCount?: number;
  maxViews?: number;
}

export function ColumnSettings({
  allColumns, order, visible, onChange, onReset, isResetting,
  onSaveAsView, savedViewCount = 0, maxViews = 8,
}: Props) {
  const [newViewName, setNewViewName] = useState("");
  const atLimit = savedViewCount >= maxViews;
  const byId = useMemo(() => {
    const m: Record<string, WaitlistColumnDef> = {};
    allColumns.forEach((c) => { m[c.id] = c; });
    return m;
  }, [allColumns]);

  // Locked columns (Name) are excluded entirely: they can't be hidden or moved,
  // so offering the controls would only invite a dead click.
  const rows = order.map((id) => byId[id]).filter((c): c is WaitlistColumnDef => !!c && !c.alwaysVisible);
  const visibleCount = visible.length;

  const move = (id: string, dir: -1 | 1) => {
    const next = order.slice();
    const from = next.indexOf(id);
    if (from === -1) return;
    // Skip over locked columns so a movable column can't be pushed above Name.
    let to = from + dir;
    while (to >= 0 && to < next.length && byId[next[to]]?.alwaysVisible) to += dir;
    if (to < 0 || to >= next.length) return;
    next.splice(to, 0, next.splice(from, 1)[0]);
    onChange({ order: next, visible });
  };

  const toggle = (id: string) => {
    const on = visible.indexOf(id) !== -1;
    // Never allow the last non-locked column to be switched off — an empty
    // table with only Name reads as a bug, not a choice.
    if (on && visibleCount <= 2) return;
    const next = on ? visible.filter((v) => v !== id) : visible.concat(id);
    onChange({ order, visible: next });
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5" data-testid="button-column-settings">
          <Settings2 className="h-3.5 w-3.5" />
          Columns
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Columns</span>
          <span className="text-[10px] text-muted-foreground">{visibleCount} shown</span>
        </div>
        <p className="text-[11px] text-muted-foreground mb-2">
          Your choices are saved automatically and restored next time.
        </p>
        <div className="max-h-80 overflow-y-auto -mx-1 px-1">
          {rows.map((col, i) => {
            const on = visible.indexOf(col.id) !== -1;
            return (
              <div key={col.id} className="flex items-center gap-2 py-1 rounded hover:bg-accent px-1">
                <Checkbox
                  checked={on}
                  onCheckedChange={() => toggle(col.id)}
                  data-testid={`checkbox-column-${col.id}`}
                />
                <span className="text-sm flex-1 truncate">{col.label}</span>
                <Button
                  variant="ghost" size="icon" className="h-6 w-6"
                  disabled={i === 0}
                  onClick={() => move(col.id, -1)}
                  aria-label={`Move ${col.label} up`}
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost" size="icon" className="h-6 w-6"
                  disabled={i === rows.length - 1}
                  onClick={() => move(col.id, 1)}
                  aria-label={`Move ${col.label} down`}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
        {onSaveAsView && (
          <div className="pt-2 mt-2 border-t space-y-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Save as view
            </span>
            <div className="flex items-center gap-1.5">
              <Input
                value={newViewName}
                maxLength={30}
                placeholder={atLimit ? `Limit ${maxViews} reached` : "Name this view…"}
                disabled={atLimit}
                onChange={(e) => setNewViewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newViewName.trim()) {
                    onSaveAsView(newViewName); setNewViewName("");
                  }
                }}
                className="h-7 text-xs"
                data-testid="input-new-view-name"
              />
              <Button
                size="sm" variant="secondary" className="h-7 text-xs shrink-0"
                disabled={atLimit || !newViewName.trim()}
                onClick={() => { onSaveAsView(newViewName); setNewViewName(""); }}
                data-testid="button-save-as-view"
              >
                Save
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              {savedViewCount} of {maxViews} views saved
            </p>
          </div>
        )}

        <div className="pt-2 mt-2 border-t">
          <Button
            variant="outline" size="sm" className="w-full text-xs"
            onClick={onReset}
            disabled={isResetting}
            data-testid="button-reset-view"
          >
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
            {isResetting ? "Resetting…" : "Reset to default view"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
