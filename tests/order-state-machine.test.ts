import { describe, it, expect } from 'vitest';
import { OrderStateMachine, InvalidStateTransitionError } from '@/lib/orders/state-machine';

describe('Order State Machine', () => {
  it('allows standard happy-path lifecycle transitions', () => {
    expect(OrderStateMachine.canTransition('RECEIVED', 'CONFIGURING')).toBe(true);
    expect(OrderStateMachine.canTransition('CONFIGURING', 'AWAITING_PAYMENT')).toBe(true);
    expect(OrderStateMachine.canTransition('AWAITING_PAYMENT', 'PAID')).toBe(true);
    expect(OrderStateMachine.canTransition('PAID', 'QUEUED')).toBe(true);
    expect(OrderStateMachine.canTransition('QUEUED', 'PRINTING')).toBe(true);
    expect(OrderStateMachine.canTransition('PRINTING', 'COMPLETED')).toBe(true);
  });

  it('allows offline printer queueing: PAID -> QUEUED -> WAITING_FOR_PRINTER -> PRINTING', () => {
    expect(OrderStateMachine.canTransition('PAID', 'WAITING_FOR_PRINTER')).toBe(true);
    expect(OrderStateMachine.canTransition('QUEUED', 'WAITING_FOR_PRINTER')).toBe(true);
    expect(OrderStateMachine.canTransition('WAITING_FOR_PRINTER', 'PRINTING')).toBe(true);
  });

  it('allows cancellation from pre-print states', () => {
    expect(OrderStateMachine.canTransition('RECEIVED', 'CANCELLED')).toBe(true);
    expect(OrderStateMachine.canTransition('CONFIGURING', 'CANCELLED')).toBe(true);
    expect(OrderStateMachine.canTransition('AWAITING_PAYMENT', 'CANCELLED')).toBe(true);
    expect(OrderStateMachine.canTransition('QUEUED', 'CANCELLED')).toBe(true);
  });

  it('allows retry from FAILED state', () => {
    expect(OrderStateMachine.canTransition('PRINTING', 'FAILED')).toBe(true);
    expect(OrderStateMachine.canTransition('FAILED', 'QUEUED')).toBe(true);
  });

  it('rejects illegal status jumps', () => {
    // Cannot jump from RECEIVED directly to PRINTING
    expect(OrderStateMachine.canTransition('RECEIVED', 'PRINTING')).toBe(false);
    expect(() => OrderStateMachine.validateTransition('RECEIVED', 'PRINTING')).toThrowError(
      InvalidStateTransitionError
    );

    // Cannot jump from AWAITING_PAYMENT directly to COMPLETED
    expect(OrderStateMachine.canTransition('AWAITING_PAYMENT', 'COMPLETED')).toBe(false);
    expect(() => OrderStateMachine.validateTransition('AWAITING_PAYMENT', 'COMPLETED')).toThrowError(
      InvalidStateTransitionError
    );

    // Terminal states cannot transition to anything
    expect(OrderStateMachine.isTerminal('COMPLETED')).toBe(true);
    expect(OrderStateMachine.canTransition('COMPLETED', 'PRINTING')).toBe(false);
    expect(() => OrderStateMachine.validateTransition('COMPLETED', 'PRINTING')).toThrowError(
      InvalidStateTransitionError
    );

    expect(OrderStateMachine.isTerminal('CANCELLED')).toBe(true);
    expect(OrderStateMachine.canTransition('CANCELLED', 'QUEUED')).toBe(false);
  });
});
