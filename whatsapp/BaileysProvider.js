// ==================================================================================
// CHANDRAMAULI ERP - BAILEYS WHATSAPP PROVIDER IMPLEMENTATION
// Persistent Multi-Device WhatsApp Web protocol with dynamic QR rotation,
// 5-minute total linking countdown window, auto-reconnection, and pairing codes.
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
  Browsers,
} = require('@whiskeysockets/baileys');

const TOTAL_LINKING_WINDOW_MS = 300000; // 5 minutes = 300,000 milliseconds

class BaileysProvider extends IWhatsAppProvider {
  constructor(options = {}) {
    super('Baileys');
    this.sessionDir = options.sessionDir || path.join(__dirname, '../data/whatsapp_auth');
    this.events = new EventEmitter();

    this.sock = null;
    this.authState = null;
    this.saveCreds = null;

    // Connection state
    this.status = 'NOT_LINKED'; // NOT_LINKED, INITIALIZING, QR_READY, PAIRING_READY, CONNECTED, DISCONNECTED, RECONNECTING, QR_EXPIRED
    this.isConnected = false;
    this.connectedPhone = null;
    this.connectedAt = null;
    this.lastDisconnectReason = null;
    this.lastError = null;

    // Active linking session (5-minute total window with dynamic QR rotation)
    this.currentQrRaw = null;
    this.currentQrDataUrl = null;
    this.currentPairingCode = null;
    this.linkingDeadline = null;
    this.sessionTimer = null;
    this.linkingOptions = {};

    // Reconnection parameters
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.isReconnecting = false;
    this.isExplicitDisconnect = false;
  }

  get qrExpiresAt() {
    return this.linkingDeadline;
  }

  set qrExpiresAt(val) {
    this.linkingDeadline = val;
  }

  _notifyState() {
    this.events.emit('state_changed', this.getStatus());
  }

  _clearSessionTimer() {
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
  }

  _startMasterSessionTimer() {
    this._clearSessionTimer();
    this.linkingDeadline = Date.now() + TOTAL_LINKING_WINDOW_MS;

    this.sessionTimer = setTimeout(() => {
      if (!this.isConnected && (this.status === 'QR_READY' || this.status === 'PAIRING_READY' || this.status === 'INITIALIZING' || this.status === 'RECONNECTING')) {
        console.log('[WhatsApp Provider] 5 minutes session deadline reached without connection.');
        this.status = 'QR_EXPIRED';
        this.currentQrRaw = null;
        this.currentQrDataUrl = null;
        this.currentPairingCode = null;
        this.linkingDeadline = null;
        this.lastError = '5 मिनट बीत गए और लिंक नहीं हुआ। फिर से लिंक करने के लिए नया QR कोड बनाएँ।';

        if (this.sock) {
          try {
            this.sock.end(undefined);
          } catch (_) {}
          this.sock = null;
        }

        this._notifyState();
      }
    }, TOTAL_LINKING_WINDOW_MS);
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
      this.linkingOptions = options;
      this.status = this.isConnected ? 'CONNECTED' : (this.authState?.creds?.registered ? 'RECONNECTING' : 'INITIALIZING');
      this._notifyState();

      const logger = pino({ level: 'silent' });
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

      // Use standard Ubuntu Chrome browser string to avoid WhatsApp anti-bot handshake failure
      const browserConfig = Browsers ? Browsers.ubuntu('Chrome') : ['Chandramauli ERP', 'Chrome', '1.0.0'];

      this.sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: {
          creds: this.authState.creds,
          keys: makeCacheableSignalKeyStore(this.authState.keys, logger),
        },
        generateHighQualityLinkPreview: false,
        browser: browserConfig,
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
            if (!this.sock || this.isConnected) return;
            try {
              const code = await this.sock.requestPairingCode(cleanPhone);
              this.currentPairingCode = code ? (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code) : null;
              this.status = 'PAIRING_READY';
              this.lastError = null;
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

        // 1. QR Code Received or Rotated from WhatsApp Server
        if (qr && !options.usePairingCode) {
          // If the 5 minutes overall deadline has expired, don't show new QR
          if (this.linkingDeadline && Date.now() >= this.linkingDeadline) {
            this.status = 'QR_EXPIRED';
            this.currentQrRaw = null;
            this.currentQrDataUrl = null;
            this.lastError = '5 मिनट बीत गए और लिंक नहीं हुआ। फिर से लिंक करने के लिए नया QR कोड बनाएँ।';
            this._notifyState();
            return;
          }

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
          this.lastError = null;
          this._notifyState();
          console.log('[WhatsApp Provider] Fresh/rotated QR Code received from WhatsApp. Immediately updated in app.');
        }

        // 2. Connection Open (Authenticated Successfully!)
        if (connection === 'open') {
          this.isConnected = true;
          this.status = 'CONNECTED';
          this.reconnectAttempts = 0;
          this.isReconnecting = false;
          this.connectedAt = new Date().toISOString();
          this.lastDisconnectReason = null;
          this.lastError = null;

          this._clearSessionTimer();
          this.linkingDeadline = null;
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

          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const reason = lastDisconnect?.error?.message || 'Unknown network error';
          this.lastDisconnectReason = `Code ${statusCode}: ${reason}`;

          console.warn(`[WhatsApp Provider] Connection closed: ${this.lastDisconnectReason}`);

          if (this.isExplicitDisconnect) {
            this.status = 'NOT_LINKED';
            this._notifyState();
            return;
          }

          // Case A: User was previously registered/logged-in and logged out from device
          if (this.authState?.creds?.registered && statusCode === DisconnectReason.loggedOut) {
            console.log('[WhatsApp Provider] User logged out from WhatsApp device.');
            this.status = 'SESSION_EXPIRED';
            this.connectedPhone = null;
            this.connectedAt = null;
            this.lastError = 'WhatsApp session was logged out from device. Please link again.';
            await this._clearAuthFolder();
            this._notifyState();
            return;
          }

          // Case B: Linking in progress and within the 5-minute session window!
          // WhatsApp closes connection during QR rotation / handshake refresh; keep reconnecting to get the fresh QR!
          if (this.linkingDeadline && Date.now() < this.linkingDeadline && !this.isConnected) {
            console.log('[WhatsApp Provider] QR handshake cycled during linking. Fetching next rotated QR...');
            this._scheduleLinkingReconnect(options);
            return;
          }

          // Case C: Normal reconnect for an authenticated session
          if (this.authState?.creds?.registered) {
            this.status = 'RECONNECTING';
            this._notifyState();
            this._scheduleReconnect();
            return;
          }

          // Case D: 5 minutes expired or session ended
          this._clearSessionTimer();
          this.linkingDeadline = null;
          this.status = 'QR_EXPIRED';
          this.currentQrRaw = null;
          this.currentQrDataUrl = null;
          this.currentPairingCode = null;
          this.lastError = '5 मिनट बीत गए और लिंक नहीं हुआ। फिर से लिंक करने के लिए नया QR कोड बनाएँ।';
          this._notifyState();
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

  _scheduleLinkingReconnect(options = {}) {
    if (this.isReconnecting) return;
    this.isReconnecting = true;

    setTimeout(async () => {
      this.isReconnecting = false;
      if (this.linkingDeadline && Date.now() < this.linkingDeadline && !this.isConnected) {
        try {
          if (this.sock) {
            this.sock.end(undefined);
            this.sock = null;
          }
          await this._startSocket(options);
        } catch (e) {
          console.error('[WhatsApp Provider] Linking reconnect error:', e.message);
        }
      }
    }, 1500);
  }

  _scheduleReconnect() {
    if (this.isReconnecting || this.isExplicitDisconnect) return;
    this.isReconnecting = true;
    this.reconnectAttempts++;

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    console.log(`[WhatsApp Provider] Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay / 1000}s...`);

    setTimeout(async () => {
      this.isReconnecting = false;
      if (this.reconnectAttempts <= this.maxReconnectAttempts) {
        await this._startSocket();
      } else {
        console.warn('[WhatsApp Provider] Max reconnect attempts reached.');
        this.status = 'FAILED';
        this.lastError = 'Unable to re-establish connection after multiple attempts.';
        this._notifyState();
      }
    }, delay);
  }

  async startLinking(options = {}) {
    this._clearSessionTimer();
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

    // If starting a fresh linking attempt, ensure clean unauthenticated session
    if (!this.isConnected) {
      await this._clearAuthFolder();
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
    this.authState = state;
    this.saveCreds = saveCreds;

    // Start 5-minute total linking window
    this._startMasterSessionTimer();

    return await this._startSocket(options);
  }

  async refreshLinking() {
    return await this.startLinking(this.linkingOptions);
  }

  async disconnect() {
    this.isExplicitDisconnect = true;
    this._clearSessionTimer();
    this.linkingDeadline = null;

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

    console.log('[WhatsApp Provider] WhatsApp disconnected and session wiped cleanly.');
    this._notifyState();
    return true;
  }

  async _clearAuthFolder() {
    try {
      if (fs.existsSync(this.sessionDir)) {
        const files = fs.readdirSync(this.sessionDir);
        for (const file of files) {
          try {
            fs.unlinkSync(path.join(this.sessionDir, file));
          } catch (_) {}
        }
      }
    } catch (e) {
      console.error('[WhatsApp Provider] Error cleaning auth folder:', e);
    }
  }

  getStatus() {
    const now = Date.now();
    let remainingSeconds = 0;

    if (this.linkingDeadline && this.linkingDeadline > now) {
      remainingSeconds = Math.max(0, Math.floor((this.linkingDeadline - now) / 1000));
    } else if (this.linkingDeadline && this.linkingDeadline <= now && !this.isConnected) {
      if (this.status === 'QR_READY' || this.status === 'PAIRING_READY' || this.status === 'INITIALIZING') {
        this.status = 'QR_EXPIRED';
        this.currentQrRaw = null;
        this.currentQrDataUrl = null;
        this.currentPairingCode = null;
        this.lastError = '5 मिनट बीत गए और लिंक नहीं हुआ। फिर से लिंक करने के लिए नया QR कोड बनाएँ।';
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
      expiresAt: this.linkingDeadline,
      expiresInSeconds: remainingSeconds,
      timestamp: new Date().toISOString(),
    };
  }

  _cleanPhone(phone) {
    if (!phone) return '';
    let digits = phone.toString().replace(/[^0-9]/g, '');
    if (digits.startsWith('0')) digits = digits.substring(1);
    // If 10 digits (standard Indian mobile number without country code), prepend 91
    if (digits.length === 10) {
      digits = '91' + digits;
    }
    return digits;
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
