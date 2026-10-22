// ==================================================================================
// CHANDRAMAULI ERP - WHATSAPP PROVIDER INTERFACE / ABSTRACTION
// Modular provider pattern allowing unofficial (Baileys) or official Cloud API
// Developer: Prince Singh
// ==================================================================================

class IWhatsAppProvider {
  constructor(name = 'GenericWhatsAppProvider') {
    this.name = name;
  }

  async init() {
    throw new Error('init() must be implemented by provider');
  }

  async startLinking(options = {}) {
    throw new Error('startLinking() must be implemented by provider');
  }

  async refreshLinking() {
    throw new Error('refreshLinking() must be implemented by provider');
  }

  getStatus() {
    throw new Error('getStatus() must be implemented by provider');
  }

  async disconnect() {
    throw new Error('disconnect() must be implemented by provider');
  }

  async sendMessage(phoneNumber, messageText) {
    throw new Error('sendMessage() must be implemented by provider');
  }
}

module.exports = IWhatsAppProvider;
