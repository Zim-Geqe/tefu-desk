import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MissionControl from '../app/mission-control';
import type { Order, Payment } from '../lib/api';

const createdAt = '2026-11-12T06:00:00.000Z';

function order(status: string, payments: Payment[] = []): Order {
  return {
    id: 'order-1',
    reference: 'TD-ORDER-1',
    customerName: 'Customer One',
    customerRequest: 'Ke kopa one meal',
    currency: 'USD',
    subtotalMinor: 1250,
    totalMinor: 1250,
    status,
    aiGenerated: true,
    confirmedAt: status === 'DRAFT' ? null : createdAt,
    confirmedById: status === 'DRAFT' ? null : 'seller-1',
    createdAt,
    items: [{ id: 'item-1', productId: 'product-1', descriptionSnapshot: 'Chicken meal', quantity: 1, unitPriceMinor: 1250, lineTotalMinor: 1250, currency: 'USD' }],
    payments,
    activity: [
      { id: 'event-1', action: 'order.ai_draft_created', entityType: 'order', entityId: 'order-1', createdAt },
      ...(status === 'DRAFT' ? [] : [{ id: 'event-2', action: 'order.confirmed', entityType: 'order', entityId: 'order-1', createdAt }])
    ]
  };
}

function payment(status: string, overrides: Partial<Payment> = {}): Payment {
  return { id: 'attempt-1', status, amountMinor: 1250, currency: 'USD', createdAt, updatedAt: createdAt, ...overrides };
}

function renderMission(currentOrder: Order, overrides: Partial<React.ComponentProps<typeof MissionControl>> = {}) {
  const props: React.ComponentProps<typeof MissionControl> = {
    order: currentOrder,
    environment: 'sandbox',
    paypalConfigured: true,
    supportedCurrencies: ['USD'],
    busy: false,
    onConfirm: vi.fn(),
    onCheckout: vi.fn(),
    onReconcile: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides
  };
  return { ...render(<MissionControl {...props}/>), props };
}

describe('Tefo Mission Control', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows request, AI draft, seller approval boundary, and the next seller action', () => {
    const currentOrder = order('DRAFT');
    const aiProposal = {
      draft: currentOrder,
      items: [{ productId: 'product-1', quantity: 1, matchNote: 'The request asks for one meal.' }],
      questions: [],
      explanation: 'Matched a catalog item.',
      requiresConfirmation: true
    };
    const { props } = renderMission(currentOrder, { aiProposal });

    expect(screen.getByText('Customer request saved')).toBeTruthy();
    expect(screen.getByText('AI-assisted draft created')).toBeTruthy();
    expect(screen.getByText('The request asks for one meal.')).toBeTruthy();
    expect(screen.getByText('Seller confirmation')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Confirm order/ }));
    expect(props.onConfirm).toHaveBeenCalledWith(currentOrder);
    expect(screen.getByText('PayPal Sandbox')).toBeTruthy();
  });

  it('offers reconciliation for an uncertain payment without reporting success', () => {
    const currentOrder = order('AWAITING_PAYMENT', [payment('UNCERTAIN', { paypalOrderId: 'PAYPAL-ORDER-1' })]);
    const { props } = renderMission(currentOrder);

    expect(screen.getByText(/Payment result needs reconciliation/)).toBeTruthy();
    expect(screen.getByText(/Uncertain · reconciliation required/)).toBeTruthy();
    expect(screen.queryByText('PayPal payment verified')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile with PayPal' }));
    expect(props.onReconcile).toHaveBeenCalledWith(currentOrder.payments?.[0]);
  });

  it('distinguishes buyer approval from captured payment', () => {
    renderMission(order('AWAITING_PAYMENT', [payment('APPROVED')]));

    expect(screen.getByText(/Buyer approval recorded; capture still needs verification/)).toBeTruthy();
    expect(screen.getByText(/Approval is not payment completion/)).toBeTruthy();
    expect(screen.queryByText('PayPal payment verified')).toBeNull();
  });

  it('offers Sandbox checkout only when the currency is supported', () => {
    const currentOrder = order('AWAITING_PAYMENT');
    const { props, rerender } = renderMission(currentOrder);

    expect(screen.getByRole('button', { name: 'Start PayPal Sandbox checkout' })).toBeTruthy();
    expect(screen.getByText(/Buyer approval happens on PayPal/)).toBeTruthy();
    expect(screen.getByText(/No payment attempt is recorded/)).toBeTruthy();

    rerender(<MissionControl {...props} supportedCurrencies={[]}/>);
    expect(screen.queryByRole('button', { name: 'Start PayPal Sandbox checkout' })).toBeNull();
    expect(screen.getByText(/USD is not supported by this PayPal integration/)).toBeTruthy();
  });

  it('shows the PayPal capture reference only from a captured paid payment', () => {
    const currentOrder = order('PAID', [payment('CAPTURED', { captureId: 'CAPTURE-123', paypalOrderId: 'PAYPAL-ORDER-1' })]);
    renderMission(currentOrder);

    expect(screen.getByText(/Payment verified/)).toBeTruthy();
    expect(screen.getByText('Capture verified')).toBeTruthy();
    expect(screen.getByText(/Capture ID: CAPTURE-123/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Start PayPal/ })).toBeNull();
  });

  it('does not trust a paid order label when the capture ID is absent', () => {
    const currentOrder = order('PAID', [payment('CAPTURED')]);
    const { props } = renderMission(currentOrder);

    expect(screen.getByText(/Payment record needs verification/)).toBeTruthy();
    expect(screen.queryByText('Payment verified')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh order status' }));
    expect(props.onRefresh).toHaveBeenCalledWith(currentOrder);
  });
});
