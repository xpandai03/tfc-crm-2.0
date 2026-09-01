import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile } from "fs/promises";
import path from "path";
import { assertSurveyBundleClean } from "./assert-survey-bundle";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "axios",
  // better-sqlite3 is excluded - native modules must remain external
  "connect-pg-simple",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "fflate",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "node-cron",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "pg",
  "resend",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  // The PUBLIC survey bundle. Must run AFTER the client build: the client's
  // config sets emptyOutDir on dist/public, so building the survey first would
  // have it deleted. vite.survey.config.ts sets emptyOutDir: false for the same
  // reason.
  console.log("building public survey bundle...");
  await viteBuild({
    configFile: path.resolve(process.cwd(), "vite.survey.config.ts"),
  });

  // Gate: the public bundle must not contain staff data. Checked against the
  // EMITTED output, not the source, because a bundler inlines transitive
  // imports. Throws — and therefore fails the build — on any hit.
  await assertSurveyBundleClean();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
