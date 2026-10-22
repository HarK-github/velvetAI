import { Kysely } from "kysely";
import { Database, withTenantTransaction } from "@velvetai/db";
import {
  ServiceDTO,
  ServiceVersionDTO,
  ServiceId,
  ServiceVersionId,
  TenantId,
  CancellationPolicyId,
  CurrencyCode,
  MoneyMinor,
} from "@velvetai/contracts";

export class CatalogService {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Lists active services for a tenant with their published current versions.
   * Runs within withTenantTransaction for RLS enforcement.
   */
  async listServices(tenantId: TenantId): Promise<ServiceDTO[]> {
    return await withTenantTransaction(this.db, tenantId, async (trx) => {
      const rows = await trx
        .selectFrom("services")
        .innerJoin("service_versions", "service_versions.id", "services.current_version_id")
        .where("services.tenant_id", "=", tenantId)
        .where("services.status", "=", "ACTIVE")
        .select([
          "services.id as service_id",
          "services.tenant_id as tenant_id",
          "services.status as service_status",
          "services.current_version_id as current_version_id",
          "service_versions.id as version_id",
          "service_versions.version as version_num",
          "service_versions.name as version_name",
          "service_versions.description as version_description",
          "service_versions.duration_minutes as duration_minutes",
          "service_versions.buffer_before_minutes as buffer_before_minutes",
          "service_versions.buffer_after_minutes as buffer_after_minutes",
          "service_versions.price_minor as price_minor",
          "service_versions.base_deposit_minor as base_deposit_minor",
          "service_versions.currency as currency",
          "service_versions.cancellation_policy_id as cancellation_policy_id",
          "service_versions.published_at as published_at",
        ])
        .orderBy("service_versions.name", "asc")
        .execute();

      return rows.map((r) => {
        const version: ServiceVersionDTO = {
          id: r.version_id as ServiceVersionId,
          tenantId: r.tenant_id as TenantId,
          serviceId: r.service_id as ServiceId,
          version: r.version_num,
          name: r.version_name,
          description: r.version_description ?? undefined,
          durationMinutes: r.duration_minutes,
          bufferBeforeMinutes: r.buffer_before_minutes,
          bufferAfterMinutes: r.buffer_after_minutes,
          priceMinor: String(r.price_minor) as MoneyMinor,
          baseDepositMinor: String(r.base_deposit_minor) as MoneyMinor,
          currency: r.currency as CurrencyCode,
          cancellationPolicyId: r.cancellation_policy_id as CancellationPolicyId,
          publishedAt: new Date(r.published_at).toISOString(),
        };

        return {
          id: r.service_id as ServiceId,
          tenantId: r.tenant_id as TenantId,
          status: r.service_status as "ACTIVE" | "DRAFT" | "ARCHIVED",
          currentVersionId: r.current_version_id as ServiceVersionId,
          versions: [version],
        };
      });
    });
  }

  /**
   * Retrieves a single active service by ID with its published version.
   */
  async getService(tenantId: TenantId, serviceId: ServiceId): Promise<ServiceDTO | null> {
    return await withTenantTransaction(this.db, tenantId, async (trx) => {
      const row = await trx
        .selectFrom("services")
        .innerJoin("service_versions", "service_versions.id", "services.current_version_id")
        .where("services.tenant_id", "=", tenantId)
        .where("services.id", "=", serviceId)
        .where("services.status", "=", "ACTIVE")
        .select([
          "services.id as service_id",
          "services.tenant_id as tenant_id",
          "services.status as service_status",
          "services.current_version_id as current_version_id",
          "service_versions.id as version_id",
          "service_versions.version as version_num",
          "service_versions.name as version_name",
          "service_versions.description as version_description",
          "service_versions.duration_minutes as duration_minutes",
          "service_versions.buffer_before_minutes as buffer_before_minutes",
          "service_versions.buffer_after_minutes as buffer_after_minutes",
          "service_versions.price_minor as price_minor",
          "service_versions.base_deposit_minor as base_deposit_minor",
          "service_versions.currency as currency",
          "service_versions.cancellation_policy_id as cancellation_policy_id",
          "service_versions.published_at as published_at",
        ])
        .executeTakeFirst();

      if (!row) return null;

      const version: ServiceVersionDTO = {
        id: row.version_id as ServiceVersionId,
        tenantId: row.tenant_id as TenantId,
        serviceId: row.service_id as ServiceId,
        version: row.version_num,
        name: row.version_name,
        description: row.version_description ?? undefined,
        durationMinutes: row.duration_minutes,
        bufferBeforeMinutes: row.buffer_before_minutes,
        bufferAfterMinutes: row.buffer_after_minutes,
        priceMinor: String(row.price_minor) as MoneyMinor,
        baseDepositMinor: String(row.base_deposit_minor) as MoneyMinor,
        currency: row.currency as CurrencyCode,
        cancellationPolicyId: row.cancellation_policy_id as CancellationPolicyId,
        publishedAt: new Date(row.published_at).toISOString(),
      };

      return {
        id: row.service_id as ServiceId,
        tenantId: row.tenant_id as TenantId,
        status: row.service_status as "ACTIVE" | "DRAFT" | "ARCHIVED",
        currentVersionId: row.current_version_id as ServiceVersionId,
        versions: [version],
      };
    });
  }
}
