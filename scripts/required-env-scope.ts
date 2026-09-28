/**
 * Whether the build must prove every required environment variable is
 * set. The required settings exist only for the Production environment
 * on Vercel, so a Preview build (every pull request) would always fail
 * the check without saying anything useful. Production builds are
 * checked, and so is a local run of the script (VERCEL_ENV unset).
 */
export function requiredEnvCheckApplies(vercelEnv: string | undefined): boolean {
  const value = vercelEnv?.trim();
  return !value || value === "production";
}
