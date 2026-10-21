import {
  TenantId,
  UserId,
  Role,
  Money,
  BookingId,
  PaymentIntentId,
  PaymentCaptureId,
  RefundId,
} from "@velvetai/contracts";

export interface AuthenticatedPrincipal {
  subject: string;
  userId: UserId;
  tenantId: TenantId;
  roles: Role[];
  roleVersion: number;
  authTime: string;
  mfaVerified: boolean;
}

export interface AuthenticationPort {
  authenticateBearerToken(token: string): Promise<AuthenticatedPrincipal>;
}

export interface CreateOrderParams {
  tenantId: TenantId;
  bookingId: BookingId;
  amount: Money;
  requestId: string;
}

export interface CreateOrderResult {
  providerOrderId: string;
  paymentIntentId: PaymentIntentId;
}

export interface CapturePaymentParams {
  tenantId: TenantId;
  paymentIntentId: PaymentIntentId;
  providerOrderId: string;
  amount: Money;
  requestId: string;
}

export interface CapturePaymentResult {
  providerCaptureId: string;
  paymentCaptureId: PaymentCaptureId;
  status: "CAPTURED" | "UNCERTAIN" | "FAILED";
}

export interface RefundPaymentParams {
  tenantId: TenantId;
  paymentCaptureId: PaymentCaptureId;
  providerCaptureId: string;
  amount: Money;
  requestId: string;
}

export interface RefundPaymentResult {
  refundId: RefundId;
  providerRefundId?: string;
  status: "REQUESTED" | "COMPLETED" | "FAILED";
}

export interface PayPalOrderDetails {
  id: string;
  status: "CREATED" | "SAVED" | "APPROVED" | "VOIDED" | "COMPLETED" | "PAYER_ACTION_REQUIRED";
  intent: string;
  customId?: string;
  amount: Money;
  captures?: Array<{
    id: string;
    status: "COMPLETED" | "DECLINED" | "FAILED" | "PENDING";
    amount: Money;
  }>;
}

export interface PayPalCaptureDetails {
  id: string;
  status: "COMPLETED" | "DECLINED" | "FAILED" | "PENDING";
  amount: Money;
  customId?: string;
}

export interface PayPalRefundDetails {
  id: string;
  status: "COMPLETED" | "CANCELLED" | "FAILED" | "PENDING";
  amount: Money;
  captureId?: string;
}

export interface VerifyWebhookParams {
  headers: Record<string, string>;
  rawBody: string;
  webhookId?: string;
}

export interface CreateInvoiceDraftParams {
  tenantId: TenantId;
  bookingId: BookingId;
  amount: Money;
  depositPaid: Money;
  balanceDue: Money;
  serviceName: string;
  customerEmail: string;
  customerName?: string;
}

export interface CreateInvoiceDraftResult {
  providerInvoiceId: string;
  providerInvoiceNumber?: string;
}

export interface SendInvoiceResult {
  providerInvoiceId: string;
  status: "SENT";
}

export interface PayPalInvoiceDetails {
  id: string;
  status: string;
  amount: Money;
}

export interface PaymentPort {
  createOrder(params: CreateOrderParams): Promise<CreateOrderResult>;
  getOrder(providerOrderId: string): Promise<PayPalOrderDetails>;
  capturePayment(params: CapturePaymentParams): Promise<CapturePaymentResult>;
  getCapture(providerCaptureId: string): Promise<PayPalCaptureDetails>;
  refundPayment(params: RefundPaymentParams): Promise<RefundPaymentResult>;
  getRefund(providerRefundId: string): Promise<PayPalRefundDetails>;
  verifyWebhookSignature(params: VerifyWebhookParams): Promise<boolean>;
  createInvoiceDraft(params: CreateInvoiceDraftParams): Promise<CreateInvoiceDraftResult>;
  sendInvoice(providerInvoiceId: string): Promise<SendInvoiceResult>;
  getInvoice(providerInvoiceId: string): Promise<PayPalInvoiceDetails>;
}

export interface ClockPort {
  now(): Date;
}
