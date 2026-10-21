import {
  PaymentPort,
  CreateOrderParams,
  CreateOrderResult,
  PayPalOrderDetails,
  CapturePaymentParams,
  CapturePaymentResult,
  PayPalCaptureDetails,
  RefundPaymentParams,
  RefundPaymentResult,
  PayPalRefundDetails,
  VerifyWebhookParams,
  CreateInvoiceDraftParams,
  CreateInvoiceDraftResult,
  SendInvoiceResult,
  PayPalInvoiceDetails,
} from "@velvetai/application";
import {
  generateUUIDv7,
  paymentIntentIdSchema,
  paymentCaptureIdSchema,
  refundIdSchema,
  currencyCodeSchema,
  moneyMinorSchema,
} from "@velvetai/contracts";
import { PayPalHttpClient } from "./client.js";
import { PayPalSandboxConfig, minorUnitsToDecimal, decimalToMinorUnits } from "./types.js";
import { PayPalClientError } from "./errors.js";

interface PayPalApiOrder {
  id: string;
  status: string;
  intent: string;
  purchase_units?: Array<{
    reference_id?: string;
    custom_id?: string;
    amount?: {
      currency_code: string;
      value: string;
    };
    payments?: {
      captures?: Array<{
        id: string;
        status: string;
        amount?: {
          currency_code: string;
          value: string;
        };
      }>;
    };
  }>;
}

interface PayPalApiCapture {
  id: string;
  status: string;
  custom_id?: string;
  amount?: {
    currency_code: string;
    value: string;
  };
}

interface PayPalApiRefund {
  id: string;
  status: string;
  amount?: {
    currency_code: string;
    value: string;
  };
}

interface PayPalApiInvoice {
  id: string;
  status: string;
  detail?: {
    invoice_number?: string;
  };
  amount?: {
    currency_code: string;
    value: string;
  };
}

export class PayPalSandboxAdapter implements PaymentPort {
  readonly client: PayPalHttpClient;
  readonly webhookId?: string;

  constructor(config: PayPalSandboxConfig) {
    this.client = new PayPalHttpClient(config);
    this.webhookId = config.webhookId;
  }

  get baseUrl(): string {
    return this.client.baseUrl;
  }

  get clientId(): string {
    return this.client.clientId;
  }

  /**
   * Creates an Orders v2 order with intent CAPTURE.
   * Specification v1.1 Amendment Section F.1 & F.4.
   */
  async createOrder(params: CreateOrderParams): Promise<CreateOrderResult> {
    const valueStr = minorUnitsToDecimal(params.amount.valueMinor);
    const body = {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: "default",
          custom_id: params.bookingId, // Opaque reference, zero PII
          amount: {
            currency_code: params.amount.currency,
            value: valueStr,
          },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "Velvet Flagship",
            landing_page: "LOGIN",
            user_action: "PAY_NOW",
            return_url: `${process.env.WEB_BASE_URL || "http://localhost:5173"}/book?status=success`,
            cancel_url: `${process.env.WEB_BASE_URL || "http://localhost:5173"}/book?status=cancel`,
          },
        },
      },
    };

    const { data } = await this.client.request<PayPalApiOrder>({
      method: "POST",
      path: "/v2/checkout/orders",
      body,
      requestId: params.requestId,
    });

    const paymentIntentId = paymentIntentIdSchema.parse(generateUUIDv7());
    return {
      providerOrderId: data.id,
      paymentIntentId,
    };
  }

  /**
   * Retrieves an Orders v2 order by ID.
   */
  async getOrder(providerOrderId: string): Promise<PayPalOrderDetails> {
    const { data } = await this.client.request<PayPalApiOrder>({
      method: "GET",
      path: `/v2/checkout/orders/${providerOrderId}`,
    });

    const pu = data.purchase_units?.[0];
    const amountVal = pu?.amount?.value ?? "0.00";
    const currency = pu?.amount?.currency_code ?? "USD";

    const captures = pu?.payments?.captures?.map((c) => ({
      id: c.id,
      status: c.status as "COMPLETED" | "DECLINED" | "FAILED" | "PENDING",
      amount: {
        currency: currencyCodeSchema.parse(c.amount?.currency_code ?? currency),
        valueMinor: moneyMinorSchema.parse(decimalToMinorUnits(c.amount?.value ?? "0.00")),
      },
    }));

    return {
      id: data.id,
      status: data.status as PayPalOrderDetails["status"],
      intent: data.intent,
      customId: pu?.custom_id,
      amount: {
        currency: currencyCodeSchema.parse(currency),
        valueMinor: moneyMinorSchema.parse(decimalToMinorUnits(amountVal)),
      },
      captures,
    };
  }

  /**
   * Captures an authorized or approved Orders v2 order.
   * Specification v1.1 Amendment Section F.1.
   * Authoritative confirmation condition: capture status == COMPLETED.
   */
  async capturePayment(params: CapturePaymentParams): Promise<CapturePaymentResult> {
    const { data } = await this.client.request<PayPalApiOrder>({
      method: "POST",
      path: `/v2/checkout/orders/${params.providerOrderId}/capture`,
      requestId: params.requestId,
      body: {},
    });

    const pu = data.purchase_units?.[0];
    const capture = pu?.payments?.captures?.[0];

    if (!capture) {
      throw new PayPalClientError("PayPal capture response did not contain capture details", {
        details: data,
      });
    }

    const paymentCaptureId = paymentCaptureIdSchema.parse(generateUUIDv7());
    let status: "CAPTURED" | "UNCERTAIN" | "FAILED" = "UNCERTAIN";

    if (capture.status === "COMPLETED") {
      status = "CAPTURED";
    } else if (capture.status === "PENDING") {
      status = "UNCERTAIN";
    } else if (capture.status === "DECLINED" || capture.status === "FAILED") {
      status = "FAILED";
    }

    return {
      providerCaptureId: capture.id,
      paymentCaptureId,
      status,
    };
  }

  /**
   * Retrieves capture details by capture ID.
   */
  async getCapture(providerCaptureId: string): Promise<PayPalCaptureDetails> {
    const { data } = await this.client.request<PayPalApiCapture>({
      method: "GET",
      path: `/v2/payments/captures/${providerCaptureId}`,
    });

    const currency = data.amount?.currency_code ?? "USD";
    const value = data.amount?.value ?? "0.00";

    return {
      id: data.id,
      status: data.status as PayPalCaptureDetails["status"],
      customId: data.custom_id,
      amount: {
        currency: currencyCodeSchema.parse(currency),
        valueMinor: moneyMinorSchema.parse(decimalToMinorUnits(value)),
      },
    };
  }

  /**
   * Issues a refund against a captured payment.
   * Specification v1.1 Amendment Section F.6.
   */
  async refundPayment(params: RefundPaymentParams): Promise<RefundPaymentResult> {
    const valueStr = minorUnitsToDecimal(params.amount.valueMinor);
    const body = {
      amount: {
        currency_code: params.amount.currency,
        value: valueStr,
      },
      note_to_payer: "velvetAI appointment refund",
    };

    const { data } = await this.client.request<PayPalApiRefund>({
      method: "POST",
      path: `/v2/payments/captures/${params.providerCaptureId}/refund`,
      requestId: params.requestId,
      body,
    });

    const refundId = refundIdSchema.parse(generateUUIDv7());
    const status: "REQUESTED" | "COMPLETED" | "FAILED" =
      data.status === "COMPLETED" ? "COMPLETED" : data.status === "FAILED" ? "FAILED" : "REQUESTED";

    return {
      refundId,
      providerRefundId: data.id,
      status,
    };
  }

  /**
   * Retrieves refund details by refund ID.
   */
  async getRefund(providerRefundId: string): Promise<PayPalRefundDetails> {
    const { data } = await this.client.request<PayPalApiRefund>({
      method: "GET",
      path: `/v2/payments/refunds/${providerRefundId}`,
    });

    const currency = data.amount?.currency_code ?? "USD";
    const value = data.amount?.value ?? "0.00";

    return {
      id: data.id,
      status: data.status as PayPalRefundDetails["status"],
      amount: {
        currency: currencyCodeSchema.parse(currency),
        valueMinor: moneyMinorSchema.parse(decimalToMinorUnits(value)),
      },
    };
  }

  /**
   * Verifies incoming webhook signature with PayPal API.
   * Specification v1.1 Amendment Section G.1 & G.2.
   */
  async verifyWebhookSignature(params: VerifyWebhookParams): Promise<boolean> {
    const headers = params.headers;
    const transmissionId = headers["paypal-transmission-id"];
    const transmissionTime = headers["paypal-transmission-time"];
    const certUrl = headers["paypal-cert-url"];
    const authAlgo = headers["paypal-auth-algo"];
    const transmissionSig = headers["paypal-transmission-sig"];
    const webhookId = params.webhookId ?? this.webhookId;

    if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig || !webhookId) {
      return false;
    }

    // SSRF / Host validation for cert_url per Amendment Section I.26
    try {
      const parsedUrl = new URL(certUrl);
      if (parsedUrl.protocol !== "https:") return false;
      const host = parsedUrl.hostname.toLowerCase();
      // Only official PayPal certificate hosts are allowed
      const isAllowedHost =
        host === "api.paypal.com" ||
        host === "api.sandbox.paypal.com" ||
        host.endsWith(".paypal.com");
      if (!isAllowedHost) return false;
    } catch {
      return false;
    }

    let parsedEvent: unknown;
    try {
      parsedEvent = JSON.parse(params.rawBody);
    } catch {
      return false;
    }

    try {
      const { data } = await this.client.request<{ verification_status: string }>({
        method: "POST",
        path: "/v1/notifications/verify-webhook-signature",
        body: {
          auth_algo: authAlgo,
          cert_url: certUrl,
          transmission_id: transmissionId,
          transmission_sig: transmissionSig,
          transmission_time: transmissionTime,
          webhook_id: webhookId,
          webhook_event: parsedEvent,
        },
      });

      return data.verification_status === "SUCCESS";
    } catch {
      return false;
    }
  }

  /**
   * Creates an Invoicing v2 draft for post-appointment balance billing.
   * Specification v1.1 Amendment Section F.7 & W8.
   */
  async createInvoiceDraft(params: CreateInvoiceDraftParams): Promise<CreateInvoiceDraftResult> {
    const balanceStr = minorUnitsToDecimal(params.balanceDue.valueMinor);
    const body = {
      detail: {
        currency_code: params.balanceDue.currency,
        note: `velvetAI balance invoice for appointment ${params.bookingId}`,
      },
      primary_recipients: [
        {
          billing_info: {
            email_address: params.customerEmail,
            name: params.customerName ? { full_name: params.customerName } : undefined,
          },
        },
      ],
      items: [
        {
          name: params.serviceName,
          quantity: "1",
          unit_amount: {
            currency_code: params.balanceDue.currency,
            value: balanceStr,
          },
        },
      ],
      configuration: {
        partial_payment: {
          allow_partial_payment: false,
        },
      },
    };

    const { data } = await this.client.request<PayPalApiInvoice>({
      method: "POST",
      path: "/v2/invoicing/invoices",
      body,
    });

    return {
      providerInvoiceId: data.id,
      providerInvoiceNumber: data.detail?.invoice_number,
    };
  }

  /**
   * Sends an Invoicing v2 draft invoice to the customer.
   */
  async sendInvoice(providerInvoiceId: string): Promise<SendInvoiceResult> {
    await this.client.request({
      method: "POST",
      path: `/v2/invoicing/invoices/${providerInvoiceId}/send`,
      body: {
        send_to_recipient: true,
      },
    });

    return {
      providerInvoiceId,
      status: "SENT",
    };
  }

  /**
   * Retrieves Invoicing v2 invoice details.
   */
  async getInvoice(providerInvoiceId: string): Promise<PayPalInvoiceDetails> {
    const { data } = await this.client.request<PayPalApiInvoice>({
      method: "GET",
      path: `/v2/invoicing/invoices/${providerInvoiceId}`,
    });

    const currency = data.amount?.currency_code ?? "USD";
    const value = data.amount?.value ?? "0.00";

    return {
      id: data.id,
      status: data.status,
      amount: {
        currency: currencyCodeSchema.parse(currency),
        valueMinor: moneyMinorSchema.parse(decimalToMinorUnits(value)),
      },
    };
  }
}
