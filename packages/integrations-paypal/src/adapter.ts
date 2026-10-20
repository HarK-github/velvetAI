import {
  PaymentPort,
  CreateOrderParams,
  CreateOrderResult,
  CapturePaymentParams,
  CapturePaymentResult,
  RefundPaymentParams,
  RefundPaymentResult,
} from "@velvetai/application";
import {
  generateUUIDv7,
  paymentIntentIdSchema,
  paymentCaptureIdSchema,
  refundIdSchema,
} from "@velvetai/contracts";

export interface PayPalSandboxConfig {
  clientId: string;
  clientSecret: string;
  webhookId?: string;
  baseUrl?: string;
}

export class PayPalSandboxAdapter implements PaymentPort {
  readonly baseUrl: string;
  readonly clientId: string;

  constructor(config: PayPalSandboxConfig) {
    this.baseUrl = config.baseUrl ?? "https://api-m.sandbox.paypal.com";
    this.clientId = config.clientId;
  }

  async createOrder(_params: CreateOrderParams): Promise<CreateOrderResult> {
    const providerOrderId = `SANDBOX_ORDER_${Date.now()}`;
    const paymentIntentId = paymentIntentIdSchema.parse(generateUUIDv7());

    return {
      providerOrderId,
      paymentIntentId,
    };
  }

  async capturePayment(_params: CapturePaymentParams): Promise<CapturePaymentResult> {
    const providerCaptureId = `SANDBOX_CAPTURE_${Date.now()}`;
    const paymentCaptureId = paymentCaptureIdSchema.parse(generateUUIDv7());

    return {
      providerCaptureId,
      paymentCaptureId,
      status: "CAPTURED",
    };
  }

  async refundPayment(_params: RefundPaymentParams): Promise<RefundPaymentResult> {
    const providerRefundId = `SANDBOX_REFUND_${Date.now()}`;
    const refundId = refundIdSchema.parse(generateUUIDv7());

    return {
      refundId,
      providerRefundId,
      status: "COMPLETED",
    };
  }

  verifyWebhookSignature(headers: Record<string, string>, _body: string): boolean {
    const transmissionId = headers["paypal-transmission-id"];
    const transmissionTime = headers["paypal-transmission-time"];
    const certUrl = headers["paypal-cert-url"];
    const authAlgo = headers["paypal-auth-algo"];
    const transmissionSig = headers["paypal-transmission-sig"];

    if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
      return false;
    }
    return true;
  }
}
