import type {
  BookingApprovalDetails,
  ApproveAndCommitResponse,
  ConfirmBookingApprovalResponse,
} from "@velvetai/contracts";
import { API_BASE_URL, VelvetApiClient, apiClient } from "../api-client.js";

export interface ApprovalDetailsResult {
  details: BookingApprovalDetails;
  serverTime: number;
}

export async function fetchApprovalDetails(
  locator: string,
  baseUrl: string = API_BASE_URL,
): Promise<ApprovalDetailsResult> {
  const cleanLocator = locator.replace(/^.*\/v1\/booking-approvals\//, "").trim();
  const res = await fetch(`${baseUrl}/v1/booking-approvals/${cleanLocator}`, {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const message =
      err.detail || err.title || `HTTP ${res.status}: Failed to load approval details`;
    const errorObj = new Error(message) as Error & { status?: number; code?: string };
    errorObj.status = res.status;
    errorObj.code = err.code;
    throw errorObj;
  }

  const serverDateHeader = res.headers.get("date");
  const serverTime = serverDateHeader ? new Date(serverDateHeader).getTime() : Date.now();
  const details: BookingApprovalDetails = await res.json();
  return { details, serverTime };
}

export async function postApproveAndCommit(
  locator: string,
  token: string,
  idempotencyKey?: string,
  baseUrl: string = API_BASE_URL,
): Promise<ApproveAndCommitResponse> {
  const client =
    baseUrl === API_BASE_URL ? apiClient : new VelvetApiClient({ baseUrl, authToken: token });
  return client.approveAndCommit(locator, idempotencyKey, token);
}

export async function postConfirmApproval(
  locator: string,
  token: string,
  idempotencyKey?: string,
  baseUrl: string = API_BASE_URL,
): Promise<ConfirmBookingApprovalResponse> {
  const client =
    baseUrl === API_BASE_URL ? apiClient : new VelvetApiClient({ baseUrl, authToken: token });
  return client.confirmApproval(locator, idempotencyKey, token);
}
