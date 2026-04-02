import { Link, useLocation } from "wouter";
import { Home, Users, BarChart3, UserCheck, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { UserMenu } from "./user-menu";

const navItems = [
  { href: "/", label: "Today", icon: Home },
  { href: "/waitlist", label: "Waitlist", icon: Users },
  { href: "/insights", label: "Insights", icon: BarChart3 },
  { href: "/providers", label: "Providers", icon: UserCheck, beta: true },
  { href: "/submissions", label: "Submissions", icon: FileText },
];

export function TopNav() {
  const [location] = useLocation();

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-14 items-center px-6 gap-6">
        <Link href="/" className="flex items-center" data-testid="link-logo">
          <img
            src="/tfc-logo.jpg"
            alt="The Family Connection"
            className="h-9 w-auto"
          />
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

        <div className="flex items-center border-l pl-4 ml-2">
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
