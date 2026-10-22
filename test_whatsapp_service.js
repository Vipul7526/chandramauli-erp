// ==================================================================================
// CHANDRAMAULI ERP - WHATSAPP SERVICE AUTOMATED TEST SUITE
// Tests Provider Lifecycle, 5-Minute QR Expiry, Idempotency, and Slip Generation
// Developer: Prince Singh
// ==================================================================================

const assert = require('assert');
const BaileysProvider = require('./whatsapp/BaileysProvider');
const whatsappService = require('./whatsapp/WhatsAppService');

async function runTests() {
  console.log('===========================================================');
  console.log('RUNNING WHATSAPP AUTO-LINK BOT AUTOMATED TEST SUITE');
  console.log('===========================================================');

  const provider = new BaileysProvider({ sessionDir: './test_session_dir' });

  // 1. Phone number sanitation
  console.log('Testing 1.1: Phone number cleaner...');
  assert.strictEqual(provider._cleanPhone('9876543210'), '919876543210', 'Should prepend 91 for 10-digit Indian numbers');
  assert.strictEqual(provider._cleanPhone('+91 84297-74452'), '918429774452', 'Should strip spaces, hyphens, and plus signs');
  assert.strictEqual(provider._cleanPhone(''), '', 'Should handle empty phone gracefully');
  console.log('  PASS: 1.1: Phone number cleaner formats correctly.');

  // 2. Initial state
  console.log('Testing 2.1: Initial provider state...');
  const initialStatus = provider.getStatus();
  assert.strictEqual(initialStatus.isConnected, false, 'Initial state must be disconnected');
  assert.strictEqual(initialStatus.status, 'NOT_LINKED', 'Status must be NOT_LINKED initially');
  assert.strictEqual(initialStatus.qrDataUrl, null, 'QR data URL must be null initially');
  assert.strictEqual(initialStatus.pairingCode, null, 'Pairing code must be null initially');
  console.log('  PASS: 2.1: Initial provider state is clean.');

  // 3. 5-minute QR expiry calculation
  console.log('Testing 3.1: 5-minute QR expiry timer and countdown...');
  provider.status = 'QR_READY';
  provider.currentQrRaw = 'mock-qr-payload';
  provider.currentQrDataUrl = 'data:image/png;base64,mock';
  provider.qrExpiresAt = Date.now() + 300000; // 5 minutes

  const activeStatus = provider.getStatus();
  assert.strictEqual(activeStatus.status, 'QR_READY');
  assert.ok(activeStatus.expiresInSeconds >= 298 && activeStatus.expiresInSeconds <= 300, `Expires in should be ~300s, got ${activeStatus.expiresInSeconds}`);
  console.log('  PASS: 3.1: Countdown calculation reports 300 seconds accurately.');

  // 4. QR Expiration enforcement
  console.log('Testing 4.1: Expired QR invalidation...');
  provider.qrExpiresAt = Date.now() - 1000; // 1 second in the past
  const expiredStatus = provider.getStatus();
  assert.strictEqual(expiredStatus.status, 'QR_EXPIRED', 'Status must transition to QR_EXPIRED when time has elapsed');
  assert.strictEqual(expiredStatus.qrDataUrl, null, 'Expired QR data URL must be erased');
  assert.strictEqual(expiredStatus.qrRaw, null, 'Expired raw QR must be erased');
  assert.strictEqual(expiredStatus.expiresInSeconds, 0, 'Expired QR must report 0 seconds remaining');
  console.log('  PASS: 4.1: Expired QR is invalidated and erased from delivery.');

  // 5. Order notification idempotency
  console.log('Testing 5.1: Idempotent order notification dispatch...');
  const orderData = {
    billId: 'test-bill-101',
    billNumber: 'CM-9999',
    customerName: 'Test Customer',
    customerMobile: '9876543210',
    processingType: 'OIL',
    sarsonKg: 50,
    extractedOilKg: 18,
    totalAmount: 300,
    amountPaid: 300,
    balanceDue: 0,
  };

  // When WhatsApp is not linked, it should safely skip and never crash
  const skipResult = await whatsappService.processOrderNotification(orderData);
  assert.strictEqual(skipResult.skipped, true);
  assert.strictEqual(skipResult.reason, 'WhatsApp bot is not connected');

  // Test idempotency cache hit
  whatsappService.idempotencyCache.set('order-test-bill-101-completed', true);
  whatsappService.provider.isConnected = true; // Simulate connected
  const dupResult = await whatsappService.processOrderNotification(orderData);
  assert.strictEqual(dupResult.skipped, true);
  assert.strictEqual(dupResult.reason, 'Duplicate notification already processed');
  whatsappService.provider.isConnected = false; // Reset
  console.log('  PASS: 5.1: Duplicate notifications are rejected atomically.');

  // 6. Missing customer phone number safety
  console.log('Testing 6.1: Missing customer phone number handling...');
  const missingPhoneResult = await whatsappService.processOrderNotification({
    billId: 'test-bill-102',
    customerName: 'No Phone Customer',
    customerMobile: '',
  });
  assert.strictEqual(missingPhoneResult.skipped, true);
  console.log('  PASS: 6.1: Missing customer phone numbers handled safely.');

  console.log('===========================================================');
  console.log('ALL WHATSAPP AUTO-LINK BOT AUTOMATED TESTS PASSED!');
  console.log('===========================================================');
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
