import { z } from "zod";
import {
  tenantIdSchema,
  serviceIdSchema,
  serviceVersionIdSchema,
  locationIdSchema,
  resourceIdSchema,
  cancellationPolicyIdSchema,
  currencyCodeSchema,
  moneyMinorSchema,
  ianaTimeZoneSchema,
} from "./primitives.js";

export const locationSchema = z.object({
  id: locationIdSchema,
  tenantId: tenantIdSchema,
  name: z.string().min(1).max(100),
  timezone: ianaTimeZoneSchema,
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
});
export type LocationDTO = z.infer<typeof locationSchema>;

export const resourceTypeSchema = z.enum(["STAFF", "ROOM", "EQUIPMENT"]);
export type ResourceType = z.infer<typeof resourceTypeSchema>;

export const resourceSchema = z.object({
  id: resourceIdSchema,
  tenantId: tenantIdSchema,
  locationId: locationIdSchema,
  resourceType: resourceTypeSchema,
  displayName: z.string().min(1).max(100),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
});
export type ResourceDTO = z.infer<typeof resourceSchema>;

export const cancellationPolicyTierSchema = z.object({
  hoursBeforeStart: z.number().int().min(0),
  refundPercent: z.number().int().min(0).max(100),
});

export const cancellationPolicySchema = z.object({
  id: cancellationPolicyIdSchema,
  tenantId: tenantIdSchema,
  version: z.number().int().positive(),
  summary: z.string().min(1).max(500),
  tiers: z.array(cancellationPolicyTierSchema).default([]),
});
export type CancellationPolicyDTO = z.infer<typeof cancellationPolicySchema>;

export const serviceVersionSchema = z.object({
  id: serviceVersionIdSchema,
  tenantId: tenantIdSchema,
  serviceId: serviceIdSchema,
  version: z.number().int().positive(),
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  durationMinutes: z.number().int().min(5).max(480),
  bufferBeforeMinutes: z.number().int().min(0).max(240).default(0),
  bufferAfterMinutes: z.number().int().min(0).max(240).default(0),
  priceMinor: moneyMinorSchema,
  baseDepositMinor: moneyMinorSchema,
  currency: currencyCodeSchema,
  cancellationPolicyId: cancellationPolicyIdSchema,
  publishedAt: z.string().datetime({ offset: true }),
});
export type ServiceVersionDTO = z.infer<typeof serviceVersionSchema>;

export const serviceSchema = z.object({
  id: serviceIdSchema,
  tenantId: tenantIdSchema,
  status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).default("ACTIVE"),
  currentVersionId: serviceVersionIdSchema.nullable().optional(),
  versions: z.array(serviceVersionSchema).optional(),
});
export type ServiceDTO = z.infer<typeof serviceSchema>;
