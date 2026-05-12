import { Switch, Route, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DataSourceProvider } from "@/lib/data-source-context";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { isRestrictedUser } from "@shared/access-control";
import Home from "@/pages/home";
import Waitlist from "@/pages/waitlist";
import ContactDetail from "@/pages/contact-detail";
import Insights from "@/pages/insights";
import Providers from "@/pages/providers";
import Submissions from "@/pages/submissions";
import ActivityPage from "@/pages/activity";
import AdminMigrate from "@/pages/admin-migrate";
import Referral from "@/pages/referral";
import Login from "@/pages/login";
import NotFound from "@/pages/not-found";

function GuardedHome() {
  const { user } = useAuth();
  if (isRestrictedUser(user?.email)) {
    return <Redirect to="/waitlist" />;
  }
  return <Home />;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={GuardedHome} />
      <Route path="/waitlist" component={Waitlist} />
      <Route path="/contact/:id" component={ContactDetail} />
      <Route path="/insights" component={Insights} />
      <Route path="/providers" component={Providers} />
      <Route path="/submissions" component={Submissions} />
      <Route path="/activity" component={ActivityPage} />
      <Route path="/admin/migrate" component={AdminMigrate} />
      <Route path="/referral" component={Referral} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AuthenticatedApp() {
  const { isAuthenticated, isLoading } = useAuth();

  // Show loading state while checking auth
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-primary-foreground font-semibold">
            TFC
          </div>
          <div className="h-1 w-24 bg-muted rounded-full overflow-hidden">
            <div className="h-full w-1/2 bg-primary animate-pulse rounded-full" />
          </div>
        </div>
      </div>
    );
  }

  // Show login page if not authenticated
  if (!isAuthenticated) {
    return <Login />;
  }

  // Show the main app if authenticated
  return (
    <DataSourceProvider>
      <Toaster />
      <Router />
    </DataSourceProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <AuthenticatedApp />
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
