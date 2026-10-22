// ==================================================================================
// CHANDRAMAULI ERP - BAILEYS WHATSAPP PROVIDER IMPLEMENTATION
// Persistent Multi-Device WhatsApp Web protocol with 5-minute QR expiry,
// Phone Number Pairing-Code support, and automatic reconnection.
// Developer: Prince Singh
// ==================================================================================

const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const pino = require('pino');
const EventEmitter = require('events');
const IWhatsAppProvider = require('./IWhatsAppProvider');

// Import Baileys modules safely
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

const QR_EXPIRY_MS = 300000; // 5 minutes = 300,000 milliseconds

class BaileysProvider extends IWhatsAppProvider {
  constructor(options = {}) {
    super('Baileys');
    this.sessionDir = options.sessionDir || path.join(__dirname, '../data/whatsapp_auth');
    this.events = new EventEmitter();

    this.sock = null;
    this.authState = null;
    this.saveCreds = null;

    // State
    this.status = 'NOT_LINKED'; // 'NOT_LINKED', 'INITIALIZING', 'QR_READY', 'PAIRING_READY', 'WAITING_FOR_SCAN', 'CONNECTED', 'RECONNECTING', 'SESSION_EXPIRED', 'QR_EXPIRED', 'FAILED'
    this.isConnected = false;
    this.connectedPhone = null;
    this.connectedAt = null;
    this.lastDisconnectReason = null;
    this.lastError = null;

    // Active linking attempt (5-minute expiry)
    this.currentQrRaw = null;
    this.currentQrDataUrl = null;
    this.currentPairingCode = null;
    this.qrExpiresAt = null;
    this.qrTimer = null;

    // Reconnection parameters
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.isReconnecting = false;
    this.isExplicitDisconnect = false;
  }

  // Helper to emit events to WhatsAppService
  _notifyState() {
    const statusData = this.getStatus();
    this.events.emit('status', statusData);
  }

  _cleanPhone(phone) {
    if (!phone) return '';
    let digits = phone.toString().replace(/[^0-9]/g, '');
    if (digits.length === 10) {
      digits = '91' + digits; // Default India Country Code (91)
    }
    return digits;
  }

  _clearExpiryTimer() {
    if (this.qrTimer) {
      clearTimeout(this.qrTimer);
      this.qrTimer = null;
    }
  }

  _startExpiryTimer() {
    this._clearExpiryTimer();
    this.qrExpiresAt = Date.now() + QR_EXPIRY_MS;

    this.qrTimer = setTimeout(() => {
      if (!this.isConnected && (this.status === 'QR_READY' || this.status === 'PAIRING_READY' || this.status === 'WAITING_FOR_SCAN')) {
        console.log('[WhatsApp Provider] QR / Linking attempt has expired after 5 minutes.');
        this.status = 'QR_EXPIRED';
        this.currentQrRaw = null;
        this.currentQrDataUrl = null;
        this.currentPairingCode = null;
        this.lastError = 'QR expired. Generate a new QR to link WhatsApp again.';
        this._notifyState();
      }
    }, QR_EXPIRY_MS);
  }

  async init() {
    try {
      if (!fs.existsSync(this.sessionDir)) {
        fs.mkdirSync(this.sessionDir, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
      this.authState = state;
      this.saveCreds = saveCreds;

      // Check if previously authenticated credentials exist
      if (state.creds && state.creds.registered) {
        console.log('[WhatsApp Provider] Found saved credentials. Restoring session...');
        await this._startSocket();
      } else {
        this.status = 'NOT_LINKED';
        this._notifyState();
      }
      return true;
    } catch (err) {
      console.error('[WhatsApp Provider] Initialization error:', err);
      this.status = 'FAILED';
      this.lastError = err.message;
      this._notifyState();
      return false;
    }
  }

  async _startSocket(options = {}) {
    try {
      this.isExplicitDisconnect = false;
      this.status = this.isConnected ? 'CONNECTED' : (this.authState?.creds?.registered ? 'RECONNECTING' : 'INITIALIZING');
      this._notifyState();

      const logger = pino({ level: 'silent' });
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

      this.sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false, // We render QR in Android App, not terminal!
        auth: {
          creds: this.authState.creds,
          keys: makeCacheableSignalKeyStore(this.authState.keys, logger),
        },
        generateHighQualityLinkPreview: false,
        browser: ['Chandramauli ERP', 'Chrome', '1.0.0'],
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        retryRequestDelayMs: 2000,
      });

      this.sock.ev.on('creds.update', this.saveCreds);

      // Pairing code requested by user
      if (options.usePairingCode && options.phoneNumber && !this.sock.authState.creds.registered) {
        const cleanPhone = this._cleanPhone(options.phoneNumber);
        if (cleanPhone.length >= 10) {
          setTimeout(async () => {
            try {
              const code = await this.sock.requestPairingCode(cleanPhone);
              // Format code as XXXX-XXXX for user-friendly reading
              this.currentPairingCode = code ? (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code) : null;
              this.status = 'PAIRING_READY';
              this._startExpiryTimer();
              this._notifyState();
              console.log(`[WhatsApp Provider] Pairing code generated: ${this.currentPairingCode} for ${cleanPhone}`);
            } catch (err) {
              console.error('[WhatsApp Provider] Pairing code error:', err.message);
              this.lastError = `Failed to generate pairing code: ${err.message}`;
              this.status = 'FAILED';
              this._notifyState();
            }
          }, 3000);
        }
      }

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // 1. QR Code Received from WhatsApp Server
        if (qr && !options.usePairingCode) {
          this.currentQrRaw = qr;
          try {
            this.currentQrDataUrl = await QRCode.toDataURL(qr, {
              margin: 2,
              scale: 6,
              color: { dark: '#000000', light: '#FFFFFF' },
            });
          } catch (e) {
            console.error('[QRCode Error]', e);
          }
          this.status = 'QR_READY';
          this._startExpiryTimer();
          this._notifyState();
          console.log('[WhatsApp Provider] New QR Code generated (expires in 5 minutes).');
        }

        // 2. Connection Open (Authenticated Successfully)
        if (connection === 'open') {
          this.isConnected = true;
          this.status = 'CONNECTED';
          this.reconnectAttempts = 0;
          this.isReconnecting = false;
          this.connectedAt = new Date().toISOString();
          this.lastDisconnectReason = null;
          this.lastError = null;

          this._clearExpiryTimer();
          this.currentQrRaw = null;
          this.currentQrDataUrl = null;
          this.currentPairingCode = null;

          if (this.sock.user && this.sock.user.id) {
            this.connectedPhone = this.sock.user.id.split(':')[0].replace(/[^0-9]/g, '');
          }

          console.log(`[WhatsApp Provider] ✅ WhatsApp connected successfully! Account: ${this.connectedPhone}`);
          this._notifyState();
        }

        // 3. Connection Closed
        if (connection === 'close') {
          this.isConnected = false;
          this._clearExpiryTimer();

          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const reason = lastDisconnect?.error?.message || 'Unknown network error';
          this.lastDisconnectReason = `Code ${statusCode}: ${reason}`;

          console.warn(`[WhatsApp Provider] ⚠️ Connection closed: ${this.lastDisconnectReason}`);

          const shouldReconnect = !this.isExplicitDisconnect && statusCode !== DisconnectReason.loggedOut;

          if (statusCode === DisconnectReason.loggedOut) {
            console.log('[WhatsApp Provider] User logged out of WhatsApp Web. Clearing credentials...');
            this.status = 'SESSION_EXPIRED';
            this.connectedPhone = null;
            this.connectedAt = null;
            this.lastError = 'WhatsApp session expired or logged out from device. Please link again.';
            await this._clearAuthFolder();
            this._notifyState();
          } else if (shouldReconnect) {
            this.status = 'RECONNECTING';
            this._notifyState();
            this._scheduleReconnect();
          } else {
            this.status = 'DISCONNECTED';
            this._notifyState();
          }
        }
      });

      return true;
    } catch (err) {
      console.error('[WhatsApp Provider] Socket startup error:', err);
      this.status = 'FAILED';
      this.lastError = err.message;
      this._notifyState();
      return false;
    }
  }

  _scheduleReconnect() {
    if (this.isReconnecting || this.isExplicitDisconnect) return;
    this.isReconnecting = true;
    this.reconnectAttempts++;

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000); // Exponential backoff (2s, 4s, 8s, max 30s)
    console.log(`[WhatsApp Provider] Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay / 1000}s...`);

    setTimeout(async () => {
      this.isReconnecting = false;
      if (this.reconnectAttempts <= this.maxReconnectAttempts) {
        await this._startSocket();
      } else {
        console.warn('[WhatsApp Provider] Max reconnect attempts reached.');
        this.status = 'FAILED';
        this.lastError = 'Unable to reconnect to WhatsApp network after multiple attempts. Please link again.';
        this._notifyState();
      }
    }, delay);
  }

  async startLinking(options = {}) {
    this._clearExpiryTimer();
    this.reconnectAttempts = 0;
    this.currentQrRaw = null;
    this.currentQrDataUrl = null;
    this.currentPairingCode = null;
    this.lastError = null;

    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch (_) {}
      this.sock = null;
    }

    // Refresh auth state
    const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
    this.authState = state;
    this.saveCreds = saveCreds;

    return await this._startSocket(options);
  }

  async refreshLinking() {
    return await this.startLinking();
  }

  async disconnect() {
    this.isExplicitDisconnect = true;
    this._clearExpiryTimer();

    if (this.sock) {
      try {
        await this.sock.logout().catch(() => {});
      } catch (_) {}
      try {
        this.sock.end(undefined);
      } catch (_) {}
      this.sock = null;
    }

    await this._clearAuthFolder();

    this.isConnected = false;
    this.status = 'NOT_LINKED';
    this.connectedPhone = null;
    this.connectedAt = null;
    this.currentQrRaw = null;
    this.currentQrDataUrl = null;
    this.currentPairingCode = null;
    this.qrExpiresAt = null;

    console.log('[WhatsApp Provider] WhatsApp disconnected and session wiped cleanly.');
    this._notifyState();
    return true;
  }

  async _clearAuthFolder() {
    try {
      if (fs.existsSync(this.sessionDir)) {
        const files = fs.readdirSync(this.sessionDir);
        for (const file of files) {
          fs.unlinkSync(path.join(this.sessionDir, file));
        }
      }
    } catch (e) {
      console.error('[WhatsApp Provider] Error cleaning auth folder:', e);
    }
  }

  getStatus() {
    const now = Date.now();
    let remainingSeconds = 0;

    if (this.qrExpiresAt && this.qrExpiresAt > now) {
      remainingSeconds = Math.max(0, Math.floor((this.qrExpiresAt - now) / 1000));
    } else if (this.qrExpiresAt && this.qrExpiresAt <= now && !this.isConnected) {
      if (this.status === 'QR_READY' || this.status === 'PAIRING_READY' || this.status === 'WAITING_FOR_SCAN') {
        this.status = 'QR_EXPIRED';
        this.currentQrRaw = null;
        this.currentQrDataUrl = null;
        this.currentPairingCode = null;
        this.lastError = 'QR expired. Generate a new QR to link WhatsApp again.';
      }
    }

    return {
      provider: this.name,
      status: this.status,
      isConnected: this.isConnected,
      connectedPhone: this.connectedPhone,
      connectedAt: this.connectedAt,
      lastDisconnectReason: this.lastDisconnectReason,
      lastError: this.lastError,
      qrDataUrl: this.status === 'QR_READY' ? this.currentQrDataUrl : null,
      qrRaw: this.status === 'QR_READY' ? this.currentQrRaw : null,
      pairingCode: this.status === 'PAIRING_READY' ? this.currentPairingCode : null,
      expiresAt: this.qrExpiresAt,
      expiresInSeconds: remainingSeconds,
      timestamp: new Date().toISOString(),
    };
  }

  async sendMessage(phoneNumber, messageText) {
    if (!this.isConnected || !this.sock) {
      throw new Error('WhatsApp is not connected. Please link WhatsApp first from the "WhatsApp & Link" screen.');
    }

    const cleanPhone = this._cleanPhone(phoneNumber);
    if (!cleanPhone || cleanPhone.length < 10) {
      throw new Error(`Invalid recipient phone number: '${phoneNumber}'. Must be at least 10 digits.`);
    }

    const jid = `${cleanPhone}@s.whatsapp.net`;

    try {
      // Send message using Baileys socket
      const sent = await this.sock.sendMessage(jid, { text: messageText });
      const messageId = sent?.key?.id || `msg-${Date.now()}`;

      return {
        success: true,
        messageId,
        recipient: cleanPhone,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      console.error(`[WhatsApp Provider] Error sending to ${cleanPhone}:`, err.message);
      throw new Error(`WhatsApp delivery failed: ${err.message}`);
    }
  }
}

module.exports = BaileysProvider;
