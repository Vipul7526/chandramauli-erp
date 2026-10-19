// ==================================================================================
// CHANDRAMAULI OIL & WHEAT ERP - NETLIFY SERVERLESS BACKEND
// Handles Customers (1 per mobile), Oil & Wheat Bills, Pickup Dates,
// Machine Electricity Cost (₹80/day + ₹7.77/kWh), Ledger, Reports, and Security OTP
// Developer: Prince Singh
// ==================================================================================

const { getSupabaseClient } = require('./supabaseClient');
const { sendOtpEmail } = require('./emailService');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, X-App-Package, X-App-Signature-SHA1, X-App-Signature-SHA256, X-App-Timestamp',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(data),
  };
}

function getHeader(headers, name) {
  if (!headers) return '';
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      return (headers[key] || '').toString();
    }
  }
  return '';
}

async function recalculateCustomerBalance(supabase, customerId) {
  try {
    const { data: cust } = await supabase
      .from('customers')
      .select('initial_balance')
      .eq('id', customerId)
      .single();

    const { data: txs } = await supabase
      .from('customer_ledger')
      .select('entry_type, amount')
      .eq('customer_id', customerId);

    const initBal = parseFloat(cust?.initial_balance || 0);
    let totDebit = 0;
    let totCredit = 0;

    (txs || []).forEach(t => {
      const a = parseFloat(t.amount || 0);
      if (t.entry_type === 'DEBIT') totDebit += a;
      if (t.entry_type === 'CREDIT') totCredit += a;
    });

    const netBal = Math.round((initBal + totDebit - totCredit) * 100) / 100;
    const currentDue = netBal >= 0 ? netBal : 0;
    const currentAdvance = netBal < 0 ? Math.abs(netBal) : 0;

    await supabase
      .from('customers')
      .update({
        current_due: currentDue,
        current_advance: currentAdvance,
        updated_at: new Date().toISOString(),
      })
      .eq('id', customerId);

    return { currentDue, currentAdvance };
  } catch (err) {
    console.error('[recalculateCustomerBalance error]', err);
    return null;
  }
}

async function allocatePaymentToUnpaidBills(supabase, customerId, paymentAmount) {
  try {
    let remainingPayment = parseFloat(paymentAmount || 0);
    if (remainingPayment <= 0) return;

    const { data: unpaidBills } = await supabase
      .from('milling_bills')
      .select('id, total_amount, amount_paid, balance_due')
      .eq('customer_id', customerId)
      .gt('balance_due', 0)
      .order('order_datetime', { ascending: true });

    if (!unpaidBills || unpaidBills.length === 0) return;

    for (const b of unpaidBills) {
      if (remainingPayment <= 0) break;
      const due = parseFloat(b.balance_due || 0);
      const payTowardsThis = Math.min(remainingPayment, due);
      const newPaid = Math.round((parseFloat(b.amount_paid || 0) + payTowardsThis) * 100) / 100;
      const newDue = Math.max(0, Math.round((due - payTowardsThis) * 100) / 100);

      await supabase
        .from('milling_bills')
        .update({
          amount_paid: newPaid,
          balance_due: newDue,
          updated_at: new Date().toISOString(),
        })
        .eq('id', b.id);

      remainingPayment -= payTowardsThis;
    }
  } catch (err) {
    console.error('[allocatePaymentToUnpaidBills error]', err);
  }
}

function normalizeHash(hash) {
  return (hash || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
}

exports.handler = async (event, context) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: '',
    };
  }

  const path = event.path.replace(/\/\.netlify\/functions\/api/, '').replace(/^\/api/, '') || '/';
  const method = event.httpMethod;
  const query = event.queryStringParameters || {};
  let body = {};

  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      return jsonResponse(400, { error: 'Invalid JSON payload' });
    }
  }

  const supabase = getSupabaseClient();

  // Root health check & diagnostics
  if (path === '/' || path === '/health') {
    return jsonResponse(200, {
      status: 'ok',
      service: 'Chandramauli Mustard Oil & Wheat ERP Backend',
      developer: 'Prince Singh',
      timestamp: new Date().toISOString(),
      databaseConnected: !!supabase,
      shaVerificationEnabled: !!(process.env.APP_SHA1 || process.env.APP_SHA256),
    });
  }

  // ---------------------------------------------------------------------------
  // TRUSTED APP SECURITY VERIFICATION (SHA-1 and SHA-256)
  // ---------------------------------------------------------------------------
  const expectedSha1 = normalizeHash(process.env.APP_SHA1 || process.env.TRUSTED_APP_SHA1);
  const expectedSha256 = normalizeHash(process.env.APP_SHA256 || process.env.TRUSTED_APP_SHA256);
  const expectedPkg = (process.env.ALLOWED_PACKAGE_NAME || 'com.chandramauli.erp').trim();

  if (expectedSha1 || expectedSha256) {
    const incomingSha1 = normalizeHash(getHeader(event.headers, 'x-app-signature-sha1'));
    const incomingSha256 = normalizeHash(getHeader(event.headers, 'x-app-signature-sha256'));
    const incomingPkg = getHeader(event.headers, 'x-app-package').trim();

    if (expectedPkg && incomingPkg && incomingPkg !== expectedPkg) {
      return jsonResponse(403, {
        error: 'Forbidden: Untrusted Application Package',
        message: `Package mismatch. Expected '${expectedPkg}', received '${incomingPkg}'.`,
      });
    }

    if (expectedSha1 && incomingSha1 !== expectedSha1) {
      return jsonResponse(403, {
        error: 'Forbidden: Untrusted Application Signature (SHA-1 Mismatch)',
        message: 'Access blocked: Android app SHA-1 fingerprint verification failed. Only official Chandramauli ERP APK can perform this operation.',
      });
    }

    if (expectedSha256 && incomingSha256 !== expectedSha256) {
      return jsonResponse(403, {
        error: 'Forbidden: Untrusted Application Signature (SHA-256 Mismatch)',
        message: 'Access blocked: Android app SHA-256 fingerprint verification failed. Only official Chandramauli ERP APK can perform this operation.',
      });
    }
  }

  if (!supabase) {
    return jsonResponse(500, {
      error: 'Supabase configuration missing on server',
      message: 'Please configure SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY) in Netlify Environment Variables.',
    });
  }

  try {
    // -------------------------------------------------------------------------
    // 1. BRAND PROFILE & DEVELOPER INFO
    // -------------------------------------------------------------------------
    if (path === '/brand' && method === 'GET') {
      const { data, error } = await supabase.from('brand_profile').select('*').limit(1).single();
      if (error && error.code !== 'PGRST116') throw error;
      return jsonResponse(200, {
        brand: data || {
          brand_name: 'Chandramauli Mustard Oil Mill',
          tagline: 'Kachi Ghani Mustard Oil & Pure Seed Extraction',
          phone: '8429774452',
          email: 'support.chandramauli@gmail.com',
          address: 'Raghunathpur Bahaur,Mirzapur 231302',
          currency_symbol: '₹',
        },
        developer: {
          name: 'Prince Singh',
          role: 'Lead Architect & Systems Engineer',
          app: 'Chandramauli Oil & Wheat Milling ERP',
          version: '2.0.0',
          phrase: 'Engineered with passion and precision for seamless mill operations.',
        },
      });
    }

    // -------------------------------------------------------------------------
    // 2. UNIFIED CUSTOMERS (Strictly 1 Customer per Mobile, Soft Delete 30 Days & Instant Permanent Delete)
    // -------------------------------------------------------------------------
    if (path === '/customers' || path === '/customers/update' || path === '/customers/restore') {
      // Restore Customer from Recycle Bin
      if ((path === '/customers/restore' && method === 'POST') || (path === '/customers' && method === 'POST' && body.action === 'RESTORE')) {
        const targetId = body.id || query.id;
        if (!targetId) return jsonResponse(400, { error: 'Customer id is required to restore' });

        const { data: restored, error: restErr } = await supabase
          .from('customers')
          .update({
            is_deleted: false,
            deleted_at: null,
            scheduled_deletion_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', targetId)
          .select()
          .single();

        if (restErr) throw restErr;

        return jsonResponse(200, {
          message: 'Customer restored to active directory successfully',
          customer: restored,
        });
      }

      if (method === 'GET') {
        const searchQuery = (query.search || '').trim();
        const isTrash = query.trash === 'true';

        // Auto-purge any customer scheduled for deletion whose 30-day window has expired
        try {
          await supabase
            .from('customers')
            .delete()
            .eq('is_deleted', true)
            .lte('scheduled_deletion_at', new Date().toISOString());
        } catch (_) {}

        let req = supabase
          .from('customers')
          .select('id, serial_number, serial_code, name, mobile, village_or_city, address, initial_balance, current_due, current_advance, status, notes, created_at, is_deleted, deleted_at, scheduled_deletion_at')
          .order('serial_number', { ascending: false });

        if (isTrash) {
          req = req.eq('is_deleted', true);
        } else {
          req = req.or('is_deleted.is.null,is_deleted.eq.false');
        }

        if (searchQuery) {
          req = req.or(`name.ilike.%${searchQuery}%,mobile.ilike.%${searchQuery}%,serial_code.ilike.%${searchQuery}%`);
        }

        const { data: customers, error } = await req;
        if (error) throw error;

        // Fetch trash count for tab badge
        let trashCount = 0;
        try {
          const { count } = await supabase
            .from('customers')
            .select('id', { count: 'exact', head: true })
            .eq('is_deleted', true);
          trashCount = count || 0;
        } catch (_) {}

        return jsonResponse(200, {
          customers,
          total: customers.length,
          trashCount,
        });
      }

      if (method === 'POST' && path === '/customers' && !body.action) {
        const { name, mobile, village_or_city, address, initial_due, initial_advance, notes } = body;
        if (!name || !name.trim()) {
          return jsonResponse(400, { error: 'Customer name is required' });
        }
        if (!mobile || !mobile.trim()) {
          return jsonResponse(400, { error: 'Customer mobile number is required' });
        }

        const cleanMobile = mobile.trim();

        // Enforce 1 customer per 1 mobile number!
        const { data: existingCust } = await supabase
          .from('customers')
          .select('id, name, serial_code, mobile, is_deleted')
          .eq('mobile', cleanMobile)
          .maybeSingle();

        if (existingCust && !existingCust.is_deleted) {
          return jsonResponse(400, {
            error: 'Mobile number already registered',
            message: `Customer with mobile ${cleanMobile} is already registered as "${existingCust.name}" (${existingCust.serial_code}). Strictly 1 customer is allowed per mobile number.`,
            existingCustomer: existingCust,
          });
        }

        const initDue = parseFloat(initial_due || 0) || 0;
        const initAdv = parseFloat(initial_advance || 0) || 0;
        const initBal = initDue - initAdv;

        const { data: newCustomer, error } = await supabase
          .from('customers')
          .insert({
            name: name.trim(),
            mobile: cleanMobile,
            village_or_city: village_or_city ? village_or_city.trim() : null,
            address: address ? address.trim() : null,
            initial_balance: initBal,
            current_due: initDue > 0 ? initDue : 0,
            current_advance: initAdv > 0 ? initAdv : 0,
            notes: notes || null,
            is_deleted: false,
          })
          .select()
          .single();

        if (error) throw error;

        return jsonResponse(201, {
          message: 'Customer registered successfully',
          customer: newCustomer,
          serial_code: newCustomer.serial_code,
          serial_number: newCustomer.serial_number,
        });
      }

      // Rename & Update Customer
      if (method === 'PUT' || method === 'PATCH' || (method === 'POST' && path === '/customers/update')) {
        const { id, name, mobile, village_or_city, address, notes } = body;
        const targetId = id || query.id;
        if (!targetId) {
          return jsonResponse(400, { error: 'Customer id is required for update' });
        }

        const updateData = { updated_at: new Date().toISOString() };
        if (name && name.trim()) updateData.name = name.trim();
        if (village_or_city !== undefined) updateData.village_or_city = village_or_city ? village_or_city.trim() : null;
        if (address !== undefined) updateData.address = address ? address.trim() : null;
        if (notes !== undefined) updateData.notes = notes ? notes.trim() : null;

        if (mobile && mobile.trim()) {
          const cleanMobile = mobile.trim();
          const { data: duplicate } = await supabase
            .from('customers')
            .select('id, name, serial_code')
            .eq('mobile', cleanMobile)
            .neq('id', targetId)
            .or('is_deleted.is.null,is_deleted.eq.false')
            .maybeSingle();

          if (duplicate) {
            return jsonResponse(400, {
              error: 'Mobile number already in use',
              message: `Mobile number ${cleanMobile} is already in use by ${duplicate.name} (${duplicate.serial_code}).`,
            });
          }
          updateData.mobile = cleanMobile;
        }

        const { data: updatedCustomer, error: updateErr } = await supabase
          .from('customers')
          .update(updateData)
          .eq('id', targetId)
          .select()
          .single();

        if (updateErr) throw updateErr;

        // Synchronize customer name & mobile in past milling_bills
        if (updateData.name || updateData.mobile) {
          const billSync = {};
          if (updateData.name) billSync.customer_name = updateData.name;
          if (updateData.mobile) billSync.customer_mobile = updateData.mobile;
          await supabase.from('milling_bills').update(billSync).eq('customer_id', targetId);
        }

        return jsonResponse(200, {
          message: 'Customer data updated and renamed successfully',
          customer: updatedCustomer,
        });
      }

      // Delete Customer: Soft Delete (30 Days Auto-Delete) OR Instant Permanent Delete Now
      if (method === 'DELETE' || (method === 'POST' && body.action === 'DELETE')) {
        const targetId = query.id || body.id;
        const isPermanent = query.permanent === 'true' || body.permanent === true;

        if (!targetId) {
          return jsonResponse(400, { error: 'Customer id is required for deletion' });
        }

        if (isPermanent) {
          // Permanently and instantly delete from Supabase
          await supabase.from('customer_ledger').delete().eq('customer_id', targetId);
          await supabase.from('milling_bills').delete().eq('customer_id', targetId);
          const { error: delErr } = await supabase.from('customers').delete().eq('id', targetId);
          if (delErr) throw delErr;

          return jsonResponse(200, {
            message: 'Customer permanently deleted immediately from database.',
            permanent: true,
          });
        } else {
          // Soft delete into 30-Day Recycle Bin
          const now = new Date();
          const scheduledDeletion = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

          const { data: softDeleted, error: softErr } = await supabase
            .from('customers')
            .update({
              is_deleted: true,
              deleted_at: now.toISOString(),
              scheduled_deletion_at: scheduledDeletion,
              updated_at: now.toISOString(),
            })
            .eq('id', targetId)
            .select()
            .single();

          if (softErr) throw softErr;

          return jsonResponse(200, {
            message: 'Customer moved to Recycle Bin. Auto-deletes permanently in 30 days unless restored or deleted now.',
            permanent: false,
            customer: softDeleted,
            scheduledDeletionAt: scheduledDeletion,
          });
        }
      }
    }

    // -------------------------------------------------------------------------
    // 3. SERVICE MASTER (Oil Pelai & Wheat Pisai Rates)
    // -------------------------------------------------------------------------
    if (path === '/services') {
      if (method === 'GET') {
        const { data: services, error } = await supabase
          .from('service_master')
          .select('*')
          .order('service_category', { ascending: true })
          .order('service_name', { ascending: true });
        if (error) throw error;

        return jsonResponse(200, { services });
      }

      if (method === 'POST') {
        const { service_name, service_category = 'OIL', oil_type, rate_per_kg, expected_oil_percent, expected_cake_percent, notes } = body;
        if (!service_name || !rate_per_kg) {
          return jsonResponse(400, { error: 'service_name and rate_per_kg are required' });
        }

        const { data: service, error } = await supabase
          .from('service_master')
          .upsert({
            service_name: service_name.trim(),
            service_category: service_category,
            oil_type: oil_type || (service_category === 'WHEAT' ? 'Wheat Flour' : 'Mustard oil'),
            rate_per_kg: parseFloat(rate_per_kg),
            expected_oil_percent: expected_oil_percent ? parseFloat(expected_oil_percent) : 34.0,
            expected_cake_percent: expected_cake_percent ? parseFloat(expected_cake_percent) : 63.0,
            notes: notes || null,
          })
          .select()
          .single();

        if (error) throw error;

        return jsonResponse(201, { message: 'Service saved successfully', service });
      }
    }

    // -------------------------------------------------------------------------
    // 4. MILLING & WHEAT ORDERS / BILLS
    // -------------------------------------------------------------------------
    if (path === '/bills') {
      if (method === 'GET') {
        const { customer_id, start_date, end_date, date, month, year, processing_type, pickup_status } = query;

        let req = supabase
          .from('milling_bills')
          .select('*')
          .order('order_datetime', { ascending: false });

        if (customer_id) {
          req = req.eq('customer_id', customer_id);
        }
        if (processing_type) {
          req = req.eq('processing_type', processing_type.toUpperCase());
        }
        if (pickup_status) {
          req = req.eq('pickup_status', pickup_status.toUpperCase());
        }

        if (date) {
          req = req.gte('order_datetime', `${date}T00:00:00Z`).lte('order_datetime', `${date}T23:59:59Z`);
        } else if (month && year) {
          const m = String(month).padStart(2, '0');
          const nextM = parseInt(m, 10) === 12 ? 1 : parseInt(m, 10) + 1;
          const nextY = parseInt(m, 10) === 12 ? parseInt(year, 10) + 1 : parseInt(year, 10);
          req = req.gte('order_datetime', `${year}-${m}-01T00:00:00Z`).lt('order_datetime', `${nextY}-${String(nextM).padStart(2, '0')}-01T00:00:00Z`);
        } else if (year && !month) {
          req = req.gte('order_datetime', `${year}-01-01T00:00:00Z`).lt('order_datetime', `${parseInt(year, 10) + 1}-01-01T00:00:00Z`);
        } else if (start_date && end_date) {
          req = req.gte('order_datetime', `${start_date}T00:00:00Z`).lte('order_datetime', `${end_date}T23:59:59Z`);
        }

        const { data: bills, error } = await req;
        if (error) throw error;

        // Calculate summary
        const summary = bills.reduce(
          (acc, b) => {
            if (b.processing_type === 'WHEAT') {
              acc.totalWheatKg += parseFloat(b.wheat_kg || 0);
              acc.totalFlourAttaKg += parseFloat(b.flour_atta_kg || 0);
            } else {
              acc.totalSarsonKg += parseFloat(b.sarson_kg || 0);
              acc.totalExtractedOilKg += parseFloat(b.extracted_oil_kg || 0);
            }
            acc.totalMillingCharge += parseFloat(b.total_amount || 0);
            acc.totalPaid += parseFloat(b.amount_paid || 0);
            acc.totalDue += parseFloat(b.balance_due || 0);
            return acc;
          },
          { totalSarsonKg: 0, totalExtractedOilKg: 0, totalWheatKg: 0, totalFlourAttaKg: 0, totalMillingCharge: 0, totalPaid: 0, totalDue: 0 }
        );

        return jsonResponse(200, { bills, summary, count: bills.length });
      }

      if (method === 'POST') {
        const {
          customer_id,
          processing_type = 'OIL',
          service_id,
          oil_type = 'Mustard oil',
          sarson_kg = 0,
          extracted_oil_kg = 0,
          oil_cake_kg = 0,
          wheat_kg = 0,
          flour_atta_kg = 0,
          bran_chokar_kg = 0,
          rate_per_kg,
          tin_or_can_charge = 0,
          bag_charge = 0,
          other_charges = 0,
          discount = 0,
          amount_paid = 0,
          payment_mode = 'CASH',
          order_datetime,
          pickup_datetime,
          pickup_status = 'PENDING',
          notes,
        } = body;

        if (!customer_id || rate_per_kg === undefined) {
          return jsonResponse(400, { error: 'Missing required bill fields: customer_id and rate_per_kg are required.' });
        }

        const isWheat = processing_type.toUpperCase() === 'WHEAT';
        const weight = isWheat ? parseFloat(wheat_kg || 0) : parseFloat(sarson_kg || 0);

        if (weight <= 0) {
          return jsonResponse(400, { error: isWheat ? 'Wheat (Gehu) kg must be greater than 0' : 'Sarson kg must be greater than 0' });
        }

        const ratePerKgNum = parseFloat(rate_per_kg);
        const subtotal = Math.round(weight * ratePerKgNum * 100) / 100;
        const totalAmount = Math.max(0, subtotal + parseFloat(tin_or_can_charge || 0) + parseFloat(bag_charge || 0) + parseFloat(other_charges || 0) - parseFloat(discount || 0));
        const paidNum = parseFloat(amount_paid || 0);
        const balanceDue = totalAmount - paidNum;

        // Bill Number: CM-YYYYMMDD-XXXX
        const now = new Date();
        const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
        const randomNum = Math.floor(1000 + Math.random() * 9000);
        const billNumber = `${isWheat ? 'WHT' : 'CM'}-${ymd}-${randomNum}`;

        const { data: cust, error: custErr } = await supabase
          .from('customers')
          .select('id, name, mobile, serial_code')
          .eq('id', customer_id)
          .single();

        if (custErr || !cust) {
          return jsonResponse(404, { error: 'Customer not found with provided ID' });
        }

        const billData = {
          bill_number: billNumber,
          processing_type: isWheat ? 'WHEAT' : 'OIL',
          order_datetime: order_datetime ? new Date(order_datetime).toISOString() : new Date().toISOString(),
          pickup_datetime: pickup_datetime ? new Date(pickup_datetime).toISOString() : null,
          pickup_status: pickup_status.toUpperCase(),
          bill_date: order_datetime ? new Date(order_datetime).toISOString() : new Date().toISOString(),
          customer_id: cust.id,
          customer_name: cust.name,
          customer_mobile: cust.mobile,
          customer_serial_code: cust.serial_code,
          service_id: service_id || null,
          oil_type: isWheat ? 'Wheat Flour' : oil_type,
          sarson_kg: isWheat ? 0 : parseFloat(sarson_kg || 0),
          extracted_oil_kg: isWheat ? 0 : parseFloat(extracted_oil_kg || 0),
          oil_cake_kg: isWheat ? 0 : parseFloat(oil_cake_kg || 0),
          wheat_kg: isWheat ? parseFloat(wheat_kg || 0) : 0,
          flour_atta_kg: isWheat ? parseFloat(flour_atta_kg || 0) : 0,
          bran_chokar_kg: isWheat ? parseFloat(bran_chokar_kg || 0) : 0,
          rate_per_kg: ratePerKgNum,
          tin_or_can_charge: parseFloat(tin_or_can_charge || 0),
          bag_charge: parseFloat(bag_charge || 0),
          other_charges: parseFloat(other_charges || 0),
          discount: parseFloat(discount || 0),
          total_amount: totalAmount,
          amount_paid: paidNum,
          balance_due: balanceDue,
          payment_mode: payment_mode,
          notes: notes || null,
        };

        const { data: newBill, error: billErr } = await supabase
          .from('milling_bills')
          .insert(billData)
          .select()
          .single();

        if (billErr) throw billErr;

        // Failsafe: Ensure customer ledger reflects the new bill and payment
        try {
          const { data: existingLedger } = await supabase
            .from('customer_ledger')
            .select('id')
            .eq('bill_id', newBill.id)
            .limit(1);

          if (!existingLedger || existingLedger.length === 0) {
            const desc = isWheat
              ? `Wheat Pisai #${newBill.bill_number} - ${newBill.wheat_kg}kg Gehu`
              : `Milling Slip #${newBill.bill_number} - ${newBill.sarson_kg}kg ${newBill.oil_type}`;

            await supabase.from('customer_ledger').insert({
              customer_id: cust.id,
              bill_id: newBill.id,
              entry_type: 'DEBIT',
              amount: totalAmount,
              payment_mode: payment_mode,
              description: desc,
              transaction_date: billData.order_datetime,
            });

            if (paidNum > 0) {
              await supabase.from('customer_ledger').insert({
                customer_id: cust.id,
                bill_id: newBill.id,
                entry_type: 'CREDIT',
                amount: paidNum,
                payment_mode: payment_mode,
                description: `Payment received for Order #${newBill.bill_number}`,
                transaction_date: billData.order_datetime,
              });
            }
          }

          await recalculateCustomerBalance(supabase, cust.id);
        } catch (lErr) {
          console.error('[bill ledger sync error]', lErr);
        }

        return jsonResponse(201, {
          message: 'Order created and posted to ledger successfully',
          bill: newBill,
        });
      }
    }

    // Record Payment Directly Against an Existing Bill
    if (path === '/bills/payment' && method === 'POST') {
      const { bill_id, payment_amount, payment_mode = 'CASH', notes } = body;
      if (!bill_id || !payment_amount) {
        return jsonResponse(400, { error: 'bill_id and payment_amount are required' });
      }

      const payAmt = parseFloat(payment_amount);
      if (payAmt <= 0) {
        return jsonResponse(400, { error: 'Payment amount must be greater than zero' });
      }

      const { data: bill, error: billErr } = await supabase
        .from('milling_bills')
        .select('*')
        .eq('id', bill_id)
        .single();

      if (billErr || !bill) {
        return jsonResponse(404, { error: 'Bill not found' });
      }

      const currentPaid = parseFloat(bill.amount_paid || 0);
      const totalAmt = parseFloat(bill.total_amount || 0);
      const newPaid = Math.round((currentPaid + payAmt) * 100) / 100;
      const newDue = Math.max(0, Math.round((totalAmt - newPaid) * 100) / 100);

      const { data: updatedBill, error: upErr } = await supabase
        .from('milling_bills')
        .update({
          amount_paid: newPaid,
          balance_due: newDue,
          payment_mode: payment_mode,
          updated_at: new Date().toISOString(),
        })
        .eq('id', bill_id)
        .select()
        .single();

      if (upErr) throw upErr;

      // Add credit entry to customer ledger
      await supabase.from('customer_ledger').insert({
        customer_id: bill.customer_id,
        bill_id: bill.id,
        entry_type: 'CREDIT',
        amount: payAmt,
        payment_mode: payment_mode,
        description: notes || `Payment of ₹${payAmt} received for Bill #${bill.bill_number}`,
        transaction_date: new Date().toISOString(),
      });

      // Recalculate customer due/advance directly
      const balance = await recalculateCustomerBalance(supabase, bill.customer_id);

      return jsonResponse(200, {
        message: 'Bill payment recorded successfully',
        bill: updatedBill,
        customerBalance: balance,
      });
    }

    // Update Pickup Date & Status
    if (path === '/bills/pickup' && method === 'POST') {
      const { bill_id, pickup_status, pickup_datetime } = body;
      if (!bill_id) return jsonResponse(400, { error: 'bill_id is required' });

      const updateData = {
        pickup_status: (pickup_status || 'PICKED_UP').toUpperCase(),
        pickup_datetime: pickup_datetime ? new Date(pickup_datetime).toISOString() : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { data: updatedBill, error } = await supabase
        .from('milling_bills')
        .update(updateData)
        .eq('id', bill_id)
        .select()
        .single();

      if (error) throw error;

      return jsonResponse(200, { message: 'Pickup status updated', bill: updatedBill });
    }

    // -------------------------------------------------------------------------
    // 5. MACHINE ELECTRICITY COST (Fixed ₹80/day + ₹7.77 per kWh unit)
    // -------------------------------------------------------------------------
    if (path === '/electricity') {
      if (method === 'GET') {
        const { data: readings, error } = await supabase
          .from('electricity_readings')
          .select('*')
          .order('reading_date', { ascending: false })
          .limit(30);

        if (error) throw error;

        const lastReading = readings && readings.length > 0 ? readings[0] : null;
        const totalUnits = (readings || []).reduce((sum, r) => sum + parseFloat(r.units_consumed || 0), 0);
        const totalCost = (readings || []).reduce((sum, r) => sum + parseFloat(r.total_cost || 0), 0);

        return jsonResponse(200, {
          readings: readings || [],
          lastReading: lastReading ? {
            reading_date: lastReading.reading_date,
            current_reading: lastReading.current_reading,
          } : null,
          fixedDailyRate: 80.00,
          unitRateKwh: 7.77,
          totalUnits,
          totalCost,
        });
      }

      if (method === 'POST') {
        const { previous_reading, current_reading, reading_date, start_date, days_elapsed, billing_interval, meter_number, notes } = body;

        if (previous_reading === undefined || current_reading === undefined) {
          return jsonResponse(400, { error: 'previous_reading and current_reading are required' });
        }

        const prev = parseFloat(previous_reading);
        const curr = parseFloat(current_reading);

        if (curr < prev) {
          return jsonResponse(400, { error: 'Current reading cannot be lower than previous reading' });
        }

        const days = Math.max(1, parseInt(days_elapsed || body.days || 1));
        const interval = (billing_interval || (days === 7 ? 'WEEKLY' : days >= 28 ? 'MONTHLY' : 'DAILY')).toUpperCase();

        const unitsConsumed = Math.round((curr - prev) * 100) / 100;
        const fixedDailyRate = 80.00;
        const unitRate = 7.77;
        const fixedTotalCost = Math.round(days * fixedDailyRate * 100) / 100; // Automatically added for every date
        const unitsCost = Math.round(unitsConsumed * unitRate * 100) / 100;
        const totalCost = Math.round((fixedTotalCost + unitsCost) * 100) / 100;

        const insertPayload = {
          reading_date: reading_date || new Date().toISOString().slice(0, 10),
          previous_reading: prev,
          current_reading: curr,
          meter_number: meter_number || 'MAIN-METER-1',
          notes: notes || null,
        };

        if (start_date) insertPayload.start_date = start_date;
        insertPayload.days_elapsed = days;
        insertPayload.billing_interval = interval;
        insertPayload.fixed_total_cost = fixedTotalCost;
        insertPayload.final_total_cost = totalCost;

        let newReading = null;
        const { data: resData, error } = await supabase
          .from('electricity_readings')
          .insert(insertPayload)
          .select()
          .single();

        if (error) {
          // Fallback if custom columns are not yet applied in Supabase
          const { data: fallbackData, error: fbErr } = await supabase
            .from('electricity_readings')
            .insert({
              reading_date: reading_date || new Date().toISOString().slice(0, 10),
              previous_reading: prev,
              current_reading: curr,
              meter_number: meter_number || 'MAIN-METER-1',
              notes: notes || `[${interval}: ${days} days @ ₹80/day = ₹${fixedTotalCost} fixed]`,
            })
            .select()
            .single();

          if (fbErr) throw fbErr;
          newReading = fallbackData;
        } else {
          newReading = resData;
        }

        return jsonResponse(201, {
          message: 'Electricity reading recorded and added to expenses successfully',
          reading: newReading,
          daysElapsed: days,
          billingInterval: interval,
          fixedTotalCost,
          unitsConsumed,
          totalCost,
          formula: `${days} days × ₹80.00 fixed (₹${fixedTotalCost}) + (${unitsConsumed} units × ₹7.77) = ₹${totalCost}`,
        });
      }
    }

    // -------------------------------------------------------------------------
    // 6. CUSTOMER LEDGER (Khatabook Debit/Credit)
    // -------------------------------------------------------------------------
    if (path === '/ledger') {
      const { customer_id } = query;
      if (!customer_id) {
        return jsonResponse(400, { error: 'customer_id query param is required' });
      }

      if (method === 'GET') {
        const { data: customer, error: custErr } = await supabase
          .from('customers')
          .select('*')
          .eq('id', customer_id)
          .single();

        if (custErr) throw custErr;

        const { data: transactions, error: txErr } = await supabase
          .from('customer_ledger')
          .select('*')
          .eq('customer_id', customer_id)
          .order('transaction_date', { ascending: false });

        if (txErr) throw txErr;

        return jsonResponse(200, {
          customer,
          current_due: customer.current_due,
          current_advance: customer.current_advance,
          transactions,
        });
      }

      if (method === 'POST') {
        const { customer_id: bodyCustId, amount, entry_type = 'CREDIT', payment_mode = 'CASH', description } = body;
        const targetCustId = customer_id || bodyCustId;

        if (!targetCustId || !amount) {
          return jsonResponse(400, { error: 'customer_id and amount are required' });
        }

        const amtNum = parseFloat(amount);
        if (amtNum <= 0) {
          return jsonResponse(400, { error: 'Amount must be greater than zero' });
        }

        const { data: newEntry, error: insertErr } = await supabase
          .from('customer_ledger')
          .insert({
            customer_id: targetCustId,
            entry_type: entry_type,
            amount: amtNum,
            payment_mode: payment_mode,
            description: description || (entry_type === 'CREDIT' ? 'Payment received' : 'Adjustment debit'),
            transaction_date: new Date().toISOString(),
          })
          .select()
          .single();

        if (insertErr) throw insertErr;

        // Automatically allocate received payment to pending unpaid bills for this customer
        if (entry_type === 'CREDIT') {
          await allocatePaymentToUnpaidBills(supabase, targetCustId, amtNum);
        }

        // Explicitly recalculate customer balance directly in Supabase
        const balance = await recalculateCustomerBalance(supabase, targetCustId);

        const { data: updatedCust } = await supabase
          .from('customers')
          .select('*')
          .eq('id', targetCustId)
          .single();

        return jsonResponse(201, {
          message: 'Ledger entry recorded',
          entry: newEntry,
          updatedCustomer: updatedCust,
          currentDue: balance ? balance.currentDue : (updatedCust?.current_due || 0),
          currentAdvance: balance ? balance.currentAdvance : (updatedCust?.current_advance || 0),
        });
      }
    }

    // -------------------------------------------------------------------------
    // 7. EXPENSES
    // -------------------------------------------------------------------------
    if (path === '/expenses') {
      if (method === 'GET') {
        const { date, month, year, category } = query;

        let req = supabase.from('expenses').select('*').order('expense_date', { ascending: false });

        if (category) req = req.eq('category', category);

        if (date) {
          req = req.eq('expense_date', date);
        } else if (month && year) {
          const m = String(month).padStart(2, '0');
          const nextM = parseInt(m, 10) === 12 ? 1 : parseInt(m, 10) + 1;
          const nextY = parseInt(m, 10) === 12 ? parseInt(year, 10) + 1 : parseInt(year, 10);
          req = req.gte('expense_date', `${year}-${m}-01`).lt('expense_date', `${nextY}-${String(nextM).padStart(2, '0')}-01`);
        } else if (year && !month) {
          req = req.gte('expense_date', `${year}-01-01`).lt('expense_date', `${parseInt(year, 10) + 1}-01-01`);
        }

        const { data: expenses, error } = await req;
        if (error) throw error;

        const totalExpenseAmount = expenses.reduce((sum, e) => sum + parseFloat(e.amount || 0), 0);

        return jsonResponse(200, { expenses, totalExpenseAmount, count: expenses.length });
      }

      if (method === 'POST') {
        const { title, category, amount, payment_mode = 'CASH', paid_to, voucher_no, expense_date, notes } = body;
        if (!title || !category || !amount) {
          return jsonResponse(400, { error: 'title, category, and amount are required' });
        }

        const expNum = `EXP-${Date.now().toString().slice(-6)}`;

        const { data: newExpense, error } = await supabase
          .from('expenses')
          .insert({
            expense_number: expNum,
            title: title.trim(),
            category: category.trim(),
            amount: parseFloat(amount),
            payment_mode: payment_mode,
            paid_to: paid_to || null,
            voucher_no: voucher_no || null,
            expense_date: expense_date || new Date().toISOString().slice(0, 10),
            notes: notes || null,
          })
          .select()
          .single();

        if (error) throw error;

        return jsonResponse(201, { message: 'Expense added successfully', expense: newExpense });
      }
    }

    // -------------------------------------------------------------------------
    // 8. PROFIT & LOSS REPORT
    // -------------------------------------------------------------------------
    if (path === '/reports/profit-loss') {
      const { date, month, year } = query;

      let billsReq = supabase.from('milling_bills').select('processing_type, sarson_kg, extracted_oil_kg, wheat_kg, flour_atta_kg, total_amount, amount_paid, order_datetime');
      let expReq = supabase.from('expenses').select('amount, category, expense_date');

      if (date) {
        billsReq = billsReq.gte('order_datetime', `${date}T00:00:00Z`).lte('order_datetime', `${date}T23:59:59Z`);
        expReq = expReq.eq('expense_date', date);
      } else if (month && year) {
        const m = String(month).padStart(2, '0');
        const nextM = parseInt(m, 10) === 12 ? 1 : parseInt(m, 10) + 1;
        const nextY = parseInt(m, 10) === 12 ? parseInt(year, 10) + 1 : parseInt(year, 10);
        billsReq = billsReq.gte('order_datetime', `${year}-${m}-01T00:00:00Z`).lt('order_datetime', `${nextY}-${String(nextM).padStart(2, '0')}-01T00:00:00Z`);
        expReq = expReq.gte('expense_date', `${year}-${m}-01`).lt('expense_date', `${nextY}-${String(nextM).padStart(2, '0')}-01`);
      } else if (year && !month) {
        billsReq = billsReq.gte('order_datetime', `${year}-01-01T00:00:00Z`).lt('order_datetime', `${parseInt(year, 10) + 1}-01-01T00:00:00Z`);
        expReq = expReq.gte('expense_date', `${year}-01-01`).lt('expense_date', `${parseInt(year, 10) + 1}-01-01`);
      }

      const [billsRes, expRes] = await Promise.all([billsReq, expReq]);

      if (billsRes.error) throw billsRes.error;
      if (expRes.error) throw expRes.error;

      let totalSarson = 0;
      let totalOil = 0;
      let totalWheat = 0;
      let totalFlour = 0;
      let millingRevenue = 0;
      let cashReceived = 0;

      billsRes.data.forEach(b => {
        if (b.processing_type === 'WHEAT') {
          totalWheat += parseFloat(b.wheat_kg || 0);
          totalFlour += parseFloat(b.flour_atta_kg || 0);
        } else {
          totalSarson += parseFloat(b.sarson_kg || 0);
          totalOil += parseFloat(b.extracted_oil_kg || 0);
        }
        millingRevenue += parseFloat(b.total_amount || 0);
        cashReceived += parseFloat(b.amount_paid || 0);
      });

      const totalExpenses = expRes.data.reduce((s, e) => s + parseFloat(e.amount || 0), 0);

      const expensesByCategory = {};
      expRes.data.forEach(e => {
        expensesByCategory[e.category] = (expensesByCategory[e.category] || 0) + parseFloat(e.amount || 0);
      });

      const netProfitLoss = millingRevenue - totalExpenses;

      return jsonResponse(200, {
        period: { date: date || null, month: month || null, year: year || null },
        totalSarsonCrushedKg: totalSarson,
        totalExtractedOilKg: totalOil,
        totalWheatMilledKg: totalWheat,
        totalFlourProducedKg: totalFlour,
        millingRevenue,
        cashReceived,
        totalExpenses,
        netProfitLoss,
        isProfit: netProfitLoss >= 0,
        expensesByCategory,
        totalBillsCount: billsRes.data.length,
        totalExpensesCount: expRes.data.length,
      });
    }

    // -------------------------------------------------------------------------
    // 9. APP SECURITY & EMAIL OTP RECOVERY
    // -------------------------------------------------------------------------
    if (path === '/auth/status') {
      const { data: sec } = await supabase.from('app_security').select('admin_email, is_configured, pin_code, pin_required, device_lock_enrolled').limit(1).maybeSingle();
      const hasPin = !!(sec && sec.pin_code && sec.pin_code.trim().length >= 4);
      return jsonResponse(200, {
        configured: !!(sec && sec.is_configured),
        registeredEmail: sec ? sec.admin_email : null,
        hasPin,
        pinRequired: !!(sec && sec.pin_required),
        deviceLockEnrolled: !!(sec && sec.device_lock_enrolled),
      });
    }

    if (path === '/auth/setup' && method === 'POST') {
      const { admin_email, password, pin_code, pin_required, device_lock_enrolled } = body;
      if (!admin_email) {
        return jsonResponse(400, { error: 'admin_email is required' });
      }

      if (pin_code) {
        const cleanPin = pin_code.toString().trim();
        if (!/^\d{4,8}$/.test(cleanPin)) {
          return jsonResponse(400, { error: 'In-app PIN must be between 4 and 8 digits (numbers only)' });
        }
      }

      const upsertPayload = {
        id: '00000000-0000-0000-0000-000000000001',
        admin_email: admin_email.trim().toLowerCase(),
        password_hash: (password || pin_code || 'DEVICE_LOCK_MODE').trim(),
        pin_code: (pin_code && pin_code.toString().trim().length >= 4) ? pin_code.toString().trim() : null,
        pin_required: !!pin_required,
        device_lock_enrolled: !!device_lock_enrolled,
        is_configured: true,
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await supabase
        .from('app_security')
        .upsert(upsertPayload)
        .select()
        .single();

      if (error) {
        // Fallback without new columns if not yet migrated
        const { data: fbData, error: fbErr } = await supabase
          .from('app_security')
          .upsert({
            id: '00000000-0000-0000-0000-000000000001',
            admin_email: admin_email.trim().toLowerCase(),
            password_hash: (password || pin_code || 'DEVICE_LOCK_MODE').trim(),
            pin_code: (pin_code && pin_code.toString().trim().length >= 4) ? pin_code.toString().trim() : null,
            is_configured: true,
            updated_at: new Date().toISOString(),
          })
          .select()
          .single();

        if (fbErr) throw fbErr;
        return jsonResponse(200, {
          message: 'Security credentials saved successfully',
          email: fbData.admin_email,
          hasPin: !!(fbData.pin_code && fbData.pin_code.trim().length >= 4),
        });
      }

      return jsonResponse(200, {
        message: 'Security credentials saved successfully',
        email: data.admin_email,
        hasPin: !!(data.pin_code && data.pin_code.trim().length >= 4),
        pinRequired: data.pin_required,
        deviceLockEnrolled: data.device_lock_enrolled,
      });
    }

    if (path === '/auth/verify' && method === 'POST') {
      const input = (body.pin || body.password || '').toString().trim();
      if (!input) return jsonResponse(400, { error: 'PIN or password is required' });

      const { data: sec } = await supabase.from('app_security').select('*').limit(1).maybeSingle();
      if (!sec) {
        return jsonResponse(200, { verified: true, message: 'No security credentials set yet' });
      }

      if (!sec.pin_code && (sec.password_hash === 'DEVICE_LOCK_MODE' || sec.password_hash === 'DEVICE_LOCK_ONLY')) {
        return jsonResponse(400, { verified: false, error: 'No in-app PIN configured. Please unlock using your device screen lock or biometrics.' });
      }

      const isValid = (sec.pin_code && sec.pin_code.trim() === input) || (sec.password_hash && sec.password_hash.trim() === input && sec.password_hash !== 'DEVICE_LOCK_MODE');
      if (!isValid) {
        return jsonResponse(401, { verified: false, error: 'Incorrect PIN or password' });
      }

      return jsonResponse(200, { verified: true, message: 'Authentication successful' });
    }

    if (path === '/auth/send-otp' && method === 'POST') {
      const { email } = body;
      if (!email) return jsonResponse(400, { error: 'Email is required' });

      const cleanEmail = email.trim().toLowerCase();

      // Generate 6 digit OTP
      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

      // Save OTP in Supabase
      const { error: otpErr } = await supabase.from('app_otps').insert({
        email: cleanEmail,
        otp_code: otpCode,
        purpose: 'PASSWORD_RESET',
        expires_at: expiresAt,
        is_used: false,
      });

      if (otpErr) throw otpErr;

      // Send OTP via Nodemailer
      const mailResult = await sendOtpEmail(cleanEmail, otpCode, 'Chandramauli Mustard Oil Mill');

      return jsonResponse(200, {
        success: true,
        message: `OTP sent to ${cleanEmail}. Please check your inbox.`,
        simulated: mailResult.simulated || false,
        demoOtp: mailResult.simulated ? otpCode : undefined,
      });
    }

    if (path === '/auth/verify-otp' && method === 'POST') {
      const { email, otp } = body;
      if (!email || !otp) return jsonResponse(400, { error: 'Email and OTP are required' });

      const cleanEmail = email.trim().toLowerCase();
      const cleanOtp = otp.trim();

      const { data: otpRecord, error } = await supabase
        .from('app_otps')
        .select('*')
        .eq('email', cleanEmail)
        .eq('otp_code', cleanOtp)
        .eq('is_used', false)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error || !otpRecord) {
        return jsonResponse(400, { error: 'Invalid or expired OTP code' });
      }

      // Mark used
      await supabase.from('app_otps').update({ is_used: true }).eq('id', otpRecord.id);

      return jsonResponse(200, { success: true, message: 'OTP verified successfully' });
    }

    if (path === '/auth/reset-password' && method === 'POST') {
      const { email, new_password } = body;
      if (!email || !new_password) return jsonResponse(400, { error: 'Email and new_password are required' });

      const cleanEmail = email.trim().toLowerCase();

      const { error } = await supabase
        .from('app_security')
        .update({
          password_hash: new_password.trim(),
          updated_at: new Date().toISOString(),
        })
        .eq('admin_email', cleanEmail);

      if (error) throw error;

      return jsonResponse(200, { success: true, message: 'Password has been reset successfully. Please log in.' });
    }

    return jsonResponse(404, { error: `Endpoint not found: ${method} ${path}` });
  } catch (err) {
    console.error('API Error:', err);
    return jsonResponse(500, {
      error: 'Internal Server Error',
      details: err.message || err.toString(),
    });
  }
};
