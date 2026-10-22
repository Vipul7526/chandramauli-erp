// ==================================================================================
// CHANDRAMAULI ERP - WHATSAPP SERVICE & NOTIFICATION ENGINE
// Manages WhatsApp Provider, Supabase Persistence, WebSocket Broadcasting,
// and Idempotent Order-Completion Notifications.
// Developer: Prince Singh
// ==================================================================================

const path = require('path');
const BaileysProvider = require('./BaileysProvider');
const { getSupabaseClient } = require('../netlify/functions/supabaseClient');

class WhatsAppService {
  constructor() {
    this.provider = new BaileysProvider({
      sessionDir: path.join(__dirname, '../data/whatsapp_auth'),
    });

    this.wsClients = new Set();
    this.idempotencyCache = new Map(); // In-memory fallback cache

    // Listen for provider status changes and broadcast to all connected WebSocket clients
    this.provider.events.on('status', (statusData) => {
      this._broadcastWebSocket(statusData);
      this._syncSessionToSupabase(statusData).catch(() => {});
    });
  }

  async init() {
    console.log('[WhatsAppService] Initializing WhatsApp provider...');
    const ok = await this.provider.init();
    return ok;
  }

  // ---------------------------------------------------------------------------
  // WEBSOCKET MANAGEMENT
  // ---------------------------------------------------------------------------
  registerWebSocketClient(ws) {
    this.wsClients.add(ws);
    // Send immediate state snapshot
    try {
      ws.send(JSON.stringify({
        type: 'status',
        data: this.provider.getStatus(),
      }));
    } catch (_) {}

    ws.on('close', () => {
      this.wsClients.delete(ws);
    });

    ws.on('error', () => {
      this.wsClients.delete(ws);
    });

    ws.on('message', (message) => {
      try {
        const parsed = JSON.parse(message);
        if (parsed.action === 'getStatus') {
          ws.send(JSON.stringify({ type: 'status', data: this.provider.getStatus() }));
        } else if (parsed.action === 'refresh') {
          this.refreshLinking();
        }
      } catch (_) {}
    });
  }

  _broadcastWebSocket(data) {
    const payload = JSON.stringify({ type: 'status', data });
    for (const client of this.wsClients) {
      try {
        if (client.readyState === 1) { // WebSocket.OPEN
          client.send(payload);
        }
      } catch (_) {
        this.wsClients.delete(client);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // SUPABASE SESSION SYNC
  // ---------------------------------------------------------------------------
  async _syncSessionToSupabase(statusData) {
    const supabase = getSupabaseClient();
    if (!supabase) return;

    try {
      await supabase.from('whatsapp_sessions').upsert({
        session_id: 'default_session',
        phone_number: statusData.connectedPhone,
        status: statusData.status,
        is_connected: statusData.isConnected,
        connected_at: statusData.connectedAt,
        disconnect_reason: statusData.lastDisconnectReason || statusData.lastError,
        qr_code_raw: statusData.qrRaw,
        pairing_code: statusData.pairingCode,
        qr_expires_at: statusData.expiresAt ? new Date(statusData.expiresAt).toISOString() : null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'session_id' });
    } catch (e) {
      // Non-blocking sync
    }
  }

  // ---------------------------------------------------------------------------
  // LINKING WORKFLOW (QR & Pairing Code)
  // ---------------------------------------------------------------------------
  async startLinking(options = {}) {
    return await this.provider.startLinking(options);
  }

  async refreshLinking() {
    return await this.provider.refreshLinking();
  }

  async disconnect() {
    const result = await this.provider.disconnect();
    const supabase = getSupabaseClient();
    if (supabase) {
      try {
        await supabase.from('whatsapp_sessions').upsert({
          session_id: 'default_session',
          status: 'NOT_LINKED',
          is_connected: false,
          phone_number: null,
          disconnected_at: new Date().toISOString(),
          disconnect_reason: 'Explicit user disconnect from app',
          qr_code_raw: null,
          pairing_code: null,
          qr_expires_at: null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'session_id' });
      } catch (_) {}
    }
    return result;
  }

  getStatus() {
    return this.provider.getStatus();
  }

  // ---------------------------------------------------------------------------
  // TEST NOTIFICATION
  // ---------------------------------------------------------------------------
  async sendTestMessage(phoneNumber, customMessage) {
    if (!this.provider.isConnected) {
      throw new Error('WhatsApp is not connected. Please scan QR or link pairing code first.');
    }

    const cleanPhone = (phoneNumber || '').toString().replace(/[^0-9]/g, '');
    if (cleanPhone.length < 10) {
      throw new Error('Please enter a valid 10-digit mobile number for test notification.');
    }

    const text = customMessage || (
      `*CHANDRAMAULI MUSTARD OIL MILL & WHEAT CHAKKI*\n` +
      `-----------------------------------------\n` +
      `✅ *WhatsApp Connection Verified Successfully!*\n\n` +
      `ERP notification engine is active and ready to deliver real-time milling slips, payment receipts, and order readiness alerts.\n\n` +
      `• Timestamp: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n` +
      `• Lead Systems Engineer: Prince Singh\n` +
      `• Mill Location: Raghunathpur Bahaur, Mirzapur 231302\n` +
      `• Helpdesk: 8429774452\n` +
      `-----------------------------------------\n` +
      `_This is an automated test notification sent from Chandramauli ERP._`
    );

    const result = await this.provider.sendMessage(cleanPhone, text);

    // Record in Supabase notifications
    const supabase = getSupabaseClient();
    if (supabase) {
      try {
        await supabase.from('whatsapp_notifications').insert({
          idempotency_key: `test-${Date.now()}-${cleanPhone}`,
          recipient_phone: cleanPhone,
          message_type: 'TEST',
          message_body: text,
          status: 'SENT',
          provider_message_id: result.messageId,
          sent_at: new Date().toISOString(),
        });
      } catch (_) {}
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // AUTOMATIC ERP ORDER-COMPLETION NOTIFICATIONS (With Idempotency Defense)
  // ---------------------------------------------------------------------------
  async processOrderNotification({
    billId,
    billNumber,
    customerId,
    customerName,
    customerMobile,
    processingType = 'OIL',
    sarsonKg = 0,
    extractedOilKg = 0,
    oilCakeKg = 0,
    wheatKg = 0,
    flourAttaKg = 0,
    branChokarKg = 0,
    oilType = 'Mustard Oil',
    ratePerKg = 0,
    totalAmount = 0,
    amountPaid = 0,
    balanceDue = 0,
    pickupStatus = 'COMPLETED',
  }) {
    if (!this.provider.isConnected) {
      console.warn('[WhatsAppService] WhatsApp not linked. Skipping order notification.');
      return { skipped: true, reason: 'WhatsApp bot is not connected' };
    }

    const cleanPhone = (customerMobile || '').toString().replace(/[^0-9]/g, '');
    if (cleanPhone.length < 10) {
      console.warn(`[WhatsAppService] Missing or invalid mobile number for customer ${customerName}: '${customerMobile}'`);
      return { skipped: true, reason: 'Invalid or missing customer phone number' };
    }

    // 1. Idempotency Check (Prevent duplicate messages on double-tap or retries)
    const idempotencyKey = `order-${billId || billNumber}-completed`;

    if (this.idempotencyCache.has(idempotencyKey)) {
      console.log(`[WhatsAppService] Skipping duplicate notification for ${idempotencyKey}`);
      return { skipped: true, reason: 'Duplicate notification already processed' };
    }

    const supabase = getSupabaseClient();
    if (supabase) {
      try {
        const { data: existing } = await supabase
          .from('whatsapp_notifications')
          .select('id, status')
          .eq('idempotency_key', idempotencyKey)
          .maybeSingle();

        if (existing && existing.status === 'SENT') {
          console.log(`[WhatsAppService] Skipping duplicate notification in DB for ${idempotencyKey}`);
          this.idempotencyCache.set(idempotencyKey, true);
          return { skipped: true, reason: 'Order notification already sent to customer' };
        }
      } catch (_) {}
    }

    // Mark in memory cache immediately
    this.idempotencyCache.set(idempotencyKey, true);

    // 2. Compose professional Hindi/English milling slip receipt
    const isWheat = processingType === 'WHEAT';
    const cName = customerName || 'आदरणीय ग्राहक';
    const bNum = billNumber || 'CM-BILL';
    const nowStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

    let slipDetails = '';
    if (isWheat) {
      slipDetails = 
        `🌾 *कार्य:* गेहूं पिसाई (Wheat Atta Chakki)\n` +
        `⚖️ *गेहूं वजन:* ${Number(wheatKg || 0).toFixed(2)} kg\n` +
        `🥡 *आटा प्राप्त:* ${Number(flourAttaKg || 0).toFixed(2)} kg\n` +
        (branChokarKg > 0 ? `📦 *चोकर:* ${Number(branChokarKg).toFixed(2)} kg\n` : '');
    } else {
      slipDetails = 
        `🌻 *कार्य:* सरसों पेराई (${oilType || 'Mustard Oil'})\n` +
        `⚖️ *सरसों वजन:* ${Number(sarsonKg || 0).toFixed(2)} kg\n` +
        `🛢️ *शुद्ध तेल:* ${Number(extractedOilKg || 0).toFixed(2)} kg\n` +
        `🧱 *खली (Oil Cake):* ${Number(oilCakeKg || 0).toFixed(2)} kg\n`;
    }

    const messageText = 
      `🙏 *नमस्कार ${cName} जी!*\n` +
      `*चंद्रामाउली मस्टर्ड ऑयल मिल & आटा चक्की*\n` +
      `रघुनाथपुर बहउर, मिर्ज़ापुर - 231302\n` +
      `-----------------------------------------\n` +
      `✅ *आपका Order #${bNum} तैयार है!*\n` +
      `🕒 *दिनांक:* ${nowStr}\n\n` +
      `${slipDetails}` +
      `💵 *दर:* ₹${Number(ratePerKg || 0).toFixed(2)}/kg\n` +
      `💰 *कुल राशि (Total):* ₹${Number(totalAmount || 0).toFixed(2)}\n` +
      `🟢 *जमा राशि (Paid):* ₹${Number(amountPaid || 0).toFixed(2)}\n` +
      (balanceDue > 0 
        ? `⚠️ *बकाया (Due):* ₹${Number(balanceDue).toFixed(2)}\n` 
        : `✅ *बकाया शून्य (Full Paid)*\n`) +
      `📦 *स्थिति:* ${pickupStatus === 'PICKED_UP' ? 'सामान प्राप्त (Delivered)' : 'तैयार (Ready for Pickup)'}\n` +
      `-----------------------------------------\n` +
      `चंद्रामाउली मिल की सेवा चुनने के लिए धन्यवाद!\n` +
      `📞 संपर्क/हेल्पलाइन: 8429774452`;

    // 3. Dispatch via WhatsApp Provider
    try {
      const sendResult = await this.provider.sendMessage(cleanPhone, messageText);

      if (supabase) {
        try {
          await supabase.from('whatsapp_notifications').upsert({
            idempotency_key: idempotencyKey,
            customer_id: customerId || null,
            bill_id: billId || null,
            customer_name: cName,
            recipient_phone: cleanPhone,
            message_type: 'ORDER_COMPLETION',
            message_body: messageText,
            status: 'SENT',
            provider_message_id: sendResult.messageId,
            sent_at: new Date().toISOString(),
          }, { onConflict: 'idempotency_key' });
        } catch (_) {}
      }

      console.log(`[WhatsAppService] ✅ Order notification sent for ${bNum} to ${cleanPhone}`);
      return {
        success: true,
        messageId: sendResult.messageId,
        recipient: cleanPhone,
        idempotencyKey,
      };
    } catch (err) {
      console.error(`[WhatsAppService] ❌ Failed to send order notification for ${bNum}:`, err.message);

      if (supabase) {
        try {
          await supabase.from('whatsapp_notifications').upsert({
            idempotency_key: idempotencyKey,
            customer_id: customerId || null,
            bill_id: billId || null,
            customer_name: cName,
            recipient_phone: cleanPhone,
            message_type: 'ORDER_COMPLETION',
            message_body: messageText,
            status: 'FAILED',
            error_message: err.message,
            retry_count: 1,
          }, { onConflict: 'idempotency_key' });
        } catch (_) {}
      }

      return {
        success: false,
        error: err.message,
        idempotencyKey,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // NOTIFICATION HISTORY
  // ---------------------------------------------------------------------------
  async getNotifications(limit = 30) {
    const supabase = getSupabaseClient();
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('whatsapp_notifications')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(limit);

        if (!error && data) return data;
      } catch (_) {}
    }
    return [];
  }
}

// Singleton Instance
const whatsappService = new WhatsAppService();

module.exports = whatsappService;
