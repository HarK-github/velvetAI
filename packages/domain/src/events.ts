import {
  TenantId,
  UserId,
  UUID,
} from "@velvetai/contracts";
import { InvariantViolationError } from "./errors.js";

export interface OutboxEventProps {
  id: UUID;
  tenantId: TenantId;
  aggregateType: string;
  aggregateId: UUID;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  attempts?: number;
  lastError?: string | null;
}

export class OutboxEvent {
  readonly id: UUID;
  readonly tenantId: TenantId;
  readonly aggregateType: string;
  readonly aggregateId: UUID;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  private _attempts: number;
  private _lastError: string | null;

  constructor(props: OutboxEventProps) {
    if (!props.tenantId) {
      throw new InvariantViolationError("Outbox event must contain non-null tenantId");
    }
    if (!props.eventType) {
      throw new InvariantViolationError("Outbox eventType cannot be empty");
    }
    this.id = props.id;
    this.tenantId = props.tenantId;
    this.aggregateType = props.aggregateType;
    this.aggregateId = props.aggregateId;
    this.eventType = props.eventType;
    this.payload = Object.freeze({ ...props.payload });
    this.createdAt = props.createdAt;
    this._attempts = props.attempts ?? 0;
    this._lastError = props.lastError ?? null;
  }

  get attempts(): number {
    return this._attempts;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  recordAttemptFailure(error: string): void {
    this._attempts += 1;
    this._lastError = error;
  }
}

export interface InboxEventProps {
  id: UUID;
  consumerName: string;
  eventId: UUID;
  processedAt: Date;
}

export class InboxEvent {
  readonly id: UUID;
  readonly consumerName: string;
  readonly eventId: UUID;
  readonly processedAt: Date;

  constructor(props: InboxEventProps) {
    if (!props.consumerName) {
      throw new InvariantViolationError("Inbox event must specify consumerName");
    }
    this.id = props.id;
    this.consumerName = props.consumerName;
    this.eventId = props.eventId;
    this.processedAt = props.processedAt;
    Object.freeze(this);
  }
}

export interface AuditEventProps {
  id: UUID;
  tenantId: TenantId;
  actorId?: UserId | null;
  actorType: "USER" | "AGENT" | "WORKER" | "SYSTEM";
  action: string;
  resourceType: string;
  resourceId?: UUID | null;
  metadataRedacted: Record<string, unknown>;
  occurredAt: Date;
}

export class AuditEvent {
  readonly id: UUID;
  readonly tenantId: TenantId;
  readonly actorId: UserId | null;
  readonly actorType: "USER" | "AGENT" | "WORKER" | "SYSTEM";
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: UUID | null;
  readonly metadataRedacted: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;

  constructor(props: AuditEventProps) {
    if (!props.tenantId) {
      throw new InvariantViolationError("Audit event must contain non-null tenantId");
    }
    if (!props.action) {
      throw new InvariantViolationError("Audit action cannot be empty");
    }

    this.id = props.id;
    this.tenantId = props.tenantId;
    this.actorId = props.actorId ?? null;
    this.actorType = props.actorType;
    this.action = props.action;
    this.resourceType = props.resourceType;
    this.resourceId = props.resourceId ?? null;
    this.metadataRedacted = Object.freeze({ ...props.metadataRedacted });
    this.occurredAt = props.occurredAt;

    // Strict immutability: Audit events are append-only
    Object.freeze(this);
  }
}
