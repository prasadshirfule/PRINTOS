import { IPrintOSRepository } from '@/lib/repository';
import { LocalStorageService } from './storage-service';
import { createClient } from '@supabase/supabase-js';

export interface CleanupResult {
  purgedFilesCount: number;
  processedOrdersCount: number;
  purgedInboxCount: number;
  errors: string[];
}

export class CleanupService {
  /**
   * Cleans up expired document storage files and purged orders past the retention period
   */
  public static async runRetentionCleanup(
    repo: IPrintOSRepository,
    retentionHours = 24
  ): Promise<CleanupResult> {
    const result: CleanupResult = {
      purgedFilesCount: 0,
      processedOrdersCount: 0,
      purgedInboxCount: 0,
      errors: [],
    };

    const cutoffTime = new Date(Date.now() - retentionHours * 3600 * 1000).toISOString();
    const localStorage = new LocalStorageService();

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const hasSupabase =
      Boolean(supabaseUrl && serviceRoleKey) &&
      !supabaseUrl?.includes('your-supabase-project');

    let supabase: any = null;
    if (hasSupabase) {
      supabase = createClient(supabaseUrl!, serviceRoleKey!, {
        auth: { persistSession: false },
      });
    }

    try {
      // 1. Fetch orders in terminal states (COMPLETED, FAILED, CANCELLED, EXPIRED)
      const terminalStatuses = ['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'] as const;
      const allOrders = await repo.listOrders({ limit: 500 });

      const eligibleOrders = allOrders.filter((order) => {
        const isTerminal = terminalStatuses.includes(order.status as any);
        const isOld = order.createdAt <= cutoffTime;
        return isTerminal && isOld;
      });

      for (const order of eligibleOrders) {
        result.processedOrdersCount++;
        try {
          if (order.storagePath) {
            // Attempt storage deletion
            if (supabase) {
              await supabase.storage.from('print-documents').remove([order.storagePath]);
            } else {
              await localStorage.deleteDocument(order.storagePath);
            }

            result.purgedFilesCount++;
            await repo.recordOrderEvent(
              order.id,
              'DOCUMENT_PURGED',
              `Document purged after ${retentionHours}h retention policy cutoff (${order.storagePath})`,
              { retentionHours, cutoffTime }
            );
          }
        } catch (err: unknown) {
          const msg = `Failed to purge document for order ${order.id}: ${err instanceof Error ? err.message : String(err)}`;
          result.errors.push(msg);
        }
      }
    } catch (err: unknown) {
      result.errors.push(`Cleanup cycle error: ${err instanceof Error ? err.message : String(err)}`);
    }

    return result;
  }
}
