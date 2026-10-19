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

export interface PaymentPort {
  createOrder(params: CreateOrderParams): Promise<CreateOrderResult>;
  capturePayment(params: CapturePaymentParams): Promise<CapturePaymentResult>;
  refundPayment(params: RefundPaymentParams): Promise<RefundPaymentResult>;
}

export interface ClockPort {
  now(): Date;
}
