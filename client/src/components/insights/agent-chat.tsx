/**
 * Insights AI Reporting Agent — chat view.
 *
 * Ephemeral, single-page chat (React state only — nothing persisted). Sends the
 * capped message history to POST /api/insights/agent, renders server-composed
 * answers, and for report answers offers an Excel download that reuses the
 * EXISTING /api/export/referrals.xlsx route with the validated params.
 *
 * Scroll: plain native overflow-y-auto (NOT Radix ScrollArea — the codebase's
 * proven pattern for dialogs/panels).
 */
import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { ArrowLeft, Send, Loader2, Download, Sparkles } from "lucide-react";

interface ReferralParams {
  from: string;
  to: string;
  serviceType?: string | null;
  modality?: string | null;
  insurance?: string | null;
  statusCode?: number | null;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  kind?: "report" | "reply";
  params?: ReferralParams | null;
}

const EXAMPLES = [
  "How many referrals did we get this month?",
  "Show me telehealth referrals with BCBS Commercial in Q2",
  "Referrals ready to schedule (status 200) in the last 30 days",
];

export function AgentChat({ onBack }: { onBack: () => void }) {
  const { toast } = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || loading) return;
    const next: ChatMessage[] = [...messages, { role: "user", content: q }];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      // Send only role/content, last 12 (server also caps at 12).
      const payload = next.slice(-12).map((m) => ({ role: m.role, content: m.content }));
      const res = await fetch("/api/insights/agent", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: payload }),
      });
      if (!res.ok) {
        let msg = `The assistant hit an error (${res.status}).`;
        if (res.status === 403) msg = "You don't have access to the reporting assistant.";
        else if (res.status === 401) msg = "Your session has expired — please sign in again.";
        else {
          try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* non-JSON */ }
        }
        setMessages((m) => [...m, { role: "assistant", content: msg, kind: "reply" }]);
        return;
      }
      const data = await res.json();
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: typeof data.text === "string" ? data.text : "",
          kind: data.type === "report" ? "report" : "reply",
          params: data.type === "report" ? (data.params as ReferralParams) : null,
        },
      ]);
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: "Something went wrong — please try again.", kind: "reply" }]);
    } finally {
      setLoading(false);
    }
  }

  async function downloadExcel(params: ReferralParams) {
    if (downloading) return;
    setDownloading(true);
    try {
      const qs = new URLSearchParams();
      qs.set("from", params.from);
      qs.set("to", params.to);
      if (params.serviceType) qs.set("service_type", params.serviceType);
      if (params.modality) qs.set("modality", params.modality);
      if (params.insurance) qs.set("insurance", params.insurance);
      if (params.statusCode != null) qs.set("status_code", String(params.statusCode));
      // Agent path is de-identified: include_identifiers is never sent.
      const res = await fetch(`/api/export/referrals.xlsx?${qs.toString()}`, { credentials: "include", cache: "no-store" });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const filename = `referrals-${params.from}-to-${params.to}.xlsx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ title: "Excel downloaded", description: filename });
    } catch (err) {
      toast({ title: "Download failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-160px)] min-h-[460px] rounded-xl border border-border bg-card" data-testid="insights-agent-chat">
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="font-medium text-sm">Reporting Assistant</span>
        </div>
        <Button variant="ghost" size="sm" onClick={onBack} data-testid="button-agent-back">
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back to Insights
        </Button>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 ? (
          <div className="text-sm text-muted-foreground space-y-3">
            <p>Ask about referrals and I'll build a report (with an Excel download). Try:</p>
            <div className="flex flex-col gap-2 items-start">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => send(ex)}
                  className="text-left text-xs rounded-full border border-border px-3 py-1.5 hover:bg-muted transition-colors"
                  data-testid="chip-example"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[80%] rounded-2xl px-3.5 py-2 text-sm",
                  m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
                )}
              >
                <p className="whitespace-pre-wrap">{m.content}</p>
                {m.kind === "report" && m.params && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="mt-2"
                    disabled={downloading}
                    onClick={() => downloadExcel(m.params!)}
                    data-testid="button-agent-download"
                  >
                    {downloading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1.5" />}
                    Download Excel
                  </Button>
                )}
              </div>
            </div>
          ))
        )}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-muted rounded-2xl px-3.5 py-2 text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Thinking…
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-border p-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex items-center gap-2"
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about referrals…"
            disabled={loading}
            autoFocus
            data-testid="input-agent-message"
          />
          <Button type="submit" size="icon" disabled={loading || !input.trim()} data-testid="button-agent-send">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </form>
      </div>
    </div>
  );
}
