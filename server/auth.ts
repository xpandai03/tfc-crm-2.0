import passport from "passport";
import { Strategy as OpenIDConnectStrategy } from "passport-openidconnect";
import type { Express, Request, Response, NextFunction } from "express";
import session from "express-session";
import MemoryStore from "memorystore";

// User type for session
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  tenant: string;
}

declare global {
  namespace Express {
    interface User extends AuthUser {}
  }
}

// Environment validation
function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Configure passport with Azure AD OIDC
export function configureAuth(app: Express): void {
  const clientID = getRequiredEnv("AZURE_AD_CLIENT_ID");
  const clientSecret = getRequiredEnv("AZURE_AD_CLIENT_SECRET");
  const tenantID = getRequiredEnv("AZURE_AD_TENANT_ID");
  const sessionSecret = getRequiredEnv("SESSION_SECRET");

  const isProduction = process.env.NODE_ENV === "production";

  // Determine callback URL based on environment
  const callbackHost = isProduction
    ? "https://tfc-crm-2026.fly.dev"
    : "http://localhost:3000";

  // Session store
  const MemoryStoreSession = MemoryStore(session);

  // Session configuration
  app.use(
    session({
      name: "tfc.sid",
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      store: new MemoryStoreSession({
        checkPeriod: 86400000, // prune expired entries every 24h
      }),
      cookie: {
        httpOnly: true,
        secure: isProduction,
        sameSite: "lax",
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
      },
    })
  );

  // Initialize Passport
  app.use(passport.initialize());
  app.use(passport.session());

  // Serialize user to session
  passport.serializeUser((user: AuthUser, done) => {
    done(null, user);
  });

  // Deserialize user from session
  passport.deserializeUser((user: AuthUser, done) => {
    done(null, user);
  });

  // Configure Azure AD OIDC Strategy
  passport.use(
    "azure-ad",
    new OpenIDConnectStrategy(
      {
        issuer: `https://login.microsoftonline.com/${tenantID}/v2.0`,
        authorizationURL: `https://login.microsoftonline.com/${tenantID}/oauth2/v2.0/authorize`,
        tokenURL: `https://login.microsoftonline.com/${tenantID}/oauth2/v2.0/token`,
        userInfoURL: "https://graph.microsoft.com/oidc/userinfo",
        clientID,
        clientSecret,
        callbackURL: `${callbackHost}/auth/callback`,
        scope: ["openid", "profile", "email"],
      },
      (
        issuer: string,
        profile: any,
        done: (err: any, user?: AuthUser | false) => void
      ) => {
        // Extract user info from profile
        const user: AuthUser = {
          id: profile.id || profile._json?.oid || profile._json?.sub,
          email:
            profile._json?.preferred_username ||
            profile._json?.email ||
            profile.emails?.[0]?.value ||
            "",
          name: profile.displayName || profile._json?.name || "",
          tenant: tenantID,
        };

        // Validate tenant (defense in depth - Azure AD app is already single-tenant)
        if (!user.email) {
          return done(new Error("No email found in profile"));
        }

        // Optional: validate email domain
        const allowedDomains = ["tfc.help", "thefamilyconnection.org"];
        const emailDomain = user.email.split("@")[1]?.toLowerCase();
        if (emailDomain && !allowedDomains.includes(emailDomain)) {
          return done(
            new Error(`Access denied: ${emailDomain} is not an authorized domain`)
          );
        }

        return done(null, user);
      }
    )
  );

  // Auth routes
  setupAuthRoutes(app);
}

// Setup authentication routes
function setupAuthRoutes(app: Express): void {
  // Login route - initiates OIDC flow
  app.get("/auth/login", passport.authenticate("azure-ad"));

  // Callback route - handles Microsoft redirect
  app.get(
    "/auth/callback",
    passport.authenticate("azure-ad", {
      failureRedirect: "/auth/login?error=auth_failed",
    }),
    (req: Request, res: Response) => {
      // Successful authentication
      res.redirect("/");
    }
  );

  // Logout route
  app.get("/auth/logout", (req: Request, res: Response) => {
    const tenantID = process.env.AZURE_AD_TENANT_ID;
    const isProduction = process.env.NODE_ENV === "production";
    const postLogoutRedirect = isProduction
      ? "https://tfc-crm-2026.fly.dev/auth/login"
      : "http://localhost:3000/auth/login";

    req.logout((err) => {
      if (err) {
        console.error("Logout error:", err);
      }
      req.session.destroy((err) => {
        if (err) {
          console.error("Session destroy error:", err);
        }
        // Redirect to Azure AD logout to fully sign out
        const azureLogoutUrl = `https://login.microsoftonline.com/${tenantID}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(postLogoutRedirect)}`;
        res.redirect(azureLogoutUrl);
      });
    });
  });

  // Current user endpoint
  app.get("/api/me", (req: Request, res: Response) => {
    if (req.isAuthenticated() && req.user) {
      res.json({
        id: req.user.id,
        email: req.user.email,
        name: req.user.name,
        tenant: req.user.tenant,
      });
    } else {
      res.status(401).json({ error: "Unauthorized", message: "Not authenticated" });
    }
  });
}

// Middleware to require authentication
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.isAuthenticated()) {
    return next();
  }

  // Check if this is an API request
  if (req.path.startsWith("/api/")) {
    res.status(401).json({ error: "Unauthorized", message: "Authentication required" });
    return;
  }

  // For page requests, redirect to login
  res.redirect("/auth/login");
}

// Middleware to skip auth for specific paths
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Paths that don't require authentication
  const publicPaths = [
    "/auth/login",
    "/auth/callback",
    "/auth/logout",
    "/api/me", // This handles its own auth check
  ];

  // Check if path starts with any public path
  const isPublicPath = publicPaths.some(
    (path) => req.path === path || req.path.startsWith(path + "?")
  );

  if (isPublicPath) {
    return next();
  }

  // All other paths require authentication
  requireAuth(req, res, next);
}
