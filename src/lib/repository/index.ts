import { IPrintOSRepository } from './repository.interface';
import { InMemoryPrintOSRepository } from './in-memory-repository';
import { SupabasePrintOSRepository } from './supabase-repository';

let currentRepository: IPrintOSRepository | null = null;

/**
 * Returns the active PrintOS persistence repository.
 * If Supabase environment credentials are present, returns the production SupabasePrintOSRepository.
 * Otherwise returns the in-memory repository (for isolated unit tests and local mock dev).
 */
export function getRepository(): IPrintOSRepository {
  if (currentRepository) {
    return currentRepository;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (supabaseUrl && serviceRoleKey && !supabaseUrl.includes('your-supabase-project')) {
    currentRepository = new SupabasePrintOSRepository(supabaseUrl, serviceRoleKey);
  } else {
    currentRepository = new InMemoryPrintOSRepository();
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