import { Link, useLocation } from "wouter";
import { Home, Users, User, BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "Today", icon: Home },
  { href: "/waitlist", label: "Waitlist", icon: Users },
  { href: "/insights", label: "Insights", icon: BarChart3 },
];

export function TopNav() {
  const [location] = useLocation();

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

        <div className="flex items-center gap-2 text-xs text-muted-foreground border-l pl-4 ml-2" data-testid="status-demo-mode">
          <span className="hidden md:inline">Demo Mode</span>
          <div className="h-2 w-2 rounded-full bg-green-500" />
        </div>
      </div>
    </header>
  );
}
