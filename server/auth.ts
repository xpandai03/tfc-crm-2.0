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

  // IMPORTANT: Trust proxy must be set BEFORE session middleware
  // This is required for secure cookies to work behind Fly's proxy
  if (isProduction) {
    app.set("trust proxy", 1);
  }

  // Determine callback URL based on environment
  const callbackHost = isProduction
    ? "https://tfc-crm-2026.fly.dev"
    : "http://localhost:3000";

  // Session store
  const MemoryStoreSession = MemoryStore(session);

  // Session configuration
  // Note: saveUninitialized must be true for OIDC state to be saved before redirect
  app.use(
    session({
      name: "tfc.sid",
      secret: sessionSecret,
      resave: true,  // Required for session state persistence
      saveUninitialized: true,  // Required for OIDC state storage before auth
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

  const callbackURL = `${callbackHost}/auth/callback`;
  console.log("[AUTH] Configuring OIDC with:");
  console.log("[AUTH]   Issuer:", `https://login.microsoftonline.com/${tenantID}/v2.0`);
  console.log("[AUTH]   Client ID:", clientID);
  console.log("[AUTH]   Callback URL:", callbackURL);

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
        callbackURL,
        scope: ["openid", "profile", "email"],
      },
      (
        issuer: string,
        profile: any,
        context: any,
        idToken: any,
        accessToken: any,
        refreshToken: any,
        done: (err: any, user?: AuthUser | false) => void
      ) => {
        try {
          console.log("[AUTH] Verify callback invoked");
          console.log("[AUTH]   Issuer:", issuer);
          console.log("[AUTH]   Profile:", JSON.stringify(profile, null, 2));
          console.log("[AUTH]   Profile._json:", JSON.stringify(profile?._json, null, 2));
          console.log("[AUTH]   ID Token (first 50 chars):", idToken?.substring(0, 50));
          console.log("[AUTH]   Access Token exists:", !!accessToken);

          // Extract claims from profile._json (Azure AD specific)
          const claims = profile?._json || {};

          const user: AuthUser = {
            id: claims.oid || claims.sub || profile?.id || "",
            email: claims.preferred_username || claims.email || profile?.emails?.[0]?.value || "",
            name: claims.name || profile?.displayName || "",
            tenant: claims.tid || tenantID,
          };

          console.log("[AUTH]   Extracted user:", JSON.stringify(user, null, 2));

          // Validate we got an email
          if (!user.email) {
            console.error("[AUTH] ERROR: No email found in profile");
            return done(new Error("No email found in profile"));
          }

          // Validate email domain
          const allowedDomains = ["tfc.help", "thefamilyconnection.org", "tfc.health"];
          const emailDomain = user.email.split("@")[1]?.toLowerCase();
          console.log("[AUTH]   Email domain:", emailDomain);

          if (emailDomain && !allowedDomains.includes(emailDomain)) {
            console.error("[AUTH] ERROR: Domain not allowed:", emailDomain);
            return done(new Error(`Access denied: ${emailDomain} is not an authorized domain`));
          }

          console.log("[AUTH] SUCCESS: User authenticated");
          return done(null, user);
        } catch (err) {
          console.error("[AUTH] EXCEPTION in verify callback:", err);
          return done(err);
        }
      }
    )
  );

  // Auth routes
  setupAuthRoutes(app);
}

// Setup authentication routes
function setupAuthRoutes(app: Express): void {
  // Login route - initiates OIDC flow
  app.get("/auth/login", (req: Request, res: Response, next: NextFunction) => {
    console.log("[AUTH] Login route hit");
    console.log("[AUTH]   Session ID:", req.sessionID);
    console.log("[AUTH]   Session exists:", !!req.session);
    console.log("[AUTH]   Cookies:", req.headers.cookie);

    // Force session save before passport
    req.session.save((err) => {
      if (err) {
        console.error("[AUTH]   Session save error:", err);
      }
      console.log("[AUTH]   Session saved, ID:", req.sessionID);
      passport.authenticate("azure-ad")(req, res, next);
    });
  });

  // Callback route - handles Microsoft redirect
  app.get(
    "/auth/callback",
    (req: Request, res: Response, next: NextFunction) => {
      console.log("[AUTH] Callback received");
      console.log("[AUTH]   Session ID:", req.sessionID);
      console.log("[AUTH]   Session exists:", !!req.session);
      console.log("[AUTH]   Cookies:", req.headers.cookie);
      console.log("[AUTH]   OIDC state in session:", JSON.stringify((req.session as any)["openidconnect:azure-ad"], null, 2));
      console.log("[AUTH]   Full URL:", req.url);
      console.log("[AUTH]   Query params:", JSON.stringify(req.query, null, 2));

      // Check if Azure returned an error directly
      if (req.query.error) {
        console.error("[AUTH] Azure AD returned error:");
        console.error("[AUTH]   error:", req.query.error);
        console.error("[AUTH]   error_description:", req.query.error_description);
        console.error("[AUTH]   error_uri:", req.query.error_uri);
      }

      // Check for authorization code
      if (req.query.code) {
        console.log("[AUTH]   Authorization code received (first 20 chars):", (req.query.code as string).substring(0, 20));
      }

      passport.authenticate("azure-ad", (err: any, user: any, info: any) => {
        console.log("[AUTH] Passport authenticate result:");
        console.log("[AUTH]   Error:", err);
        console.log("[AUTH]   User:", user);
        console.log("[AUTH]   Info:", info);

        if (err) {
          console.error("[AUTH] Authentication error:", err);
          return res.redirect("/auth/login?error=auth_failed&reason=" + encodeURIComponent(err.message || "unknown"));
        }

        if (!user) {
          console.error("[AUTH] No user returned from authentication");
          return res.redirect("/auth/login?error=auth_failed&reason=no_user");
        }

        req.logIn(user, (loginErr) => {
          if (loginErr) {
            console.error("[AUTH] Login error:", loginErr);
            return res.redirect("/auth/login?error=auth_failed&reason=" + encodeURIComponent(loginErr.message || "login_failed"));
          }

          console.log("[AUTH] User logged in successfully:", user.email);
          return res.redirect("/");
        });
      })(req, res, next);
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
    "/api/sync/contacts", // n8n sync endpoint (uses X-Sync-Key auth)
  ];

  // Public assets that must be accessible without auth (e.g., for email templates)
  // These are served to external clients like email apps
  const publicAssets = [
    "/tfc-logo.jpg",      // Logo used in email templates
    "/favicon.png",
    "/favicon.svg",
  ];

  // Check if path is a public asset (exact match)
  if (publicAssets.includes(req.path)) {
    return next();
  }

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
