import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DataSourceProvider } from "@/lib/data-source-context";
import Home from "@/pages/home";
import Waitlist from "@/pages/waitlist";
import ContactDetail from "@/pages/contact-detail";
import Insights from "@/pages/insights";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/waitlist" component={Waitlist} />
      <Route path="/contact/:name" component={ContactDetail} />
      <Route path="/insights" component={Insights} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <DataSourceProvider>
          <Toaster />
          <Router />
        </DataSourceProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
