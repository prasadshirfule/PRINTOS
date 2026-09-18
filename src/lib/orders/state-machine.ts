import { OrderStatus } from '@/types/printos';

export class InvalidStateTransitionError extends Error {
  constructor(public readonly from: OrderStatus, public readonly to: OrderStatus, reason?: string) {
    super(
      `Invalid order state transition from "${from}" to "${to}"${reason ? `: ${reason}` : '.'}`
    );
    this.name = 'InvalidStateTransitionError';
  }
}

/**
 * Valid state transitions for a Print Order.
 * Enforces business rules and prevents illegal status jumps.
 */
const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  RECEIVED: ['CONFIGURING', 'CANCELLED', 'FAILED'],
  CONFIGURING: ['AWAITING_PAYMENT', 'CANCELLED', 'FAILED'],
  AWAITING_PAYMENT: ['PAID', 'CANCELLED', 'FAILED', 'EXPIRED'],
  PAID: ['QUEUED', 'WAITING_FOR_PRINTER', 'FAILED', 'CANCELLED'],
  QUEUED: ['WAITING_FOR_PRINTER', 'PRINTING', 'FAILED', 'CANCELLED'],
  WAITING_FOR_PRINTER: ['PRINTING', 'QUEUED', 'FAILED', 'CANCELLED'],
  PRINTING: ['COMPLETED', 'FAILED'],
  COMPLETED: [], // Terminal state
  FAILED: ['QUEUED', 'CANCELLED', 'REFUND_PENDING'], // Can be manually retried or refunded
  CANCELLED: [], // Terminal state
  EXPIRED: ['QUEUED', 'REFUND_PENDING', 'CANCELLED'], // Late payment resurrection or refund
  REFUND_PENDING: ['CANCELLED', 'FAILED', 'COMPLETED'],
};

export class OrderStateMachine {
  /**
   * Checks whether a state transition from `from` to `to` is legally permitted.
   */
  public static canTransition(from: OrderStatus, to: OrderStatus): boolean {
    const allowed = VALID_TRANSITIONS[from];
    return Array.isArray(allowed) && allowed.includes(to);
  }

  /**
   * Validates a transition and throws an error if it is not permitted.
   */
  public static validateTransition(from: OrderStatus, to: OrderStatus): void {
    if (from === to) {
      // No-op transition is allowed
      return;
    }

    if (!this.canTransition(from, to)) {
      throw new InvalidStateTransitionError(from, to);
    }
  }

  /**
   * Returns all allowed next states for a given current state.
   */
  public static getAllowedNextStates(current: OrderStatus): OrderStatus[] {
    return VALID_TRANSITIONS[current] || [];
  }

  /**
   * Checks whether a given status is terminal (cannot transition further).
   */
  public static isTerminal(status: OrderStatus): boolean {
    return (VALID_TRANSITIONS[status] || []).length === 0;
  }
}
