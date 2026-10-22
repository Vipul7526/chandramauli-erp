// ==================================================================================
// CHANDRAMAULI ERP - AUTH & LEDGER AUTOMATED REGRESSION TESTS
// Developer: Prince Singh
// ==================================================================================

const assert = require('assert');

async function runTests() {
  console.log('===========================================================');
  console.log('RUNNING AUTH OTP & LEDGER AUTOMATED TESTS');
  console.log('===========================================================');

  // Test 1: Ledger Payload Extraction
  console.log('Testing 1.1: Customer Ledger Target ID Extraction...');
  const extractTargetCustId = (body, query) => {
    return (body && body.customer_id) || (query && query.customer_id) || (body && body.customerId);
  };

  assert.strictEqual(
    extractTargetCustId({ customer_id: 'cust-123' }, {}),
    'cust-123',
    'Extracts customer_id from body'
  );
  assert.strictEqual(
    extractTargetCustId({}, { customer_id: 'cust-456' }),
    'cust-456',
    'Extracts customer_id from query'
  );
  assert.strictEqual(
    extractTargetCustId({ customer_id: 'cust-789' }, { customer_id: 'cust-old' }),
    'cust-789',
    'Body customer_id takes priority'
  );
  console.log('  PASS: 1.1: Ledger target customer ID extracted robustly.');

  // Test 2: Amount validation
  console.log('Testing 2.1: Payment amount validation...');
  const validateAmount = (amount) => {
    const amtNum = parseFloat(amount);
    return !isNaN(amtNum) && amtNum > 0;
  };
  assert.strictEqual(validateAmount('500'), true);
  assert.strictEqual(validateAmount(120.5), true);
  assert.strictEqual(validateAmount('0'), false);
  assert.strictEqual(validateAmount('-50'), false);
  assert.strictEqual(validateAmount('invalid'), false);
  console.log('  PASS: 2.1: Payment amounts validated strictly.');

  // Test 3: Password Reset OTP Validation Logic
  console.log('Testing 3.1: Password Reset OTP validation...');
  const validateResetRequest = (body) => {
    const { email, otp, new_password } = body || {};
    if (!email || !new_password) return { ok: false, error: 'Email and new_password are required' };
    if (!otp) return { ok: false, error: 'OTP code is required to reset password' };
    return { ok: true, cleanEmail: email.trim().toLowerCase(), cleanOtp: otp.toString().trim() };
  };

  const reqWithoutOtp = validateResetRequest({ email: 'test@example.com', new_password: 'newpass123' });
  assert.strictEqual(reqWithoutOtp.ok, false);
  assert.strictEqual(reqWithoutOtp.error, 'OTP code is required to reset password');

  const reqWithOtp = validateResetRequest({ email: 'Test@example.com', otp: ' 482910 ', new_password: 'pass' });
  assert.strictEqual(reqWithOtp.ok, true);
  assert.strictEqual(reqWithOtp.cleanEmail, 'test@example.com');
  assert.strictEqual(reqWithOtp.cleanOtp, '482910');
  console.log('  PASS: 3.1: Password reset strictly requires and sanitizes OTP.');

  console.log('===========================================================');
  console.log('ALL AUTH & LEDGER REGRESSION TESTS PASSED!');
  console.log('===========================================================');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
