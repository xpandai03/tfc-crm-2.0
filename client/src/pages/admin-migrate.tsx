import { useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Upload,
  Play,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  RotateCcw,
  Shield,
  FileText,
} from "lucide-react";
import { transformCSV, type MigrationContact, type TransformResult } from "@/lib/csv-transform";

type Stage = "upload" | "parsed" | "validated" | "migrated";

interface DryRunResult {
  dryRun: boolean;
  total: number;
  valid: number;
  invalid: number;
  errors: Array<{ contactId: number | null; field: string; message: string }>;
  stats: {
    statusDistribution: Record<string, number>;
    missingFields: Record<string, number>;
    dateParsing: { dobSuccess: number; dobFailed: number; dateAddedSuccess: number; dateAddedFailed: number };
    insuranceVariants: Record<string, number>;
  };
}

interface MigrateResult {
  success: boolean;
  total: number;
  valid: number;
  migrated: number;
  skipped: number;
  errors: Array<{ contactId: number | null; field: string; message: string }>;
  stats: {
    statusDistribution: Record<string, number>;
    missingFields: Record<string, number>;
    dateParsing: { dobSuccess: number; dobFailed: number; dateAddedSuccess: number; dateAddedFailed: number };
    insuranceVariants: Record<string, number>;
  };
}

const STATUS_LABELS: Record<number, string> = {
  100: "New — No Outreach",
  101: "Waiting — Initial Contact",
  102: "Waiting — On Waitlist",
  103: "Waiting — Needs Follow-up",
  104: "Waiting — Pending Paperwork",
  200: "Ready to Schedule",
  201: "Scheduling — New Assignment",
  202: "Scheduling — Assigned",
  203: "Scheduling — Attempted",
  204: "Scheduling — PM Review",
  205: "Scheduled",
  300: "Active",
  400: "Insurance Not Accepted",
};

export default function AdminMigrate() {
  const [stage, setStage] = useState<Stage>("upload");
  const [apiKey, setApiKey] = useState("");
  const [fileName, setFileName] = useState("");
  const [transformResult, setTransformResult] = useState<TransformResult | null>(null);
  const [contacts, setContacts] = useState<MigrationContact[]>([]);
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);
  const [migrateResult, setMigrateResult] = useState<MigrateResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const text = ev.target?.result as string;
        const result = transformCSV(text);
        if (result.contacts.length === 0) {
          setError("No valid contacts found in CSV. Check the file format.");
          return;
        }
        setTransformResult(result);
        setContacts(result.contacts);
        setStage("parsed");
        setDryRunResult(null);
        setMigrateResult(null);
      } catch (err) {
        setError(`Failed to parse CSV: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    reader.readAsText(file, "latin1");
  }, []);

  const runDryRun = useCallback(async () => {
    if (!apiKey.trim()) { setError("Enter the migration API key"); return; }
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/migrate?dryRun=true", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Migrate-Key": apiKey.trim(),
        },
        body: JSON.stringify({ contacts }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data: DryRunResult = await res.json();
      setDryRunResult(data);
      setStage("validated");
    } catch (err) {
      setError(`Dry run failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsLoading(false);
    }
  }, [apiKey, contacts]);

  const executeMigration = useCallback(async () => {
    setShowConfirm(false);
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/migrate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Migrate-Key": apiKey.trim(),
        },
        body: JSON.stringify({ contacts }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data: MigrateResult = await res.json();
      setMigrateResult(data);
      setStage("migrated");
    } catch (err) {
      setError(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsLoading(false);
    }
  }, [apiKey, contacts]);

  const reset = () => {
    setStage("upload");
    setFileName("");
    setTransformResult(null);
    setContacts([]);
    setDryRunResult(null);
    setMigrateResult(null);
    setError(null);
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Shield className="h-6 w-6 text-muted-foreground" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Admin: Data Migration</h1>
            <p className="text-sm text-muted-foreground">Upload CSV, validate, and migrate contacts safely</p>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3 flex items-start gap-2">
            <XCircle className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
            <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
          </div>
        )}

        {/* Step 1: API Key */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Authentication
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Input
              type="password"
              placeholder="Enter MIGRATE_API_KEY"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="max-w-sm font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1.5">Required for all migration operations. Not stored.</p>
          </CardContent>
        </Card>

        {/* Step 2: Upload CSV */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Upload className="h-4 w-4" />
              1. Upload CSV
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3">
              <label className="cursor-pointer">
                <Input
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={handleFileUpload}
                />
                <div className="flex items-center gap-2 px-4 py-2 border rounded-md text-sm hover:bg-muted transition-colors">
                  <FileText className="h-4 w-4" />
                  {fileName || "Choose CSV file"}
                </div>
              </label>
              {transformResult && (
                <div className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  <span>{transformResult.contacts.length} contacts parsed</span>
                  {transformResult.skippedRows > 0 && (
                    <span className="text-muted-foreground">({transformResult.skippedRows} skipped)</span>
                  )}
                </div>
              )}
            </div>

            {/* Parse preview */}
            {transformResult && (
              <div className="mt-4 space-y-3">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Status Distribution</div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(transformResult.statusDistribution)
                    .sort(([a], [b]) => Number(a) - Number(b))
                    .map(([code, count]) => (
                      <Badge key={code} variant="secondary" className="text-xs font-mono">
                        {code} {STATUS_LABELS[Number(code)] ? `(${STATUS_LABELS[Number(code)]})` : ""}: {count}
                      </Badge>
                    ))}
                </div>

                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mt-3">Sample (first 3)</div>
                <div className="space-y-1">
                  {contacts.slice(0, 3).map((c) => (
                    <div key={c.contactId} className="text-xs font-mono bg-muted/50 rounded px-2 py-1">
                      #{c.contactId} {c.name} — {c.statusCode} — {c.requestingFor || "?"} — {c.insurancePayer || "no ins"}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Step 3: Dry Run */}
        {stage !== "upload" && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Play className="h-4 w-4" />
                2. Validate (Dry Run)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button
                onClick={runDryRun}
                disabled={isLoading || !apiKey.trim()}
                className="gap-2"
              >
                {isLoading && stage !== "migrated" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                Run Dry Run
              </Button>

              {/* Dry run results */}
              {dryRunResult && (
                <div className="space-y-4">
                  <Separator />

                  {/* Summary */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-muted/50 rounded-lg p-3 text-center">
                      <div className="text-2xl font-bold">{dryRunResult.total}</div>
                      <div className="text-xs text-muted-foreground">Total</div>
                    </div>
                    <div className="bg-green-50 dark:bg-green-950/30 rounded-lg p-3 text-center">
                      <div className="text-2xl font-bold text-green-700 dark:text-green-400">{dryRunResult.valid}</div>
                      <div className="text-xs text-green-600">Valid</div>
                    </div>
                    <div className={`rounded-lg p-3 text-center ${dryRunResult.invalid > 0 ? "bg-red-50 dark:bg-red-950/30" : "bg-muted/50"}`}>
                      <div className={`text-2xl font-bold ${dryRunResult.invalid > 0 ? "text-red-700 dark:text-red-400" : ""}`}>{dryRunResult.invalid}</div>
                      <div className="text-xs text-muted-foreground">Invalid</div>
                    </div>
                  </div>

                  {/* Status distribution */}
                  <div>
                    <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Status Distribution</div>
                    <div className="flex flex-wrap gap-1.5">
                      {Object.entries(dryRunResult.stats.statusDistribution)
                        .sort(([a], [b]) => Number(a) - Number(b))
                        .map(([code, count]) => (
                          <Badge key={code} variant="outline" className="text-xs font-mono">
                            {code}: {count}
                          </Badge>
                        ))}
                    </div>
                  </div>

                  {/* Date parsing */}
                  <div>
                    <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Date Parsing</div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="bg-muted/50 rounded px-2 py-1">DOB parsed: {dryRunResult.stats.dateParsing.dobSuccess}</div>
                      <div className={`rounded px-2 py-1 ${dryRunResult.stats.dateParsing.dobFailed > 0 ? "bg-amber-50 dark:bg-amber-950/30 text-amber-800" : "bg-muted/50"}`}>
                        DOB failed: {dryRunResult.stats.dateParsing.dobFailed}
                      </div>
                      <div className="bg-muted/50 rounded px-2 py-1">Date added parsed: {dryRunResult.stats.dateParsing.dateAddedSuccess}</div>
                      <div className={`rounded px-2 py-1 ${dryRunResult.stats.dateParsing.dateAddedFailed > 0 ? "bg-amber-50 dark:bg-amber-950/30 text-amber-800" : "bg-muted/50"}`}>
                        Date added failed: {dryRunResult.stats.dateParsing.dateAddedFailed}
                      </div>
                    </div>
                  </div>

                  {/* Missing fields */}
                  {Object.keys(dryRunResult.stats.missingFields).length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Missing Fields</div>
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(dryRunResult.stats.missingFields)
                          .sort(([, a], [, b]) => b - a)
                          .map(([field, count]) => (
                            <Badge key={field} variant="secondary" className="text-xs">
                              {field}: {count}
                            </Badge>
                          ))}
                      </div>
                    </div>
                  )}

                  {/* Insurance variants */}
                  {Object.keys(dryRunResult.stats.insuranceVariants).length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                        Insurance Variants ({Object.keys(dryRunResult.stats.insuranceVariants).length} unique)
                      </div>
                      <ScrollArea className="h-32">
                        <div className="space-y-0.5">
                          {Object.entries(dryRunResult.stats.insuranceVariants)
                            .sort(([, a], [, b]) => b - a)
                            .map(([payer, count]) => (
                              <div key={payer} className="flex justify-between text-xs px-2 py-0.5 hover:bg-muted/50 rounded">
                                <span className="truncate">{payer}</span>
                                <span className="text-muted-foreground font-mono ml-2">{count}</span>
                              </div>
                            ))}
                        </div>
                      </ScrollArea>
                    </div>
                  )}

                  {/* Errors */}
                  {dryRunResult.errors.length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-red-600 uppercase tracking-wide mb-2 flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" />
                        Errors ({dryRunResult.errors.length})
                      </div>
                      <ScrollArea className="h-40">
                        <div className="space-y-1">
                          {dryRunResult.errors.map((err, i) => (
                            <div key={i} className="text-xs bg-red-50 dark:bg-red-950/20 rounded px-2 py-1 font-mono">
                              #{err.contactId} [{err.field}]: {err.message}
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Step 4: Execute */}
        {stage === "validated" && dryRunResult && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4" />
                3. Execute Migration
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => setShowConfirm(true)}
                disabled={isLoading}
                variant={dryRunResult.invalid > 0 ? "outline" : "default"}
                className="gap-2"
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                Execute Migration ({dryRunResult.valid} contacts)
              </Button>
              {dryRunResult.invalid > 0 && (
                <p className="text-xs text-amber-600 mt-1.5 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  {dryRunResult.invalid} invalid rows will be skipped
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Step 5: Results */}
        {stage === "migrated" && migrateResult && (
          <Card className="border-green-200 dark:border-green-800">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2 text-green-700 dark:text-green-400">
                <CheckCircle2 className="h-4 w-4" />
                Migration Complete
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-green-50 dark:bg-green-950/30 rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-green-700 dark:text-green-400">{migrateResult.migrated}</div>
                  <div className="text-xs text-green-600">Migrated</div>
                </div>
                <div className="bg-muted/50 rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold">{migrateResult.skipped}</div>
                  <div className="text-xs text-muted-foreground">Skipped (existing)</div>
                </div>
                <div className={`rounded-lg p-3 text-center ${migrateResult.errors.length > 0 ? "bg-red-50 dark:bg-red-950/30" : "bg-muted/50"}`}>
                  <div className={`text-2xl font-bold ${migrateResult.errors.length > 0 ? "text-red-700 dark:text-red-400" : ""}`}>{migrateResult.errors.length}</div>
                  <div className="text-xs text-muted-foreground">Errors</div>
                </div>
              </div>

              {migrateResult.errors.length > 0 && (
                <ScrollArea className="h-32">
                  <div className="space-y-1">
                    {migrateResult.errors.map((err, i) => (
                      <div key={i} className="text-xs bg-red-50 dark:bg-red-950/20 rounded px-2 py-1 font-mono">
                        #{err.contactId} [{err.field}]: {err.message}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}

              <Button onClick={reset} variant="outline" className="gap-2">
                <RotateCcw className="h-4 w-4" />
                Upload Another
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Safety notice */}
        <div className="text-xs text-muted-foreground text-center space-y-1 pt-4">
          <p>INSERT OR IGNORE — existing contacts are never overwritten.</p>
          <p>Notes, assignments, reminders, and timeline data are never affected.</p>
        </div>
      </div>

      {/* Confirmation dialog */}
      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Confirm Migration
            </DialogTitle>
          </DialogHeader>
          <div className="text-sm space-y-2 py-2">
            <p>This will insert <strong>{dryRunResult?.valid ?? 0}</strong> contacts into the database.</p>
            <p>Existing contacts (by contactId) will be <strong>skipped</strong>, not overwritten.</p>
            <p className="text-muted-foreground">Notes, assignments, and reminders will NOT be affected.</p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowConfirm(false)}>Cancel</Button>
            <Button onClick={executeMigration}>Confirm Migration</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
