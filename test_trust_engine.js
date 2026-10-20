// ==================================================================================
// AUTOMATED TEST SUITE: MULTI-LAYER CRYPTOGRAPHIC TRUST SYSTEM
// Tests:
// 1. Invalid certificate fingerprints & package spoofing
// 2. Forged cryptographic signatures & tampered request bodies
// 3. Expired & valid hourly rotating tokens
// 4. Replay attacks with consumed nonces
// 5. Invalid device enrollment keys
// 6. Production configuration fallback & environment overrides
// Developer: Prince Singh
// ==================================================================================

const assert = require('assert');
const crypto = require('crypto');
const {
  DEFAULT_CONFIG,
  getExpectedConfig,
  verifyAppIdentity,
  derToPem,
  enrollDeviceKey,
  generateHourlyToken,
  verifyHourlyToken,
  buildCanonicalString,
  verifySignedRequest,
  checkRateLimit,
} = require('./netlify/functions/trustEngine');

console.log('===========================================================');
console.log('RUNNING MULTI-LAYER CRYPTOGRAPHIC TRUST SUITE');
console.log('===========================================================');

let testsPassed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    testsPassed++;
  } catch (err) {
    console.error(`  FAIL: ${name}`);
    console.error(`        ${err.message}`);
    process.exit(1);
  }
}

async function runAsyncTest(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    testsPassed++;
  } catch (err) {
    console.error(`  FAIL: ${name}`);
    console.error(`        ${err.message}`);
    process.exit(1);
  }
}

async function main() {
  // TEST 1: Production Configuration Verification
  runTest('1.1: Production Configuration loads expected fingerprints and package ID', () => {
    const config = getExpectedConfig();
    assert.strictEqual(config.allowedPkg, 'com.chandramauli.erp');
    assert.strictEqual(config.certSha256, 'D6CD70C7D5F05328797D2816790DD03612C0BABFE1A98F5AC75C12FE120FF92F');
    assert.strictEqual(config.certSha1, 'B45F83E674FC073598698F1ECD8BB2930E3B7281');
    assert.ok(config.rotationSecret.length > 10);
  });

  // TEST 2: Layer 1 - Fingerprint Verification & Spoofing Defense
  runTest('2.1: Valid SHA-256 certificate passes identity check', () => {
    const headers = {
      'x-app-package': 'com.chandramauli.erp',
      'x-app-signature-sha256': 'D6:CD:70:C7:D5:F0:53:28:79:7D:28:16:79:0D:D0:36:12:C0:BA:BF:E1:A9:8F:5A:C7:5C:12:FE:12:0F:F9:2F',
      'x-app-signature-sha1': 'B4:5F:83:E6:74:FC:07:35:98:69:8F:1E:CD:8B:B2:93:0E:3B:72:81',
    };
    const res = verifyAppIdentity(headers);
    assert.strictEqual(res.valid, true);
  });

  runTest('2.2: Invalid SHA-256 fingerprint fails with 403', () => {
    const headers = {
      'x-app-package': 'com.chandramauli.erp',
      'x-app-signature-sha256': 'AA:BB:CC:DD:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB',
    };
    const res = verifyAppIdentity(headers);
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.code, 403);
    assert.ok(res.error.includes('SHA-256 Mismatch'));
  });

  runTest('2.3: Spoofed package name fails with 403', () => {
    const headers = {
      'x-app-package': 'com.fake.attacker.app',
      'x-app-signature-sha256': 'D6CD70C7D5F05328797D2816790DD03612C0BAFE1A98F5AC75C12FE120FF92F',
    };
    const res = verifyAppIdentity(headers);
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.code, 403);
    assert.ok(res.error.includes('Untrusted Application Package'));
  });

  // TEST 3: Layer 2 - Device Key Enrollment & PEM Generation
  runTest('3.1: derToPem converts Base64 public key into standard PEM', () => {
    const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const der = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const pem = derToPem(der);
    assert.ok(pem.includes('-----BEGIN PUBLIC KEY-----'));
    assert.ok(pem.includes('-----END PUBLIC KEY-----'));
    const parsed = crypto.createPublicKey(pem);
    assert.strictEqual(parsed.asymmetricKeyType, 'ec');
  });

  await runAsyncTest('3.2: enrollDeviceKey rejects malformed public key', async () => {
    let threw = false;
    try {
      await enrollDeviceKey(null, {
        deviceId: 'DEV-TEST-001',
        publicKeyBase64: 'NOT_A_VALID_KEY_123',
      });
    } catch (e) {
      threw = true;
      assert.ok(e.message.includes('Invalid cryptographic public key'));
    }
    assert.ok(threw);
  });

  // TEST 4: Layer 3 - Hourly Rotating Tokens
  runTest('4.1: Hourly rotating token generates predictable HMAC-SHA256', () => {
    const tokenInfo = generateHourlyToken('DEV-1001');
    assert.ok(tokenInfo.token.length === 64);
    assert.ok(tokenInfo.expiresAt);
    assert.strictEqual(typeof tokenInfo.windowIndex, 'number');
  });

  runTest('4.2: verifyHourlyToken accepts token for current hour', () => {
    const tokenInfo = generateHourlyToken('DEV-1001');
    const valid = verifyHourlyToken('DEV-1001', tokenInfo.token);
    assert.strictEqual(valid, true);
  });

  runTest('4.3: verifyHourlyToken rejects expired token (from 3 hours ago)', () => {
    const expiredToken = generateHourlyToken('DEV-1001', -3).token;
    const valid = verifyHourlyToken('DEV-1001', expiredToken);
    assert.strictEqual(valid, false);
  });

  runTest('4.4: verifyHourlyToken rejects token bound to another device', () => {
    const tokenOther = generateHourlyToken('DEV-ALICE').token;
    const valid = verifyHourlyToken('DEV-BOB', tokenOther);
    assert.strictEqual(valid, false);
  });

  // TEST 5: Layer 4 - Signed Requests & Nonce Replay Defense
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const deviceId = 'DEV-VERIFIED-PHONE-01';

  // Mock Supabase client for unit test
  const mockNonces = new Set();
  const mockSupabase = {
    from: (table) => {
      if (table === 'device_keys') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { public_key_pem: pubPem, is_active: true },
              }),
            }),
          }),
        };
      }
      if (table === 'request_nonces') {
        return {
          select: () => ({
            eq: (col, val) => ({
              maybeSingle: async () => ({
                data: mockNonces.has(val) ? { nonce: val } : null,
              }),
            }),
          }),
          insert: async (row) => {
            mockNonces.add(row.nonce);
            return { error: null };
          },
        };
      }
      return {};
    },
  };

  await runAsyncTest('5.1: Valid cryptographically signed request passes verification', async () => {
    const method = 'POST';
    const path = '/bills';
    const body = { customerId: 'cust-1', amount: 500 };
    const timestamp = Date.now().toString();
    const nonce = 'NONCE-UNIQUE-001';
    const token = generateHourlyToken(deviceId).token;

    const canonical = buildCanonicalString(method, path, body, timestamp, nonce, deviceId);
    const signer = crypto.createSign('SHA256');
    signer.update(canonical);
    const signatureBase64 = signer.sign(privateKey, 'base64');

    const headers = {
      'x-device-id': deviceId,
      'x-request-timestamp': timestamp,
      'x-request-nonce': nonce,
      'x-request-signature': signatureBase64,
      'x-rotating-token': token,
    };

    const res = await verifySignedRequest({
      supabase: mockSupabase,
      method,
      path,
      body,
      headers,
    });

    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.deviceId, deviceId);
  });

  await runAsyncTest('5.2: Replayed request with consumed nonce is rejected (Replay Attack Defense)', async () => {
    const method = 'POST';
    const path = '/bills';
    const body = { customerId: 'cust-1', amount: 500 };
    const timestamp = Date.now().toString();
    const nonce = 'NONCE-UNIQUE-001'; // Already consumed above!
    const token = generateHourlyToken(deviceId).token;

    const canonical = buildCanonicalString(method, path, body, timestamp, nonce, deviceId);
    const signer = crypto.createSign('SHA256');
    signer.update(canonical);
    const signatureBase64 = signer.sign(privateKey, 'base64');

    const headers = {
      'x-device-id': deviceId,
      'x-request-timestamp': timestamp,
      'x-request-nonce': nonce,
      'x-request-signature': signatureBase64,
      'x-rotating-token': token,
    };

    const res = await verifySignedRequest({
      supabase: mockSupabase,
      method,
      path,
      body,
      headers,
    });

    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.code, 401);
    assert.ok(res.error.includes('Replay Attack Detected'));
  });

  await runAsyncTest('5.3: Forged signature on tampered payload is rejected', async () => {
    const method = 'POST';
    const path = '/bills';
    const originalBody = { customerId: 'cust-1', amount: 500 };
    const tamperedBody = { customerId: 'cust-1', amount: 500000 }; // Attacker modified amount!
    const timestamp = Date.now().toString();
    const nonce = 'NONCE-UNIQUE-002';
    const token = generateHourlyToken(deviceId).token;

    // Signed for original body
    const canonical = buildCanonicalString(method, path, originalBody, timestamp, nonce, deviceId);
    const signer = crypto.createSign('SHA256');
    signer.update(canonical);
    const signatureBase64 = signer.sign(privateKey, 'base64');

    // Server receives tamperedBody
    const headers = {
      'x-device-id': deviceId,
      'x-request-timestamp': timestamp,
      'x-request-nonce': nonce,
      'x-request-signature': signatureBase64,
      'x-rotating-token': token,
    };

    const res = await verifySignedRequest({
      supabase: mockSupabase,
      method,
      path,
      body: tamperedBody,
      headers,
    });

    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.code, 401);
    assert.ok(res.error.includes('Signature Verification Failed'));
  });

  await runAsyncTest('5.4: Stale timestamp (> 5 minutes old) is rejected', async () => {
    const method = 'POST';
    const path = '/bills';
    const body = { customerId: 'cust-1' };
    const staleTimestamp = (Date.now() - 400000).toString(); // 6.6 minutes ago
    const nonce = 'NONCE-UNIQUE-003';
    const token = generateHourlyToken(deviceId).token;

    const canonical = buildCanonicalString(method, path, body, staleTimestamp, nonce, deviceId);
    const signer = crypto.createSign('SHA256');
    signer.update(canonical);
    const signatureBase64 = signer.sign(privateKey, 'base64');

    const headers = {
      'x-device-id': deviceId,
      'x-request-timestamp': staleTimestamp,
      'x-request-nonce': nonce,
      'x-request-signature': signatureBase64,
      'x-rotating-token': token,
    };

    const res = await verifySignedRequest({
      supabase: mockSupabase,
      method,
      path,
      body,
      headers,
    });

    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.code, 401);
    assert.ok(res.error.includes('Stale Request Timestamp'));
  });

  // TEST 6: Rate Limiter
  runTest('6.1: Rate limiter enforces maximum window thresholds', () => {
    const testIp = '192.168.1.100';
    for (let i = 0; i < 120; i++) {
      assert.strictEqual(checkRateLimit(testIp), true);
    }
    // 121st request should be throttled
    assert.strictEqual(checkRateLimit(testIp), false);
  });

  console.log('===========================================================');
  console.log(`ALL ${testsPassed} AUTOMATED SECURITY TESTS PASSED PERFECTLY!`);
  console.log('===========================================================');
}

main().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
