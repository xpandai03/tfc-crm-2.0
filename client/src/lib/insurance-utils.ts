/**
 * Insurance Utilities — barrel re-export.
 *
 * The canonical implementation was lifted to `shared/insurance-utils.ts` so the
 * server (referral report builder) can call the SAME normalizer as the client,
 * with byte-identical logic. This file is a thin re-export so every existing
 * client import (`@/lib/insurance-utils` / `./insurance-utils`) keeps working
 * unchanged — zero behavior change.
 *
 * New code (client or server) should import from `@shared/insurance-utils`.
 */
export * from "@shared/insurance-utils";
