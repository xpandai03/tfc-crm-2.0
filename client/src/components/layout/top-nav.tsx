import { Link, useLocation } from "wouter";
import { Home, Users, BarChart3, UserCheck, FileText, FileUp, Activity, MessageCircleQuestion, Mail } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { UserMenu } from "./user-menu";
import { UniversalSearch } from "./universal-search";
import { useAuth } from "@/lib/auth-context";
import { getWaitlistBoard } from "@/lib/api";
import { FeedbackModal } from "@/components/ui/feedback-modal";
import { isRestrictedUser, canAccessReferralUpload, canEditEmailTemplates } from "@shared/access-control";

const allNavItems = [
  { href: "/", label: "Today", icon: Home },
  { href: "/waitlist", label: "Waitlist", icon: Users },
  { href: "/insights", label: "Insights", icon: BarChart3 },
  { href: "/providers", label: "Providers", icon: UserCheck, beta: true },
  { href: "/submissions", label: "Submissions", icon: FileText },
  { href: "/referral", label: "Referrals", icon: FileUp },
  { href: "/email-templates", label: "Templates", icon: Mail },
  { href: "/activity", label: "Activity", icon: Activity },
];

const GATED_HREFS = ["/", "/insights", "/providers"];
// Items only shown when the user passes a positive feature gate (not just
// hidden for restricted users). Keep the gate predicates in sync with the
// allowlists in shared/access-control.ts.
const FEATURE_GATED_HREFS: Record<string, (email: string | null | undefined) => boolean> = {
  "/referral": canAccessReferralUpload,
  "/email-templates": canEditEmailTemplates,
};

export function TopNav() {
  const [location] = useLocation();
  const { user } = useAuth();
  const [showFeedback, setShowFeedback] = useState(false);
  const restricted = isRestrictedUser(user?.email);

  // Data for universal search. Same query keys as the Waitlist / Providers
  // pages so React Query dedupes — no extra fetch on pages that already
  // load this data. Restricted users can't reach /providers, so they get
  // an empty providers list (contacts-only search).
  const { data: boardData } = useQuery({
    queryKey: ["/api/get-waitlist-board"],
    queryFn: getWaitlistBoard,
  });
  const { data: providersData } = useQuery({
    queryKey: ["/api/providers"],
    queryFn: async () => {
      const res = await fetch("/api/providers");
      if (!res.ok) throw new Error("Failed to load providers");
      return res.json();
    },
  });
  const searchContacts = boardData?.contacts ?? [];
  const searchProviders = restricted ? [] : (providersData?.providers ?? []);

  const navItems = allNavItems.filter((item) => {
    if (restricted && GATED_HREFS.includes(item.href)) return false;
    const gate = FEATURE_GATED_HREFS[item.href];
    if (gate && !gate(user?.email)) return false;
    return true;
  });

  return (
    <header className="sticky top-0 z-50 w-full border-b border-gray-200/60 dark:border-gray-800 bg-white/95 dark:bg-gray-950/95 backdrop-blur-sm shadow-sm">
      <div className="flex h-14 items-center px-6 gap-6">
        <Link href={restricted ? "/waitlist" : "/"} className="flex items-center" data-testid="link-logo">
          <img
            src="/tfc-logo.jpg"
            alt="The Family Connection"
            className="h-9 w-auto"
          />
        </Link>

        <UniversalSearch contacts={searchContacts} providers={searchProviders} />

        <nav className="flex items-center gap-1 ml-auto">
          {navItems.map((item) => {
            const isActive = location === item.href ||
              (item.href !== "/" && location.startsWith(item.href));
            const Icon = item.icon;

            return (
              <Link key={item.href} href={item.href}>
                <span
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md transition-colors",
                    "hover-elevate active-elevate-2",
                    isActive
                      ? "text-foreground bg-muted"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  data-testid={`nav-${item.label.toLowerCase()}`}
                >
                  <Icon className="h-4 w-4" />
                  <span className="hidden sm:inline-block">{item.label}</span>
                  {item.beta && (
                    <span className="hidden sm:inline-block text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400 font-medium">
                      Beta
                    </span>
                  )}
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-2 border-l pl-4 ml-2" data-testid="status-data-mode">
          <div className="flex items-center gap-2 text-xs">
            <div className="h-2 w-2 rounded-full bg-green-500" />
            <span className="text-green-600 dark:text-green-400 font-medium">Live</span>
          </div>
        </div>

        <button
          onClick={() => setShowFeedback(true)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors border-l pl-4 ml-2"
          title="Send feedback or report an issue"
        >
          <MessageCircleQuestion className="h-4 w-4" />
          <span className="hidden sm:inline">Feedback</span>
        </button>

        <div className="flex items-center border-l pl-4 ml-2">
          <UserMenu />
        </div>
      </div>

      <FeedbackModal
        isOpen={showFeedback}
        onClose={() => setShowFeedback(false)}
        userEmail={user?.email || ""}
      />
    </header>
  );
}
