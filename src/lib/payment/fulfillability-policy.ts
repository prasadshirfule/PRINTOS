import { PrintOrder } from '@/types/printos';
import { IPrintOSRepository } from '@/lib/repository';
import { FulfillabilityAssessment } from '@/types/payment';

export class FulfillabilityPolicy {
  /**
   * Pure domain evaluation to determine whether an expired/late-paid order
   * can safely be resurrected into the print queue.
   */
  public static async isOrderFulfillable(
    order: PrintOrder,
    repo: IPrintOSRepository
  ): Promise<FulfillabilityAssessment> {
    // 1. Terminal states cannot be reactivated
    if (order.status === 'COMPLETED' || order.status === 'CANCELLED') {
      return {
        fulfillable: false,
        reason: 'CAPABILITY_MISMATCH',
      };
    }

    // 2. Validate document availability
    if (!order.storagePath || order.storagePath.trim() === '') {
      return {
        fulfillable: false,
        reason: 'FILE_EXPIRED',
      };
    }

    // 3. Hardware / Printer Capability Check
    // Query active printers to ensure at least one printer can handle this job
    const printers = await repo.listPrinters();
    const onlinePrinters = printers.filter((p) => p.isActive && (p.status === 'ONLINE' || p.status === 'BUSY'));

    if (onlinePrinters.length === 0) {
      return {
        fulfillable: false,
        reason: 'HARDWARE_OFFLINE',
      };
    }

    // Check if any active printer supports required color mode, paper size, and duplexing
    const capablePrinter = onlinePrinters.find((printer) => {
      const supportsColor = order.colorMode === 'BW' || printer.supportsColor;
      const supportsPaper = printer.supportedPaperSizes.includes(order.paperSize);
      const supportsDuplex = order.printSides === 'ONE_SIDED' || printer.supportsDuplex;
      return supportsColor && supportsPaper && supportsDuplex;
    });

    if (!capablePrinter) {
      return {
        fulfillable: false,
        reason: 'CAPABILITY_MISMATCH',
      };
    }

    return {
      fulfillable: true,
      reason: 'OK',
    };
  }
}
