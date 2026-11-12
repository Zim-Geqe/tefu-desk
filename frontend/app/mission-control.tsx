'use client';

import { ArrowRight, CheckCircle2, Circle, Clock3, CreditCard, ExternalLink, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import type { AiDraft, Order, OrderActivity, Payment } from '@/lib/api';
import { date, money } from '@/lib/api';

type Props = {
  order: Order;
  environment: 'sandbox' | 'live' | 'unknown';
  paypalConfigured: boolean;
  supportedCurrencies: string[];
  busy: boolean;
  aiProposal?: AiDraft | null;
  onConfirm: (order: Order) => void;
  onCheckout: (order: Order) => void;
  onReconcile: (payment: Payment) => void;
  onRefresh: (order: Order) => void;
};

const eventLabels: Record<string, string> = {
  'order.created': 'Manual order draft created',
  'order.ai_draft_created': 'AI-assisted order draft created',
  'order.updated': 'Draft details updated',
  'order.confirmed': 'Seller confirmed the order',
  'order.cancelled': 'Order cancelled',
  'payment.initiated': 'PayPal checkout attempt started',
  'payment.capture.started': 'Server started PayPal capture',
  'payment.captured': 'PayPal capture verified by server',
  'payment.reconciled_captured': 'PayPal capture verified during reconciliation',
  'payment.webhook_captured': 'PayPal capture verified from webhook',
  'payment.creation_reconciled': 'PayPal checkout creation reconciled',
  'payment.reconciled': 'Payment status checked with PayPal',
  'payment.refund_recorded': 'PayPal refund recorded',
  'payment.refund_status_updated': 'PayPal refund status updated',
};

function currentPayment(order: Order) {
  return [...(order.payments ?? [])].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).reverse().find(payment => !['CANCELLED', 'FAILED', 'DENIED', 'REFUNDED'].includes(payment.status));
}

function actionFor(order: Order, payment: Payment | undefined, props: Props) {
  const capturedWithoutPaidOrder = order.status !== 'PAID' && order.payments?.some(attempt => attempt.status === 'CAPTURED' && attempt.captureId);
  if (capturedWithoutPaidOrder) {
    return { title: 'Captured payment needs order-status review', description: 'A completed capture is recorded, but the order is not marked paid. Refresh the authoritative order before taking another payment.', button: 'Refresh order status', onClick: () => props.onRefresh(order) };
  }
  if (order.status === 'DRAFT') {
    return {
      title: 'Review and confirm this order',
      description: 'AI prepared a suggestion; the seller must approve the items and total before checkout.',
      button: 'Confirm order',
      onClick: () => props.onConfirm(order),
    };
  }
  if (order.status === 'PAID') {
    const captured = order.payments?.some(attempt => attempt.status === 'CAPTURED' && attempt.captureId);
    return captured
      ? { title: 'Payment verified', description: 'The server confirmed a completed PayPal capture for this order.' }
      : { title: 'Payment record needs verification', description: 'The order says paid, but no captured PayPal ID is available in this response.', button: 'Refresh order status', onClick: () => props.onRefresh(order) };
  }
  if (order.status === 'REFUNDED') {
    return { title: 'Refund recorded', description: 'The order is marked refunded. Review the saved refund records below.' };
  }
  if (order.status === 'CANCELLED') {
    return { title: 'Order cancelled', description: 'No further payment action is available for this order.' };
  }
  if (payment?.status === 'UNCERTAIN' || payment?.status === 'CAPTURE_PENDING') {
    return {
      title: 'Payment result needs reconciliation',
      description: 'Check the authoritative PayPal order before retrying or treating this order as paid.',
      button: 'Reconcile with PayPal',
      onClick: () => props.onReconcile(payment),
    };
  }
  if (payment?.status === 'APPROVED') {
    return {
      title: 'Buyer approval recorded; capture still needs verification',
      description: 'Approval is not payment completion. Ask the server to capture and verify this PayPal order.',
      button: 'Capture and verify',
      onClick: () => props.onReconcile(payment),
    };
  }
  if (payment?.status === 'CREATED') {
    return {
      title: 'Waiting for buyer approval',
      description: 'Continue to PayPal to let the buyer approve this checkout. Returning to Tefo Desk does not itself prove payment.',
      button: 'Continue to PayPal',
      onClick: () => props.onCheckout(order),
    };
  }
  if (order.status === 'PAYMENT_FAILED') {
    if (!props.paypalConfigured) return { title: 'Payment could not be completed', description: 'PayPal is not configured for this deployment. Contact the workspace owner.' };
    if (!props.supportedCurrencies.includes(order.currency)) return { title: 'Payment could not be completed', description: `PayPal checkout does not support ${order.currency} in this integration.` };
    return { title: 'Payment failed', description: 'Review the failed attempt, then create a new PayPal checkout if appropriate.', button: 'Retry PayPal checkout', onClick: () => props.onCheckout(order) };
  }
  if (order.status === 'AWAITING_PAYMENT') {
    if (!props.paypalConfigured) return { title: 'Ready for payment, but PayPal is not configured', description: 'Contact the workspace owner to configure PayPal for this deployment.' };
    if (!props.supportedCurrencies.includes(order.currency)) return { title: 'PayPal checkout unavailable', description: `${order.currency} is not supported by this PayPal integration. No conversion is performed.` };
    return {
      title: 'Order confirmed; payment has not started',
      description: 'Create a PayPal checkout and send the buyer to approve the transaction.',
      button: props.environment === 'sandbox' ? 'Start PayPal Sandbox checkout' : 'Start PayPal checkout',
      onClick: () => props.onCheckout(order),
    };
  }
  return { title: 'Order status needs review', description: 'Refresh the order to retrieve the latest saved status.' , button: 'Refresh order status', onClick: () => props.onRefresh(order) };
}

function paymentLabel(payment: Payment) {
  switch (payment.status) {
    case 'CREATED': return 'Checkout created · awaiting buyer approval';
    case 'APPROVED': return 'Buyer approval recorded · not yet captured';
    case 'CAPTURE_PENDING': return 'Capture pending · verify with PayPal';
    case 'CAPTURED': return payment.captureId ? 'Capture verified' : 'Captured status missing PayPal capture ID';
    case 'UNCERTAIN': return 'Uncertain · reconciliation required';
    case 'DENIED': return 'Capture denied';
    case 'FAILED': return 'Payment failed';
    case 'CANCELLED': return 'Checkout cancelled';
    case 'REFUNDED': return 'Refunded';
    default: return payment.status.toLowerCase().replaceAll('_', ' ');
  }
}

function activityLabel(activity: OrderActivity) {
  return eventLabels[activity.action];
}

function Timeline({order, proposal}:{order:Order;proposal?:AiDraft|null}) {
  const events = (order.activity ?? []).filter(activity => activityLabel(activity)&&!['order.created','order.ai_draft_created'].includes(activity.action));
  const matchedProposal = proposal?.draft?.id === order.id ? proposal.items : [];
  const captured = order.payments?.find(payment => payment.status === 'CAPTURED' && payment.captureId);
  return <section className="mission-timeline" aria-labelledby="mission-timeline-heading">
    <div className="mission-section-heading"><div><span className="mission-kicker">RECORDED JOURNEY</span><h3 id="mission-timeline-heading">Transaction timeline</h3></div><Clock3 size={17}/></div>
    <ol className="mission-events">
      <li className="mission-event complete">
        <CheckCircle2 size={16}/>
        <div><strong>{order.customerRequest ? 'Customer request saved' : 'Order created'}</strong><small>{date(order.createdAt)} · saved with the order</small></div>
      </li>
      {order.aiGenerated&&<li className="mission-event complete">
        <Sparkles size={16}/>
        <div><strong>AI-assisted draft created</strong><small>AI supplied a proposal; the saved order lines and seller confirmation remain authoritative.</small>
          {matchedProposal.length>0&&<div className="mission-match-list">{matchedProposal.map((item,index)=><p key={`${item.productId}-${index}`}><b>{order.items.find(line=>line.productId===item.productId)?.descriptionSnapshot ?? 'Catalog item'} · qty {item.quantity}</b><span>{item.matchNote}</span></p>)}</div>}
        </div>
      </li>}
      <li className={`mission-event ${order.confirmedAt ? 'complete' : order.status === 'DRAFT' ? 'current' : 'future'}`}>
        {order.confirmedAt?<CheckCircle2 size={16}/>:order.status==='DRAFT'?<Circle size={16}/>:<Circle size={16}/>}
        <div><strong>{order.confirmedAt?'Seller confirmed the order':'Seller confirmation'}</strong><small>{order.confirmedAt ? `${date(order.confirmedAt)} · recorded by the seller` : order.status === 'DRAFT' ? 'Required before a PayPal checkout can be created.' : 'No separate confirmation timestamp is available.'}</small></div>
      </li>
      {order.payments?.map(payment=><li className={`mission-event payment-${payment.status.toLowerCase()}`} key={payment.id}>
        {payment.status==='CAPTURED'&&payment.captureId?<CheckCircle2 size={16}/>:<CreditCard size={16}/>}
        <div><strong>{paymentLabel(payment)}</strong><small>{date(payment.createdAt)} · {money(payment.amountMinor,payment.currency)}{payment.paypalOrderId?` · PayPal order ${payment.paypalOrderId}`:''}</small>
          {payment.captureId&&<small>Capture ID: {payment.captureId}</small>}
          {payment.refunds?.map(refund=><small key={refund.id}>Refund {refund.status.toLowerCase()} · {money(refund.amountMinor,refund.currency)} · {refund.paypalRefundId}</small>)}
          {payment.status==='UNCERTAIN'&&<small>Payment may still be processing. Reconcile before retrying or marking paid.</small>}
        </div>
      </li>)}
      {events.map(activity=><li className="mission-event recorded" key={activity.id}>
        <CheckCircle2 size={16}/>
        <div><strong>{activityLabel(activity)}</strong><small>{date(activity.createdAt)}</small></div>
      </li>)}
      {order.status==='AWAITING_PAYMENT'&&!order.payments?.length&&<li className="mission-event future"><Circle size={16}/><div><strong>PayPal checkout</strong><small>Not started. No payment attempt is recorded.</small></div></li>}
      {order.status==='PAID'&&!captured&&<li className="mission-event warning"><RefreshCw size={16}/><div><strong>Capture evidence unavailable</strong><small>The order status is paid, but this response has no captured payment ID. Verify before claiming payment success.</small></div></li>}
    </ol>
    {!events.length&&<p className="mission-footnote">Only saved order and payment data is shown. No additional activity events were returned for this order.</p>}
    {order.aiGenerated&&!matchedProposal.length&&<p className="mission-footnote">Per-item AI match explanations are shown during draft review; they are not stored in the order record.</p>}
  </section>;
}

export default function MissionControl(props: Props) {
  const payment = currentPayment(props.order);
  const action = actionFor(props.order, payment, props);
  const canCancel = ['DRAFT', 'AWAITING_PAYMENT', 'PAYMENT_FAILED'].includes(props.order.status) && !['CREATED','APPROVED','CAPTURE_PENDING','UNCERTAIN'].includes(payment?.status ?? '');
  return <section className="mission-control" aria-label="Tefo Mission Control">
    <header className="mission-header"><div><span className="mission-kicker">TEFO MISSION CONTROL</span><h3>Order to payment</h3></div><span className={`mission-state ${props.order.status.toLowerCase().replaceAll('_','-')}`}>{props.order.status.replaceAll('_',' ')}</span></header>
    <div className="mission-next-action">
      <span className="mission-next-icon">{action.button?.includes('PayPal')?<ExternalLink size={17}/>:action.button?.includes('confirm')?<ShieldCheck size={17}/>:action.button?.includes('Reconcile')||action.button?.includes('Capture')?<RefreshCw size={17}/>:<CheckCircle2 size={17}/>}</span>
      <div className="mission-next-copy"><strong>Next step · {action.title}</strong><p>{action.description}</p></div>
      {action.button&&action.onClick&&<button type="button" className="mission-action-button" disabled={props.busy} onClick={action.onClick}>{action.button}<ArrowRight size={14}/></button>}
    </div>
    {props.environment==='sandbox'&&<div className="mission-sandbox"><ShieldCheck size={15}/><span><strong>PayPal Sandbox</strong> · test checkout only; no real money moves. Buyer approval happens on PayPal, then Tefo verifies capture on return.</span></div>}
    {props.environment==='live'&&<div className="mission-live-warning"><CreditCard size={15}/><span>PayPal Live environment · checkout may process real payments.</span></div>}
    <Timeline order={props.order} proposal={props.aiProposal}/>
    {canCancel&&<p className="mission-footnote">Seller confirmation is the financial-control boundary. AI suggestions never confirm or mark payments as paid.</p>}
  </section>;
}
