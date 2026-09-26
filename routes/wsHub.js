const WebSocket = require('ws');
const crypto = require('crypto');
const { gql } = require('apollo-server-express');

/**
 * Parent WebSocket Realtime Notification Hub
 * Runs on a dedicated WebSocket port (3013) or attaches to HTTP server
 */
class ParentWsHub {
  constructor() {
    this.wss = null;
    this.keystone = null;
    this.parentRooms = new Map();
    this.allClients = new Set();
    this.port = process.env.WS_PORT || 3013;
  }

  /**
   * Start standalone WebSocket server on dedicated port (3013)
   */
  startServer(keystone) {
    if (this.wss) return;
    this.keystone = keystone;

    this.wss = new WebSocket.Server({ port: this.port });

    this.wss.on('connection', async (ws, request) => {
      try {
        const urlObj = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
        const authResult = await this.authenticate(urlObj);

        if (!authResult.success) {
          console.warn('[WS Hub Auth Failed]:', authResult.message);
          ws.close(4001, authResult.message);
          return;
        }

        this.handleConnection(ws, authResult.parent);
      } catch (err) {
        console.error('[WS Connection Error]:', err);
        ws.close(1011, 'Internal Server Error');
      }
    });

    console.log(`🚀 [WebSocket Hub] Parent Realtime Hub listening on port ${this.port} (path /ws/parent)`);
  }

  /**
   * Helper: Get config from SystemSetting
   */
  async getPortalConfig(context) {
    try {
      const { data } = await context.executeGraphQL({
        context,
        query: gql`
          query {
            allSystemSettings(where: { key: "PORTAL_GATEWAY_CONFIG" }) {
              id
              value
            }
          }
        `
      });

      if (data?.allSystemSettings?.length > 0) {
        return JSON.parse(data.allSystemSettings[0].value);
      }
    } catch (e) {
      console.warn('[WS Hub] Error reading PORTAL_GATEWAY_CONFIG:', e.message);
    }

    return {
      portal_enabled: true,
      api_key: process.env.PARENT_PORTAL_SECRET || 'camerangochoang_portal_secret_2026',
      ticket_ttl_seconds: 300
    };
  }

  /**
   * Authenticate handshake parameters
   */
  async authenticate(urlObj) {
    const phone = (urlObj.searchParams.get('phone') || '').trim();
    const tsStr = (urlObj.searchParams.get('ts') || '').trim();
    const sig = (urlObj.searchParams.get('sig') || '').trim();

    if (!phone || !tsStr || !sig) {
      return { success: false, message: 'Missing phone, ts, or sig' };
    }

    const context = this.keystone.createContext({ schema: this.keystone.schema, isAccessAllowed: true });
    const config = await this.getPortalConfig(context);

    if (config.portal_enabled === false) {
      return { success: false, message: 'Portal Gateway is currently disabled' };
    }

    const ts = parseInt(tsStr, 10);
    const now = Math.floor(Date.now() / 1000);
    const ttl = config.ticket_ttl_seconds || 300;

    if (Math.abs(now - ts) > ttl) {
      return { success: false, message: 'Ticket expired (timestamp delta > ' + ttl + 's)' };
    }

    // Verify HMAC
    let cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.startsWith('84')) cleanPhone = '0' + cleanPhone.slice(2);

    const rawData = `${cleanPhone}:${ts}`;
    const expectedSig = crypto.createHmac('sha256', config.api_key).update(rawData).digest('hex');

    if (sig !== expectedSig) {
      return { success: false, message: 'Invalid HMAC signature' };
    }

    // Find parent in database
    const findPhoneQuery = gql`
      query FindParentByPhone($number: String!) {
        allPhones(where: { number: $number }) {
          id
          number
          parent {
            id
            code
            name
            debt
            balance
            hocsinhs {
              id
              name
              lophoc {
                id
                name
              }
            }
          }
        }
      }
    `;

    const phoneRes = await context.executeGraphQL({
      context,
      query: findPhoneQuery,
      variables: { number: cleanPhone }
    });

    const parent = phoneRes.data?.allPhones?.[0]?.parent;
    if (!parent) {
      return { success: false, message: 'Parent not found for phone number: ' + cleanPhone };
    }

    return { success: true, parent: { ...parent, phone: cleanPhone } };
  }

  /**
   * Handle active connection
   */
  handleConnection(ws, parent) {
    ws.parent = parent;
    ws.isAlive = true;

    this.allClients.add(ws);

    if (!this.parentRooms.has(parent.id)) {
      this.parentRooms.set(parent.id, new Set());
    }
    this.parentRooms.get(parent.id).add(ws);

    console.log(`[WS Hub] Phụ huynh kết nối: ${parent.name} (${parent.code}) | SĐT: ${parent.phone} | Active sockets: ${this.allClients.size}`);

    // Send Welcome & Auth Success frame
    ws.send(JSON.stringify({
      type: 'AUTH_SUCCESS',
      message: 'Kết nối kênh thông báo Trường Ngọc Hoàng thành công',
      parent: {
        id: parent.id,
        code: parent.code,
        name: parent.name,
        phone: parent.phone,
        debt: parent.debt || 0,
        balance: parent.balance || 0,
        students: (parent.hocsinhs || []).map(h => ({
          id: h.id,
          name: h.name,
          className: h.lophoc?.name || ''
        }))
      },
      connectedAt: new Date().toISOString()
    }));

    // Setup heartbeat & message receiver
    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message);
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', time: Date.now() }));
        }
      } catch (e) {}
    });

    ws.on('close', () => {
      this.allClients.delete(ws);
      if (this.parentRooms.has(parent.id)) {
        this.parentRooms.get(parent.id).delete(ws);
        if (this.parentRooms.get(parent.id).size === 0) {
          this.parentRooms.delete(parent.id);
        }
      }
      console.log(`[WS Hub] Phụ huynh ngắt kết nối: ${parent.code} | Active sockets: ${this.allClients.size}`);
    });

    ws.on('error', (err) => {
      console.error(`[WS Hub Error] Socket ${parent.code}:`, err.message);
    });
  }

  /**
   * Broadcast an event to a specific parent room
   */
  sendToParent(parentId, type, data) {
    if (!this.parentRooms.has(parentId)) return 0;

    const payload = JSON.stringify({
      type,
      data,
      timestamp: new Date().toISOString()
    });

    let count = 0;
    for (const ws of this.parentRooms.get(parentId)) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
        count++;
      }
    }
    return count;
  }

  /**
   * Broadcast an event to all connected parents (School Announcement)
   */
  broadcastAll(type, data) {
    const payload = JSON.stringify({
      type,
      data,
      timestamp: new Date().toISOString()
    });

    let count = 0;
    for (const ws of this.allClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
        count++;
      }
    }
    return count;
  }

  /**
   * Get active connection stats
   */
  getStats() {
    return {
      totalConnections: this.allClients.size,
      activeParents: this.parentRooms.size
    };
  }
}

const wsHubInstance = new ParentWsHub();
module.exports = wsHubInstance;
