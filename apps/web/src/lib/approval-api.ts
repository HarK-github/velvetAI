import type {
  BookingApprovalDetails,
  ApproveAndCommitResponse,
  ConfirmBookingApprovalResponse,
} from "@velvetai/contracts";
import { API_BASE_URL } from "../api-client.js";

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
  const cleanLocator = locator.replace(/^.*\/v1\/booking-approvals\//, "").trim();
  const key =
    idempotencyKey ||
    (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `idemp-${Date.now()}`);

  const res = await fetch(`${baseUrl}/v1/booking-approvals/${cleanLocator}/approve-and-commit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "Idempotency-Key": key,
    },
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const message = err.detail || err.title || `Approval failed with HTTP ${res.status}`;
    const errorObj = new Error(message) as Error & { status?: number; code?: string };
    errorObj.status = res.status;
    errorObj.code = err.code;
    throw errorObj;
  }

  return await res.json();
}

export async function postConfirmApproval(
  locator: string,
  token: string,
  idempotencyKey?: string,
  baseUrl: string = API_BASE_URL,
): Promise<ConfirmBookingApprovalResponse> {
  const cleanLocator = locator.replace(/^.*\/v1\/booking-approvals\//, "").trim();
  const key =
    idempotencyKey ||
    (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `confirm-${Date.now()}`);

  const res = await fetch(`${baseUrl}/v1/booking-approvals/${cleanLocator}/confirm`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "Idempotency-Key": key,
    },
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const message = err.detail || err.title || `Confirmation failed with HTTP ${res.status}`;
    const errorObj = new Error(message) as Error & { status?: number; code?: string };
    errorObj.status = res.status;
    errorObj.code = err.code;
    throw errorObj;
  }

  return await res.json();
}
