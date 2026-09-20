import { ProductionEnvValidator } from '@/lib/config/env-validator';

/** Fail the process during boot instead of exposing a partially configured production app. */
export async function register(): Promise<void> {
  ProductionEnvValidator.assertProductionEnv();
}
