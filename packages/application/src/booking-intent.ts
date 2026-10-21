import crypto from "node:crypto";
import * as jose from "jose";
import {
  SignedBookingIntentClaims,
  signedBookingIntentClaimsSchema,
} from "@velvetai/contracts";
import { canonicalJson } from "./canonicalizer.js";

export interface IntentKeyConfig {
  kid: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

// In-memory key store for active and rotated signing keys
const intentKeyStore = new Map<string, IntentKeyConfig>();

// Generate a default deterministic ES256 keypair for dev/testing if not supplied
let defaultKeyPair: IntentKeyConfig | null = null;

export function getDefaultIntentKeys(): IntentKeyConfig {
  if (!defaultKeyPair) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    defaultKeyPair = {
      kid: "key-velvetai-1",
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
    };
    registerIntentKey(defaultKeyPair);
  }
  return defaultKeyPair;
}

/**
 * Registers an ES256 keypair in the key store to support key rotation.
 */
export function registerIntentKey(keyConfig: IntentKeyConfig): void {
  intentKeyStore.set(keyConfig.kid, keyConfig);
}

/**
 * Retrieves an ES256 key by its key ID (`kid`).
 */
export function getIntentKey(kid: string): IntentKeyConfig | undefined {
  return intentKeyStore.get(kid);
}

export interface SignIntentOptions {
  keyConfig?: IntentKeyConfig;
  kid?: string;
}

export interface VerifyIntentOptions {
  keyConfig?: IntentKeyConfig;
  keyStore?: Map<string, IntentKeyConfig>;
  expectedIssuer?: string;
  expectedAudience?: string;
  asOfSeconds?: number;
}

export class IntentVerificationError extends Error {
  constructor(message: string, public readonly code: string = "INTENT_VERIFICATION_FAILED") {
    super(message);
    this.name = "IntentVerificationError";
  }
}

/**
 * Creates an ES256 JWS signed booking intent matching Specification v1.1 Amendment Section D.3.
 * Uses P-256 curve (prime256v1) and IEEE P1363 (R || S) 64-byte signature formatting.
 */
export function signBookingIntent(
  claims: SignedBookingIntentClaims,
  options?: SignIntentOptions,
): string {
  const keyConfig = options?.keyConfig ?? getDefaultIntentKeys();
  const kid = options?.kid ?? keyConfig.kid;

  // Validate claims schema
  const parsedClaims = signedBookingIntentClaimsSchema.parse(claims);

  const header = {
    alg: "ES256",
    typ: "velvetai-intent+jwt",
    kid,
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  // Payload canonicalized per RFC 8785
  const payloadB64 = Buffer.from(canonicalJson(parsedClaims)).toString("base64url");
  const signingInput = `${headerB64}.${payloadB64}`;

  // Sign using ES256 (ECDSA with P-256 and SHA-256, IEEE P1363 encoding = 64 bytes)
  const signature = crypto.sign(
    "SHA256",
    Buffer.from(signingInput),
    {
      key: keyConfig.privateKeyPem,
      dsaEncoding: "ieee-p1363",
    },
  );

  if (signature.length !== 64) {
    throw new Error(`Invalid signature length: expected 64 bytes for IEEE P1363, got ${signature.length}`);
  }

  const signatureB64 = signature.toString("base64url");
  return `${signingInput}.${signatureB64}`;
}

/**
 * Asynchronous signing using standard `jose` package for interoperability proof.
 */
export async function signBookingIntentWithJose(
  claims: SignedBookingIntentClaims,
  options?: SignIntentOptions,
): Promise<string> {
  const keyConfig = options?.keyConfig ?? getDefaultIntentKeys();
  const kid = options?.kid ?? keyConfig.kid;
  const parsedClaims = signedBookingIntentClaimsSchema.parse(claims);

  const privateKey = await jose.importPKCS8(keyConfig.privateKeyPem, "ES256");
  const canonicalPayload = new TextEncoder().encode(canonicalJson(parsedClaims));

  return await new jose.CompactSign(canonicalPayload)
    .setProtectedHeader({ alg: "ES256", typ: "velvetai-intent+jwt", kid })
    .sign(privateKey);
}

/**
 * Verifies an ES256 JWS signed booking intent strictly enforcing:
 * - alg: ES256 allowlist only (rejects 'none', HS256, RSA)
 * - typ: velvetai-intent+jwt
 * - kid: known configured key ID in keyStore (supports rotation)
 * - Signature: exactly 64-byte raw IEEE-P1363 (32 bytes R || 32 bytes S)
 * - No remote jku or x5u allowed
 * - Pinned issuer and audience
 * - Cryptographic signature
 * - Time bounds (nbf, exp)
 */
export function verifyBookingIntent(
  jws: string,
  options?: VerifyIntentOptions,
): SignedBookingIntentClaims {
  if (typeof jws !== "string") {
    throw new IntentVerificationError("Intent must be a string", "INVALID_INTENT_FORMAT");
  }

  const parts = jws.split(".");
  if (parts.length !== 3) {
    throw new IntentVerificationError(
      "Intent must have three dot-separated components",
      "INVALID_JWS_STRUCTURE",
    );
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  if (!headerB64 || !payloadB64) {
    throw new IntentVerificationError("Malformed JWS segments", "MALFORMED_JWS_SEGMENT");
  }

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
  } catch {
    throw new IntentVerificationError("Failed to parse JWS header JSON", "INVALID_HEADER_JSON");
  }

  // JWS Rule: Exact typ
  if (header.typ !== "velvetai-intent+jwt") {
    throw new IntentVerificationError(
      `Invalid JWS typ: expected 'velvetai-intent+jwt', got '${header.typ}'`,
      "WRONG_TYP",
    );
  }

  // JWS Rule: ES256 allowlist only
  if (header.alg !== "ES256") {
    throw new IntentVerificationError(
      `Unsupported JWS algorithm '${header.alg}', only 'ES256' is permitted`,
      "ALGORITHM_NOT_PERMITTED",
    );
  }

  if (!signatureB64) {
    throw new IntentVerificationError("Malformed JWS segments: missing signature", "MALFORMED_JWS_SEGMENT");
  }

  // JWS Rule: Reject remote jku / x5u
  if ("jku" in header || "x5u" in header) {
    throw new IntentVerificationError(
      "Remote jku or x5u headers are prohibited",
      "REMOTE_KEY_HEADER_PROHIBITED",
    );
  }

  // JWS Rule: Exactly 64-byte IEEE-P1363 signature for ES256
  const signature = Buffer.from(signatureB64, "base64url");
  if (signature.length !== 64) {
    throw new IntentVerificationError(
      `Invalid ES256 signature length: expected 64 bytes (IEEE P1363), got ${signature.length}`,
      "INVALID_SIGNATURE_LENGTH",
    );
  }

  // Resolve key via keyConfig or keyStore (key rotation support)
  const headerKid = typeof header.kid === "string" ? header.kid : undefined;
  if (!headerKid) {
    throw new IntentVerificationError("Missing required 'kid' in JWS header", "MISSING_KID");
  }

  let keyConfig = options?.keyConfig;
  if (!keyConfig) {
    const store = options?.keyStore ?? intentKeyStore;
    keyConfig = store.get(headerKid);
    if (!keyConfig && headerKid === getDefaultIntentKeys().kid) {
      keyConfig = getDefaultIntentKeys();
    }
  }

  if (!keyConfig || keyConfig.kid !== headerKid) {
    throw new IntentVerificationError(
      `Unknown kid '${headerKid}'; key not found in active key store`,
      "UNKNOWN_KID",
    );
  }

  // Verify cryptographic signature
  const signingInput = `${headerB64}.${payloadB64}`;
  let isValidSignature = false;
  try {
    isValidSignature = crypto.verify(
      "SHA256",
      Buffer.from(signingInput),
      {
        key: keyConfig.publicKeyPem,
        dsaEncoding: "ieee-p1363",
      },
      signature,
    );
  } catch {
    isValidSignature = false;
  }

  if (!isValidSignature) {
    throw new IntentVerificationError("Cryptographic signature verification failed", "INVALID_SIGNATURE");
  }

  // Parse claims
  let rawClaims: unknown;
  try {
    rawClaims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    throw new IntentVerificationError("Failed to parse JWS payload JSON", "INVALID_PAYLOAD_JSON");
  }

  const parseResult = signedBookingIntentClaimsSchema.safeParse(rawClaims);
  if (!parseResult.success) {
    throw new IntentVerificationError(
      `Claims schema validation failed: ${parseResult.error.message}`,
      "INVALID_CLAIMS_SCHEMA",
    );
  }

  const claims = parseResult.data;
  const nowSec = options?.asOfSeconds ?? Math.floor(Date.now() / 1000);

  // Time validity checks
  if (nowSec >= claims.exp) {
    throw new IntentVerificationError("Intent has expired", "INTENT_EXPIRED");
  }
  if (nowSec < claims.nbf) {
    throw new IntentVerificationError("Intent is not yet valid (nbf in future)", "INTENT_NOT_YET_VALID");
  }

  // Pinned issuer and audience checks
  if (options?.expectedIssuer && claims.iss !== options.expectedIssuer) {
    throw new IntentVerificationError(
      `Intent issuer mismatch: expected '${options.expectedIssuer}', got '${claims.iss}'`,
      "ISSUER_MISMATCH",
    );
  }
  if (options?.expectedAudience && claims.aud !== options.expectedAudience) {
    throw new IntentVerificationError(
      `Intent audience mismatch: expected '${options.expectedAudience}', got '${claims.aud}'`,
      "AUDIENCE_MISMATCH",
    );
  }

  return claims;
}

/**
 * Asynchronous verification using standard `jose` package for interoperability proof.
 */
export async function verifyBookingIntentWithJose(
  jws: string,
  options?: VerifyIntentOptions,
): Promise<SignedBookingIntentClaims> {
  const keyConfig = options?.keyConfig ?? getDefaultIntentKeys();
  const publicKey = await jose.importSPKI(keyConfig.publicKeyPem, "ES256");

  const { payload, protectedHeader } = await jose.compactVerify(jws, publicKey);

  if (protectedHeader.typ !== "velvetai-intent+jwt") {
    throw new IntentVerificationError("Invalid JWS typ in jose verification", "WRONG_TYP");
  }
  if (protectedHeader.alg !== "ES256") {
    throw new IntentVerificationError("Invalid JWS alg in jose verification", "ALGORITHM_NOT_PERMITTED");
  }

  const rawClaims = JSON.parse(new TextDecoder().decode(payload));
  return signedBookingIntentClaimsSchema.parse(rawClaims);
}
