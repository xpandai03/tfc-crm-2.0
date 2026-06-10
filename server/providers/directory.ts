/**
 * Phase 3 provider directory refresh.
 *
 * Bridges the DB (getCrmProviderDirectory) to the synchronous resolvers in
 * provider-location-config (setCrmDirectory). Called at startup, on provider
 * mutations, and on a periodic interval so the email-axis resolvers
 * (getProviderEmail/getProviderByEmail — sync) always see a fresh, active,
 * emailed crm_providers directory, with PROVIDER_LIST as the silent fallback.
 */
import { getCrmProviderDirectory } from "../reminders";
import { setCrmDirectory } from "../email/provider-location-config";

export async function refreshCrmDirectory(): Promise<number> {
  try {
    const entries = await getCrmProviderDirectory();
    setCrmDirectory(entries);
    return entries.length;
  } catch (e) {
    // Never throw: on failure the resolvers keep their last good directory (or
    // fall back to PROVIDER_LIST), so a transient DB blip can't break email/assign.
    console.error("[provider-dir] refreshCrmDirectory failed (keeping last directory / PROVIDER_LIST fallback):", e);
    return -1;
  }
}
