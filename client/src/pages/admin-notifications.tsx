import { useMemo } from "react";
import { Redirect } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { PageLayout } from "@/components/layout/page-layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { canManageNotifications } from "@shared/access-control";
import { Loader2, Send } from "lucide-react";

interface Rule { id: string; recipient: string; event: string; description: string }
interface Pref { email: string; muted: boolean; updatedBy: string | null; updatedAt: string }
interface LogRow {
  id: number;
  recipient: string;
  text: string;
  event: string;
  ruleIds: string[];
  status: string;
  attempts: number;
  lastHttpStatus: number | null;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
}
interface AdminData {
  enabled: boolean;
  webhookConfigured: boolean;
  rules: Rule[];
  preferences: Pref[];
  log: LogRow[];
}

const QUERY_KEY = ["/api/admin/notifications"];

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  sent: "default",
  pending: "secondary",
  sending: "secondary",
  failed: "destructive",
  blocked: "destructive",
};

function fmt(ts: string | null): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString("en-US", {
    timeZone: "America/Denver", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export default function AdminNotifications() {
  const { user } = useAuth();
  const { toast } = useToast();
  const allowed = canManageNotifications(user?.email);

  const { data, isLoading } = useQuery<AdminData>({
    queryKey: QUERY_KEY,
    enabled: allowed,
    refetchInterval: 30_000,
  });

  const setMute = useMutation({
    mutationFn: async (v: { email: string; muted: boolean }) =>
      (await apiRequest("PUT", "/api/admin/notifications/preferences", v)).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
    onError: (e: Error) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });

  const sendTest = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/admin/notifications/test")).json(),
    onSuccess: (r: { status: string; httpStatus: number | null; error: string | null }) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast({
        title: r.status === "sent" ? "Test sent" : `Test ${r.status}`,
        description: r.httpStatus ? `Webhook answered ${r.httpStatus}` : r.error ?? undefined,
        variant: r.status === "sent" ? undefined : "destructive",
      });
    },
    onError: (e: Error) => toast({ title: "Test failed", description: e.message, variant: "destructive" }),
  });

  // Everyone a rule can reach, plus anyone with a saved preference.
  const people = useMemo(() => {
    if (!data) return [];
    const prefs = new Map(data.preferences.map((p) => [p.email, p]));
    const emails = new Set<string>();
    data.rules.forEach((r) => emails.add(r.recipient));
    data.preferences.forEach((p) => emails.add(p.email));
    return Array.from(emails).sort().map((email) => ({
      email,
      muted: prefs.get(email)?.muted ?? false,
      updatedBy: prefs.get(email)?.updatedBy ?? null,
      rules: data.rules.filter((r) => r.recipient === email),
    }));
  }, [data]);

  if (!allowed) return <Redirect to="/waitlist" replace />;

  return (
    <PageLayout>
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Teams notifications</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Who is told what in Teams, and the last 200 messages.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {data && (
              <>
                <Badge variant={data.enabled ? "default" : "destructive"}>
                  {data.enabled ? "Enabled" : "Kill switch on"}
                </Badge>
                <Badge variant={data.webhookConfigured ? "outline" : "destructive"}>
                  {data.webhookConfigured ? "Webhook set" : "Webhook not set"}
                </Badge>
              </>
            )}
            <Button size="sm" onClick={() => sendTest.mutate()} disabled={sendTest.isPending}>
              {sendTest.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Send className="h-4 w-4 mr-2" />}
              Send me a test notification
            </Button>
          </div>
        </div>

        {isLoading && (
          <div className="flex justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        )}

        {data && (
          <>
            <Card>
              <CardHeader><CardTitle className="text-base">People</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Person</TableHead>
                      <TableHead>Told when</TableHead>
                      <TableHead className="w-32">Receiving</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {people.map((p) => (
                      <TableRow key={p.email}>
                        <TableCell className="font-medium whitespace-nowrap">{p.email}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {p.rules.length ? p.rules.map((r) => r.description).join(" · ") : "No rules"}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={!p.muted}
                              disabled={setMute.isPending}
                              onCheckedChange={(on) => setMute.mutate({ email: p.email, muted: !on })}
                              aria-label={`Notifications for ${p.email}`}
                            />
                            <span className="text-xs text-muted-foreground">{p.muted ? "Muted" : "On"}</span>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">Log (last 200)</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto">
                {data.log.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-6 text-center">Nothing yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>When</TableHead>
                        <TableHead>To</TableHead>
                        <TableHead>Message</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.log.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell className="whitespace-nowrap text-xs">{fmt(row.createdAt)}</TableCell>
                          <TableCell className="whitespace-nowrap text-xs">{row.recipient}</TableCell>
                          <TableCell className="text-xs max-w-md break-words">
                            {row.text}
                            <div className="text-muted-foreground mt-0.5">{row.ruleIds.join(", ")}</div>
                          </TableCell>
                          <TableCell className="text-xs whitespace-nowrap">
                            <Badge variant={STATUS_VARIANT[row.status] ?? "outline"}>{row.status}</Badge>
                            {(row.lastHttpStatus || row.error) && (
                              <div className="text-muted-foreground mt-0.5">
                                {row.lastHttpStatus ? `HTTP ${row.lastHttpStatus}` : ""}
                                {row.error && row.status !== "sent" ? ` ${row.error}` : ""}
                                {row.attempts > 1 ? ` · ${row.attempts} tries` : ""}
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </PageLayout>
  );
}
