/**
 * Saved-view chips for the waitlist toolbar.
 *
 * "Default" is always first and is the escape hatch: one click back to the
 * familiar table from any state, including a corrupted one. It is
 * NON-DESTRUCTIVE — it resets the working state only, deletes nothing, and
 * leaves every named view in place. That is what makes experimenting safe.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { LayoutList, MoreVertical, Check, X } from "lucide-react";
import type { NamedView } from "@/lib/view-preferences";

interface Props {
  views: NamedView[];
  /** id of the view whose snapshot is currently applied, or null for Default. */
  activeViewId: string | null;
  /** Working state differs from the active view's snapshot. */
  isDiverged: boolean;
  onApply: (view: NamedView) => void;
  onApplyDefault: () => void;
  onUpdate: (view: NamedView) => void;
  onRename: (view: NamedView, name: string) => void;
  onDelete: (view: NamedView) => void;
}

export function ViewChips({
  views, activeViewId, isDiverged, onApply, onApplyDefault, onUpdate, onRename, onDelete,
}: Props) {
  const [renaming, setRenaming] = useState<NamedView | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmUpdate, setConfirmUpdate] = useState<NamedView | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<NamedView | null>(null);

  return (
    <>
      <div className="flex items-center gap-1.5 flex-wrap" data-testid="view-chips">
        <span className="text-xs text-muted-foreground mr-0.5">Views:</span>

        {/* Always first, always available. */}
        <button
          type="button"
          onClick={onApplyDefault}
          data-testid="chip-default"
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors",
            activeViewId === null
              ? "border-primary/40 bg-primary/10 text-primary font-medium"
              : "border-border text-muted-foreground hover:bg-accent"
          )}
        >
          <LayoutList className="h-3 w-3" />
          Default
        </button>

        {views.map((v) => {
          const active = v.id === activeViewId;
          return (
            <div
              key={v.id}
              className={cn(
                "inline-flex items-center rounded-full border text-xs transition-colors",
                active
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:bg-accent"
              )}
            >
              <button
                type="button"
                onClick={() => onApply(v)}
                className="pl-2.5 pr-1 py-1 font-medium max-w-[160px] truncate"
                title={v.name}
                data-testid={`chip-view-${v.id}`}
              >
                {v.name}
                {/* Modified dot: the working state has drifted from this
                    snapshot. The snapshot itself is untouched — a tweak never
                    silently rewrites a saved view. */}
                {active && isDiverged && (
                  <span
                    className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-500 align-middle"
                    title="Modified — unsaved changes since this view was applied"
                  />
                )}
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className="px-1 py-1 opacity-60 hover:opacity-100" aria-label={`${v.name} actions`}>
                    <MoreVertical className="h-3 w-3" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onClick={() => setConfirmUpdate(v)}>
                    Update with current view
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setRenaming(v); setRenameValue(v.name); }}>
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem className="text-destructive" onClick={() => setConfirmDelete(v)}>
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
      </div>

      {/* Rename — inline so it can't be confused with "save as new". */}
      {renaming && (
        <div className="flex items-center gap-1.5 mt-1.5">
          <Input
            autoFocus
            value={renameValue}
            maxLength={30}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { onRename(renaming, renameValue); setRenaming(null); }
              if (e.key === "Escape") setRenaming(null);
            }}
            className="h-7 text-xs max-w-[220px]"
            data-testid="input-rename-view"
          />
          <Button size="icon" variant="ghost" className="h-7 w-7"
                  onClick={() => { onRename(renaming, renameValue); setRenaming(null); }}>
            <Check className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setRenaming(null)}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      <AlertDialog open={!!confirmUpdate} onOpenChange={(o) => !o && setConfirmUpdate(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Update “{confirmUpdate?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This replaces the saved columns, filters and sort with what you have on
              screen now. It can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (confirmUpdate) onUpdate(confirmUpdate); setConfirmUpdate(null); }}
            >
              Update view
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{confirmDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The view is removed for you only. Your current table stays as it is.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (confirmDelete) onDelete(confirmDelete); setConfirmDelete(null); }}
            >
              Delete view
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
