import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";

export default function Login() {
  const [location] = useLocation();

  // Check for error in URL
  const params = new URLSearchParams(window.location.search);
  const error = params.get("error");

  const handleLogin = () => {
    window.location.href = "/auth/login";
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center space-y-4">
          <div className="flex justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-primary text-primary-foreground font-bold text-2xl">
              TFC
            </div>
          </div>
          <div>
            <CardTitle className="text-2xl">The Family Connection</CardTitle>
            <CardDescription className="mt-2">
              CRM Dashboard
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="rounded-md bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
              Authentication failed. Please try again or contact support.
            </div>
          )}

          <Button
            onClick={handleLogin}
            className="w-full h-12 text-base"
            size="lg"
          >
            <svg
              className="mr-2 h-5 w-5"
              viewBox="0 0 21 21"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect x="1" y="1" width="9" height="9" fill="#F25022"/>
              <rect x="11" y="1" width="9" height="9" fill="#7FBA00"/>
              <rect x="1" y="11" width="9" height="9" fill="#00A4EF"/>
              <rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
            </svg>
            Sign in with Microsoft
          </Button>

          <p className="text-xs text-center text-muted-foreground pt-2">
            Access restricted to authorized TFC staff only
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
