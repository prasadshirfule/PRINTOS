import { IPrintOSRepository } from './repository.interface';
import { InMemoryPrintOSRepository } from './in-memory-repository';
import { SupabasePrintOSRepository } from './supabase-repository';

let currentRepository: IPrintOSRepository | null = null;

/**
 * Returns the active PrintOS persistence repository.
 *
 * PRODUCTION FAIL-FAST INVARIANT:
 * In production (NODE_ENV === 'production'), if valid Supabase credentials are not configured,
 * an explicit Error is thrown immediately. Never silently fall back to in-memory storage in production.
 *
 * In development / testing (NODE_ENV !== 'production'), falls back to InMemoryPrintOSRepository
 * when Supabase credentials are not present.
 */
export function getRepository(): IPrintOSRepository {
  if (currentRepository) {
    return currentRepository;
  }

  const isProduction = process.env.NODE_ENV === 'production';
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const hasValidSupabase =
    Boolean(supabaseUrl && serviceRoleKey) &&
    !supabaseUrl?.includes('your-supabase-project') &&
    !serviceRoleKey?.includes('your-service-role-key');

  if (isProduction) {
    if (!hasValidSupabase) {
      throw new Error(
        'CRITICAL CONFIGURATION ERROR: Production environment detected (NODE_ENV=production), ' +
        'but NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing or invalid. ' +
        'In-memory storage fallback is strictly forbidden in production.'
      );
    }
    currentRepository = new SupabasePrintOSRepository(supabaseUrl!, serviceRoleKey!);
  } else {
    if (hasValidSupabase) {
      currentRepository = new SupabasePrintOSRepository(supabaseUrl!, serviceRoleKey!);
    } else {
      currentRepository = new InMemoryPrintOSRepository();
    }
  }

  return currentRepository;
}

/**
 * Overrides the active repository instance (useful for unit and integration testing).
 */
export function setRepository(repo: IPrintOSRepository | null) {
  currentRepository = repo;
}

export * from './repository.interface';
export * from './in-memory-repository';
export * from './supabase-repository';