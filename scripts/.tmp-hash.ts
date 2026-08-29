import { readFileSync } from "fs";
import { createHash } from "crypto";
import { pivotDashboard } from "../server/dashboard/db";
const rows = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const pop of ["active","all"] as const) {
  const s: any = pivotDashboard(rows, pop, 0); s.generatedAt = "FIXED";
  console.log(pop, createHash("sha256").update(JSON.stringify(s)).digest("hex"));
}
