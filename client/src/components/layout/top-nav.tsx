import { Link, useLocation } from "wouter";
import { Home, Users, BarChart3, Loader2, Database } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDataSource } from "@/lib/data-source-context";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { UserMenu } from "./user-menu";

const navItems = [
  { href: "/", label: "Today", icon: Home },
  { href: "/waitlist", label: "Waitlist", icon: Users },
  { href: "/insights", label: "Insights", icon: BarChart3 },
];

export function TopNav() {
  const [location] = useLocation();
  const { dataMode, isFallback, isEnablingLive, enableLiveMode, disableLiveMode, isFullyLive } = useDataSource();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleEnableLive = async () => {
    // Pass queryClient to enableLiveMode so it can hydrate cache BEFORE updating state
    const result = await enableLiveMode(queryClient);
    
    if (result.success) {
      toast({
        title: "Live mode enabled",
        description: "Connected to Excel via n8n webhooks",
      });
    } else if (result.partial) {
      toast({
        title: "Partial live data available",
        description: "Aggregate metrics are live, but contact-level data is not. Staying in demo mode.",
        variant: "destructive",
      });
    } else {
      toast({
        title: "Live Excel unavailable",
        description: "Still showing demo data. Check n8n webhook configuration.",
        variant: "destructive",
      });
    }
  };

  const handleDisableLive = () => {
    // Pass queryClient to disableLiveMode so it can clear caches
    disableLiveMode(queryClient);
    toast({
      title: "Switched to demo mode",
      description: "Now showing mock data",
    });
  };

  const getModeIndicator = () => {
    if (isEnablingLive) {
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span className="hidden md:inline">Connecting...</span>
        </div>
      );
    }

    // Show fallback mode when isFallback is true
    if (isFallback && dataMode === "live") {
      return (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-amber-600 dark:text-amber-400 hidden md:inline">
            Fallback mode
          </span>
          <div className="h-2 w-2 rounded-full bg-amber-500" />
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={handleDisableLive}
            data-testid="button-disable-live"
          >
            Use Demo
          </Button>
        </div>
      );
    }

    if (dataMode === "live") {
      return (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-blue-600 dark:text-blue-400 hidden md:inline">
            {isFullyLive ? "Live Excel data" : "Live aggregates"}
          </span>
          <div className="h-2 w-2 rounded-full bg-blue-500" />
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={handleDisableLive}
            data-testid="button-disable-live"
          >
            Use Demo
          </Button>
        </div>
      );
    }

    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground hidden md:inline">Mock data</span>
        <div className="h-2 w-2 rounded-full bg-green-500" />
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
          onClick={handleEnableLive}
          data-testid="button-enable-live"
        >
          <Database className="h-3 w-3 mr-1" />
          Enable Live Excel
        </Button>
      </div>
    );
  };

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-14 items-center px-6 gap-6">
        <Link href="/" className="flex items-center gap-2" data-testid="link-logo">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground font-semibold text-sm">
            TFC
          </div>
          <span className="font-semibold text-foreground hidden sm:inline-block">
            The Family Connection
          </span>
        </Link>

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
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-2 border-l pl-4 ml-2" data-testid="status-data-mode">
          {getModeIndicator()}
        </div>

        <div className="flex items-center border-l pl-4 ml-2">
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
