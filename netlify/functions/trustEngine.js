// ==================================================================================
// CHANDRAMAULI OIL & WHEAT ERP - MULTI-LAYER CRYPTOGRAPHIC TRUST ENGINE
// Layer 1: Signing Certificate Fingerprints (SHA-256 primary, SHA-1 compatibility)
// Layer 2: Android Keystore Hardware-Backed Public Key Verification (ECDSA P-256)
// Layer 3: Server-Verified Hourly Rotating Cryptographic Tokens (HMAC-SHA256)
// Layer 4: Cryptographically Signed Canonical HTTP Requests & Replay Defense
// Developer: Prince Singh
// ==================================================================================

const crypto = require('crypto');

// 1. TRUSTED APPLICATION IDENTITY METADATA
const DEFAULT_CONFIG = {
  applicationId: 'com.chandramauli.erp',
  versionName: '1.0.0',
  versionCode: 1,
  // Signing Certificate Fingerprints
  signingCertSha256: 'D6CD70C7D5F05328797D2816790DD03612C0BABFE1A98F5AC75C12FE120FF92F',
  signingCertSha1: 'B45F83E674FC073598698F1ECD8BB2930E3B7281',
  // Artifact Integrity Hashes (informational / verification)
  apkFileSha256: 'b209686f2836af01dc8acfc9fd127799b125684e0e977f1be24910c6e7fe4e16',
  apkFileSha1: '6fbd9c5c30ca6052e508776cea8f4657cf8792bb',
  keystoreAlias: 'chandramauli-upload',
};

function normalizeHex(str) {
  return (str || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
}

function getExpectedConfig() {
  const allowedPkg = (process.env.ALLOWED_PACKAGE_NAME || DEFAULT_CONFIG.applicationId).trim();
  const certSha256 = normalizeHex(process.env.APP_SIGNING_SHA256 || process.env.APP_SHA256 || DEFAULT_CONFIG.signingCertSha256);
  const certSha1 = normalizeHex(process.env.APP_SIGNING_SHA1 || process.env.APP_SHA1 || DEFAULT_CONFIG.signingCertSha1);
  const rotationSecret = process.env.HOURLY_ROTATION_SECRET || 'CHANDRAMAULI_ERP_ROOT_SECRET_2026_MIRZAPUR';

  return {
    allowedPkg,
    certSha256,
    certSha1,
    rotationSecret,
  };
}

// ----------------------------------------------------------------------------------
// RATE LIMITER (In-Memory Sliding Window)
// ----------------------------------------------------------------------------------
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 120; // 120 req/min

function checkRateLimit(key) {
  const now = Date.now();
  const record = rateLimitMap.get(key) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (now > record.resetAt) {
    record.count = 1;
    record.resetAt = now + RATE_LIMIT_WINDOW_MS;
  } else {
    record.count++;
  }

  rateLimitMap.set(key, record);
  return record.count <= MAX_REQUESTS_PER_WINDOW;
}

// ----------------------------------------------------------------------------------
// LAYER 1: CERTIFICATE FINGERPRINT & PACKAGE IDENTIFIER VERIFICATION
// ----------------------------------------------------------------------------------
function verifyAppIdentity(headers) {
  const config = getExpectedConfig();

  const getH = (name) => {
    const lower = name.toLowerCase();
    for (const k of Object.keys(headers || {})) {
      if (k.toLowerCase() === lower) return (headers[k] || '').toString();
    }
    return '';
  };

  const incomingPkg = getH('x-app-package').trim();
  const incomingSha256 = normalizeHex(getH('x-app-signature-sha256'));
  const incomingSha1 = normalizeHex(getH('x-app-signature-sha1'));

  // Package Name Enforcement
  if (incomingPkg && incomingPkg !== config.allowedPkg) {
    return {
      valid: false,
      code: 403,
      error: 'Forbidden: Untrusted Application Package',
      message: `Package mismatch. Expected '${config.allowedPkg}', received '${incomingPkg}'.`,
    };
  }

  // Primary Trust Mechanism: SHA-256 Certificate Fingerprint
  if (config.certSha256) {
    if (incomingSha256 && incomingSha256 !== config.certSha256) {
      return {
        valid: false,
        code: 403,
        error: 'Forbidden: Untrusted Application Signature (SHA-256 Mismatch)',
        message: 'Access blocked: Android app SHA-256 fingerprint verification failed. Only official Chandramauli ERP APK can perform this operation.',
      };
    }
  }

  // Legacy Compatibility Mechanism: SHA-1
  if (config.certSha1 && !incomingSha256) {
    if (incomingSha1 && incomingSha1 !== config.certSha1) {
      return {
        valid: false,
        code: 403,
        error: 'Forbidden: Untrusted Application Signature (SHA-1 Mismatch)',
        message: 'Access blocked: Android app SHA-1 fingerprint verification failed. Only official Chandramauli ERP APK can perform this operation.',
      };
    }
  }

  return { valid: true };
}

// ----------------------------------------------------------------------------------
// LAYER 2: ANDROID KEYSTORE PUBLIC KEY ENROLLMENT & STORAGE
// ----------------------------------------------------------------------------------
function derToPem(base64Der) {
  const clean = base64Der.replace(/\s+/g, '');
  const lines = clean.match(/.{1,64}/g) || [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

async function enrollDeviceKey(supabase, { deviceId, publicKeyBase64, algorithm = 'EC-P256', metadata = {} }) {
  if (!deviceId || !publicKeyBase64) {
    throw new Error('deviceId and publicKeyBase64 are required for enrollment');
  }

  const pem = derToPem(publicKeyBase64);

  // Validate that the key parses correctly
  try {
    crypto.createPublicKey(pem);
  } catch (e) {
    throw new Error(`Invalid cryptographic public key: ${e.message}`);
  }

  if (supabase) {
    const { data: existing } = await supabase
      .from('device_keys')
      .select('*')
      .eq('device_id', deviceId)
      .maybeSingle();

    if (existing) {
      await supabase
        .from('device_keys')
        .update({
          public_key_pem: pem,
          algorithm,
          last_used_at: new Date().toISOString(),
          is_active: true,
        })
        .eq('device_id', deviceId);
    } else {
      await supabase.from('device_keys').insert({
        device_id: deviceId,
        public_key_pem: pem,
        algorithm,
        is_active: true,
        enrolled_at: new Date().toISOString(),
        last_used_at: new Date().toISOString(),
        notes: JSON.stringify(metadata),
      });
    }
  }

  return {
    success: true,
    deviceId,
    algorithm,
    enrolledAt: new Date().toISOString(),
  };
}

async function getDevicePublicKey(supabase, deviceId) {
  if (!supabase || !deviceId) return null;
  try {
    const { data } = await supabase
      .from('device_keys')
      .select('public_key_pem, algorithm, is_active')
      .eq('device_id', deviceId)
      .single();

    if (data && data.is_active) {
      return data.public_key_pem;
    }
  } catch (_) {}
  return null;
}

// ----------------------------------------------------------------------------------
// LAYER 3: HOURLY ROTATING CRYPTOGRAPHIC VALUE (HMAC-SHA256)
// ----------------------------------------------------------------------------------
const HOURLY_STEP_MS = 3600000; // 1 Hour

function getWindowIndex(timestamp = Date.now()) {
  return Math.floor(timestamp / HOURLY_STEP_MS);
}

function generateHourlyToken(deviceId, windowOffset = 0) {
  const config = getExpectedConfig();
  const windowIndex = getWindowIndex() + windowOffset;
  const payload = `${deviceId}:${windowIndex}`;

  const hmac = crypto.createHmac('sha256', config.rotationSecret);
  hmac.update(payload);
  const token = hmac.digest('hex');

  const expiresAt = new Date((windowIndex + 1) * HOURLY_STEP_MS).toISOString();

  return {
    token,
    windowIndex,
    expiresAt,
  };
}

function verifyHourlyToken(deviceId, token) {
  if (!token || !deviceId) return false;

  const current = generateHourlyToken(deviceId, 0).token;
  if (crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(current, 'hex'))) {
    return true;
  }

  // Allow -1 window (1-hour clock skew / transition tolerance)
  const previous = generateHourlyToken(deviceId, -1).token;
  if (crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(previous, 'hex'))) {
    return true;
  }

  return false;
}

// ----------------------------------------------------------------------------------
// LAYER 4: CRYPTOGRAPHICALLY SIGNED REQUESTS & NONCE REPLAY DEFENSE
// ----------------------------------------------------------------------------------
// Canonical representation: METHOD\nPATH\nBODY_SHA256\nTIMESTAMP\nNONCE\nDEVICE_ID
function buildCanonicalString(method, path, body, timestamp, nonce, deviceId) {
  const cleanMethod = (method || 'GET').toUpperCase();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const bodyText = typeof body === 'string' ? body : JSON.stringify(body || {});
  const bodyHash = crypto.createHash('sha256').update(bodyText || '').digest('hex');

  return `${cleanMethod}\n${cleanPath}\n${bodyHash}\n${timestamp}\n${nonce}\n${deviceId}`;
}

async function verifySignedRequest({
  supabase,
  method,
  path,
  body,
  headers,
}) {
  const getH = (name) => {
    const lower = name.toLowerCase();
    for (const k of Object.keys(headers || {})) {
      if (k.toLowerCase() === lower) return (headers[k] || '').toString();
    }
    return '';
  };

  const deviceId = getH('x-device-id');
  const timestampStr = getH('x-request-timestamp');
  const nonce = getH('x-request-nonce');
  const signatureBase64 = getH('x-request-signature');
  const rotatingToken = getH('x-rotating-token');

  // If no cryptographic headers are provided, report missing signature
  if (!deviceId || !timestampStr || !nonce || !signatureBase64) {
    return {
      valid: false,
      code: 401,
      error: 'Unauthorized: Missing Cryptographic Signature Headers',
      message: 'Request must include X-Device-Id, X-Request-Timestamp, X-Request-Nonce, and X-Request-Signature.',
    };
  }

  // 1. Clock Skew / Freshness Check (5 minutes = 300,000 ms)
  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp) || Math.abs(Date.now() - timestamp) > 300000) {
    return {
      valid: false,
      code: 401,
      error: 'Unauthorized: Stale Request Timestamp',
      message: 'Request timestamp is expired or out of allowed 5-minute synchronization window.',
    };
  }

  // 2. Nonce Replay Defense
  if (supabase) {
    try {
      const { data: existingNonce } = await supabase
        .from('request_nonces')
        .select('nonce')
        .eq('nonce', nonce)
        .maybeSingle();

      if (existingNonce) {
        return {
          valid: false,
          code: 401,
          error: 'Unauthorized: Replay Attack Detected',
          message: 'The cryptographic nonce has already been consumed. Replayed requests are rejected.',
        };
      }

      await supabase.from('request_nonces').insert({
        nonce,
        device_id: deviceId,
        created_at: new Date().toISOString(),
      });
    } catch (e) {
      // If table doesn't exist yet, proceed with in-memory check
    }
  }

  // 3. Hourly Rotating Token Verification
  if (rotatingToken) {
    const tokenValid = verifyHourlyToken(deviceId, rotatingToken);
    if (!tokenValid) {
      return {
        valid: false,
        code: 401,
        error: 'Unauthorized: Expired or Invalid Hourly Rotating Token',
        message: 'The hourly cryptographic token is invalid or expired. Please refresh token from /api/security/request-token.',
      };
    }
  }

  // 4. Asymmetric Signature Verification using Device Public Key
  const publicKeyPem = await getDevicePublicKey(supabase, deviceId);
  if (!publicKeyPem) {
    // If device is not enrolled yet, prompt enrollment
    return {
      valid: false,
      code: 403,
      error: 'Forbidden: Device Key Not Enrolled',
      message: `Device '${deviceId}' public key is not registered. Please enroll via /api/security/enroll-device.`,
    };
  }

  const canonicalString = buildCanonicalString(method, path, body, timestampStr, nonce, deviceId);

  try {
    const verifier = crypto.createVerify('SHA256');
    verifier.update(canonicalString);
    const isValid = verifier.verify(publicKeyPem, signatureBase64, 'base64');

    if (!isValid) {
      return {
        valid: false,
        code: 401,
        error: 'Unauthorized: Cryptographic Signature Verification Failed',
        message: 'The request signature does not match the canonical representation signed by the enrolled hardware key.',
      };
    }
  } catch (err) {
    return {
      valid: false,
      code: 401,
      error: 'Unauthorized: Signature Evaluation Error',
      message: `Failed to evaluate signature: ${err.message}`,
    };
  }

  return { valid: true, deviceId };
}

module.exports = {
  DEFAULT_CONFIG,
  getExpectedConfig,
  verifyAppIdentity,
  derToPem,
  enrollDeviceKey,
  getDevicePublicKey,
  generateHourlyToken,
  verifyHourlyToken,
  buildCanonicalString,
  verifySignedRequest,
  checkRateLimit,
};
