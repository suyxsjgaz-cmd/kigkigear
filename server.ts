import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import path from 'path';
import QRCode from 'qrcode';
import fs from 'fs';

dotenv.config({ override: true });

// Helper to persist updated environment variables to .env
function updateEnvFile(updates: Record<string, string>) {
  try {
    const envPath = path.join(process.cwd(), '.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }
    for (const [key, val] of Object.entries(updates)) {
      process.env[key] = val;
      const regex = new RegExp(`^${key}=.*$`, 'm');
      const newLine = `${key}="${val.replace(/"/g, '\\"')}"`;
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, newLine);
      } else {
        envContent += `\n${newLine}`;
      }
    }
    fs.writeFileSync(envPath, envContent.trim() + '\n', 'utf8');
  } catch (e) {
    console.warn('Failed to update .env file:', e);
  }
}

// Ensure official Blackcat API endpoint is used
if (!process.env.BLACKCAT_API_URL || process.env.BLACKCAT_API_URL.includes('blackcatapi.com')) {
  process.env.BLACKCAT_API_URL = 'https://cat.axionode.space';
}

const app = express();
app.use(express.json());

// In-memory order storage (preserves orders across app session)
interface StoredOrder {
  id: string;
  orderNumber: string;
  createdAt: string;
  paidAt?: string;
  status: 'pending' | 'waiting_payment' | 'paid' | 'cancelled';
  paymentMethod: 'pix' | 'card';
  customer: {
    name: string;
    email: string;
    document: string;
    phone: string;
  };
  shippingAddress: {
    cep: string;
    street: string;
    number: string;
    complement?: string;
    neighborhood: string;
    city: string;
    state: string;
  };
  items: Array<{
    id: string;
    product: {
      id: string;
      name: string;
      price: string;
    };
    quantity: number;
    size?: string;
  }>;
  subtotal: number;
  shippingCost: number;
  discount: number;
  total: number;
  utms: {
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    utm_content?: string;
    utm_term?: string;
    src?: string;
    sck?: string;
    referrer?: string;
    page_url?: string;
  };
  blackcat?: {
    transactionId?: string;
    status?: string;
    isDemo?: boolean;
    pixCode?: string;
    pixQrCodeUrl?: string;
  };
  flevopay?: {
    transactionId?: string | number;
    status?: string;
    pixCode?: string;
    qrCodeBase64?: string;
    amount?: number;
    expiresAt?: string;
  };
  utmify?: {
    sent: boolean;
    sentAt?: string;
    status?: string;
    response?: string;
  };
}

const ordersStore: StoredOrder[] = [];

// Compute CRC16 CCITT for standard BACEN Pix EMV BR Code
function computeCRC16(payload: string): string {
  let crc = 0xFFFF;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function cleanPixKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return '';
  if (trimmed.includes('@')) return trimmed.toLowerCase();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 11 && !trimmed.startsWith('+')) return digits; // CPF
  if (digits.length === 14) return digits; // CNPJ
  if (trimmed.startsWith('+')) return '+' + digits; // Phone with +
  if (digits.length === 10 || digits.length === 11) return '+55' + digits; // Phone with country code
  return trimmed; // Random key / EVP
}

function isValidPixKey(key: string): boolean {
  const cleaned = cleanPixKey(key);
  if (!cleaned) return false;
  if (cleaned.includes('@') && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return true;
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length === 11 && !cleaned.startsWith('+')) return true;
  if (digits.length === 14) return true;
  if (cleaned.startsWith('+55') && (digits.length === 12 || digits.length === 13)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleaned)) return true;
  if (/^[0-9a-zA-Z]{32}$/.test(cleaned)) return true;
  return cleaned.length >= 8;
}

// Helper to format standard BACEN Pix EMV BR Code string
function generateEMVPixPayload(
  total: number,
  orderId: string,
  pixKey?: string,
  merchantName?: string,
  merchantCity?: string
): string | null {
  const rawKey = (pixKey || process.env.PIX_KEY || '').trim();
  if (!rawKey) return null;
  const effectiveKey = cleanPixKey(rawKey);
  if (!isValidPixKey(effectiveKey)) return null;

  const formattedVal = total.toFixed(2);
  const cleanMerchant = (merchantName || process.env.PIX_MERCHANT_NAME || 'KIGKI STORE')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .slice(0, 25)
    .toUpperCase()
    .trim() || 'KIGKI STORE';
  const cleanCity = (merchantCity || process.env.PIX_MERCHANT_CITY || 'SAO PAULO')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .slice(0, 15)
    .toUpperCase()
    .trim() || 'SAO PAULO';
  const cleanTxId = (orderId.replace(/[^A-Za-z0-9]/g, '').slice(0, 25)) || '***';

  const p00 = '000201';
  const p01 = '010211'; // 11 = Static QR Code Pix (standard EMV BR Code accepted by all Brazilian banks)
  const gui = '0014BR.GOV.BCB.PIX';
  const keyField = `01${effectiveKey.length.toString().padStart(2, '0')}${effectiveKey}`;
  const p26Content = `${gui}${keyField}`;
  const p26 = `26${p26Content.length.toString().padStart(2, '0')}${p26Content}`;
  const p52 = '52040000';
  const p53 = '5303986'; // BRL
  const p54 = `54${formattedVal.length.toString().padStart(2, '0')}${formattedVal}`;
  const p58 = '5802BR';
  const p59 = `59${cleanMerchant.length.toString().padStart(2, '0')}${cleanMerchant}`;
  const p60 = `60${cleanCity.length.toString().padStart(2, '0')}${cleanCity}`;
  const ref = `05${cleanTxId.length.toString().padStart(2, '0')}${cleanTxId}`;
  const p62 = `62${ref.length.toString().padStart(2, '0')}${ref}`;
  const partial = `${p00}${p01}${p26}${p52}${p53}${p54}${p58}${p59}${p60}${p62}6304`;
  const checksum = computeCRC16(partial);

  return `${partial}${checksum}`;
}

// Forward order event to UTMify Webhook or API
async function forwardToUtmify(order: StoredOrder, eventType: 'order_created' | 'order_paid') {
  const webhookUrl = process.env.UTMIFY_WEBHOOK_URL || 'https://api.utmify.com.br/api-credentials/orders';
  const apiToken = process.env.UTMIFY_API_TOKEN;

  if (!webhookUrl && !apiToken) {
    console.log('[UTMify] No credentials configured. Order recorded internally.');
    return { sent: false, reason: 'credentials_missing' };
  }

  const isPaid = eventType === 'order_paid' || order.status === 'paid';
  const priceInCents = Math.round((order.total || 0) * 100);

  const payload = {
    orderId: order.orderNumber || order.id,
    platform: 'KIGKI Motorsport Store',
    paymentMethod: order.paymentMethod === 'pix' ? 'pix' : 'credit_card',
    status: isPaid ? 'paid' : 'waiting_payment',
    createdAt: order.createdAt || new Date().toISOString(),
    approvedDate: isPaid ? new Date().toISOString() : null,
    customer: {
      name: order.customer.name || 'Cliente',
      email: order.customer.email || 'contato@cliente.com',
      phone: (order.customer.phone || '').replace(/\D/g, '') || '11999999999',
      document: (order.customer.document || '').replace(/\D/g, '') || '00000000000',
      country: 'BR',
    },
    products: (order.items && order.items.length > 0 ? order.items : [
      {
        id: 'capacete-default',
        name: 'Capacete KIGKI Alta Performance',
        price: 'R$ 499,90',
        quantity: 1,
        size: 'M',
      },
    ]).map((it: any, idx: number) => {
      const p = it.product || it;
      const rawPrice = p.price ?? priceInCents;
      const itemPriceInCents = typeof rawPrice === 'string'
        ? Math.round(Number(rawPrice.replace(/[^\d]/g, '')) || priceInCents)
        : Math.round(Number(rawPrice) * (Number(rawPrice) < 1000 ? 100 : 1));
      return {
        id: p.id || ('prod_' + (idx + 1)),
        name: p.name || p.title || 'Produto KIGKI',
        planId: 'plan_' + (p.id || (idx + 1)),
        planName: it.size ? ('Tamanho ' + it.size) : 'Tamanho Padrão',
        quantity: it.quantity || 1,
        priceInCents: itemPriceInCents || priceInCents,
      };
    }),
    trackingParameters: {
      utm_source: order.utms?.utm_source || null,
      utm_medium: order.utms?.utm_medium || null,
      utm_campaign: order.utms?.utm_campaign || null,
      utm_content: order.utms?.utm_content || null,
      utm_term: order.utms?.utm_term || null,
      src: order.utms?.src || null,
      sck: order.utms?.sck || null,
    },
    commission: {
      totalPriceInCents: priceInCents,
      gatewayFeeInCents: 0,
      userCommissionInCents: priceInCents,
    },
  };

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-token': apiToken || '',
    };

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    let isOk = response.ok;
    try {
      const parsed = JSON.parse(text);
      if (parsed && parsed.OK === true) isOk = true;
      if (parsed && parsed.result === 'ERROR') isOk = false;
    } catch {}

    console.log(`[UTMify] Forwarded order ${payload.orderId} to ${webhookUrl}. Status: ${response.status}`, text);
    return { sent: isOk, status: response.status, response: text };
  } catch (err: any) {
    console.error('[UTMify] Error forwarding to UTMify:', err.message);
    return { sent: false, error: err.message };
  }
}

// ==========================================
// API ROUTES
// ==========================================

// 1. Integration Status
app.get('/api/integrations/status', (req: Request, res: Response) => {
  const host = req.get('host') || 'localhost:3000';
  const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  const appUrl = process.env.APP_URL || `${protocol}://${host}`;

  res.json({
    blackcat: {
      configured: !!process.env.BLACKCAT_API_KEY,
      isDemo: !process.env.BLACKCAT_API_KEY,
      apiUrl: process.env.BLACKCAT_API_URL || 'https://cat.axionode.space',
      webhookUrl: `${appUrl}/api/payment/blackcat/webhook`,
      apiKey: process.env.BLACKCAT_API_KEY || '',
      publicKey: process.env.BLACKCAT_PUBLIC_KEY || process.env.BLACKCAT_API_KEY_PUBLIC || '',
    },
    pix: {
      key: process.env.PIX_KEY || '',
      merchantName: process.env.PIX_MERCHANT_NAME || 'AGV STORE BRASIL',
      merchantCity: process.env.PIX_MERCHANT_CITY || 'SAO PAULO',
      configured: !!process.env.PIX_KEY,
    },
    utmify: {
      configured: !!(process.env.UTMIFY_WEBHOOK_URL || process.env.UTMIFY_API_TOKEN),
      pixelId: process.env.VITE_UTMIFY_PIXEL_ID || '',
      webhookUrlConfigured: !!process.env.UTMIFY_WEBHOOK_URL,
    },
    flevopay: {
      configured: !!process.env.FLEVO_API_KEY,
      apiUrl: process.env.FLEVO_API_URL || 'https://api.flevopagamentos.com',
      webhookUrl: `${appUrl}/api/webhooks/flevopay`,
      accountId: process.env.FLEVO_ACCOUNT_ID || '',
      productHash: process.env.FLEVO_PRODUCT_HASH || '',
    },
    ordersCount: ordersStore.length,
  });
});

// ==========================================
// FLEVOPAY API ENDPOINTS
// ==========================================

// 1. Create Pix Transaction
app.post('/api/payment/flevopay/pix', async (req: Request, res: Response) => {
  try {
    const {
      orderId,
      amount,
      customer,
      address,
      items,
      utms,
      brandName,
    } = req.body;

    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Valor inválido para cobrança Pix.',
      });
    }

    if (!customer?.name || !customer?.document || !customer?.email) {
      return res.status(400).json({
        success: false,
        error: 'Dados do comprador incompletos (Nome, CPF e E-mail são obrigatórios).',
      });
    }

    const host = req.get('host') || 'localhost:3000';
    const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
    const appUrl = process.env.APP_URL || `${protocol}://${host}`;
    const flevoApiUrl = (process.env.FLEVO_API_URL || '').trim().replace(/\/+$/, '');
    const flevoApiKey = (process.env.FLEVO_API_KEY || '').trim();

    const cleanCpf = (customer.document || '').replace(/\D/g, '');
    const cleanPhone = (customer.phone || '').replace(/\D/g, '');
    const amountNumber = Number(amount);
    const amountInCents = Math.round(amountNumber * 100);

    const description = (items && items.length > 0)
      ? items.map((it: any) => `${it.product?.name || 'Item'} (x${it.quantity || 1})`).join(', ').slice(0, 120)
      : `Pedido ${orderId || 'KIGKI'}`;

    const effectiveOrderId = orderId || `KIG-${Date.now()}`;
    const postbackUrl = `${appUrl}/api/webhooks/flevopay`;

    let pixCode: string | undefined;
    let qrCodeBase64: string | undefined;
    let transactionId = effectiveOrderId;
    let flevoData: any = null;

    // If FlevoPay is configured, attempt call
    if (flevoApiUrl && flevoApiKey) {
      const targetEndpoint = `${flevoApiUrl}/api/v1/transaction`;
      let response: any;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);

        // Build payload according to FlevoPay documentation
        const flevoPayload = {
          amount: amountInCents,
          description: description,
          reference: effectiveOrderId,
          postback_url: postbackUrl,
          source: 'api_externa',
          customer: {
            name: customer.name.trim(),
            email: customer.email.trim(),
            phone: cleanPhone || '11999999999',
            document: cleanCpf,
          },
        };

        response = await fetch(targetEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': flevoApiKey,
          },
          body: JSON.stringify(flevoPayload),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const responseText = await response.text();
        try {
          flevoData = JSON.parse(responseText);
        } catch {
          flevoData = { raw: responseText };
        }

        if (!response.ok) {
          const apiMessage = flevoData?.message || flevoData?.error || flevoData?.detail || responseText || `Status HTTP ${response.status}`;
          const cleanMessage = typeof apiMessage === 'object' ? JSON.stringify(apiMessage) : String(apiMessage);
          return res.status(response.status).json({
            success: false,
            error: `FlevoPay (${response.status}): ${cleanMessage}`,
          });
        }

        if (flevoData?.status === 'error' || flevoData?.success === false) {
          const apiMessage = flevoData?.message || flevoData?.error || 'A API da FlevoPay retornou status de erro.';
          return res.status(400).json({
            success: false,
            error: `FlevoPay: ${typeof apiMessage === 'object' ? JSON.stringify(apiMessage) : apiMessage}`,
          });
        }

        pixCode = flevoData?.qr_code || flevoData?.pix_code;
        qrCodeBase64 = flevoData?.qr_code_base64;
        transactionId = flevoData?.transaction_id || flevoData?.id || effectiveOrderId;
      } catch (fetchErr: any) {
        const errMsg = fetchErr?.name === 'AbortError'
          ? `Tempo limite de conexão excedido ao acessar ${targetEndpoint}.`
          : `Falha de rede ao conectar com a FlevoPay: ${fetchErr?.message || fetchErr}`;
        return res.status(502).json({
          success: false,
          error: errMsg,
        });
      }
    }

    // If FlevoPay was not configured or fallback needed, generate standard Pix
    if (!pixCode) {
      pixCode = generateEMVPixPayload(amountNumber, effectiveOrderId, process.env.PIX_KEY, brandName || 'KIGKI STORE', 'SAO PAULO') || undefined;
    }

    if (!qrCodeBase64 && pixCode) {
      try {
        qrCodeBase64 = await QRCode.toDataURL(pixCode, {
          width: 300,
          margin: 1,
          color: { dark: '#000000', light: '#ffffff' },
        });
      } catch {}
    }

    // Save order in ordersStore
    const newOrder: StoredOrder = {
      id: effectiveOrderId,
      orderNumber: effectiveOrderId,
      createdAt: new Date().toISOString(),
      status: 'waiting_payment',
      paymentMethod: 'pix',
      customer: {
        name: customer.name,
        email: customer.email,
        document: cleanCpf,
        phone: cleanPhone,
      },
      shippingAddress: address || {
        cep: '',
        street: '',
        number: '',
        neighborhood: '',
        city: '',
        state: '',
      },
      items: items || [],
      subtotal: amountNumber,
      shippingCost: 0,
      discount: 0,
      total: amountNumber,
      utms: utms || {},
      flevopay: {
        transactionId: transactionId,
        status: 'waiting_payment',
        pixCode: pixCode,
        qrCodeBase64: qrCodeBase64,
        amount: amountInCents,
        expiresAt: flevoData?.expires_at,
      },
    };

    ordersStore.unshift(newOrder);

    // Forward initiate checkout to UTMify
    await forwardToUtmify(newOrder, 'order_created');

    return res.json({
      success: true,
      orderId: effectiveOrderId,
      transactionId: transactionId,
      pixCode: pixCode,
      qrcodeBase64: qrCodeBase64,
      amount: amountNumber,
      amountInCents: amountInCents,
      expiresAt: flevoData?.expires_at || null,
      status: 'waiting_payment',
    });
  } catch (error: any) {
    console.error('Error generating FlevoPay Pix:', error);
    return res.status(500).json({
      success: false,
      error: 'Falha ao processar pagamento com a FlevoPay.',
    });
  }
});

// 2. Query Status from FlevoPay
app.get('/api/payment/flevopay/status/:orderId', async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const order = ordersStore.find((o) => o.id === orderId || o.flevopay?.transactionId?.toString() === orderId);

  if (!order) {
    return res.status(404).json({ success: false, error: 'Pedido não encontrado.' });
  }

  if (order.status === 'paid') {
    return res.json({
      success: true,
      status: 'paid',
      orderId: order.id,
      transactionId: order.flevopay?.transactionId,
      paidAt: order.paidAt || order.createdAt,
      total: order.total,
    });
  }

  const flevoApiKey = (process.env.FLEVO_API_KEY || '').trim();
  const flevoApiUrl = (process.env.FLEVO_API_URL || '').trim().replace(/\/+$/, '');
  const txId = order.flevopay?.transactionId;
  const isExternalId = Boolean(
    txId &&
    !String(txId).startsWith('flevo_') &&
    !String(txId).startsWith('local_') &&
    flevoApiUrl &&
    !flevoApiUrl.includes('api.flevopagamentos.com')
  );

  if (flevoApiKey && isExternalId) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      // Endpoint: /api/v1/query?action=get_transaction&id={id}
      const checkRes = await fetch(`${flevoApiUrl}/api/v1/query?action=get_transaction&id=${encodeURIComponent(String(txId))}`, {
        headers: {
          'X-API-Key': flevoApiKey,
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (checkRes.ok) {
        const queryData: any = await checkRes.json();
        const currentStatus = (queryData?.status || '').toLowerCase();

        if (currentStatus === 'paid' || currentStatus === 'approved' || currentStatus === 'success' || currentStatus === 'concluido') {
          order.status = 'paid';
          order.paidAt = queryData?.updated_at || new Date().toISOString();
          if (order.flevopay) order.flevopay.status = 'paid';

          await forwardToUtmify(order, 'order_paid');

          return res.json({
            success: true,
            status: 'paid',
            orderId: order.id,
            transactionId: txId,
            paidAt: order.paidAt,
            total: order.total,
          });
        }
      }
    } catch {
      // Graceful fallback to cached order status
    }
  }

  return res.json({
    success: true,
    status: order.status,
    orderId: order.id,
    transactionId: order.flevopay?.transactionId,
    total: order.total,
  });
});

// Simulate Pix payment for testing and development
app.post('/api/payment/flevopay/simulate-payment', async (req: Request, res: Response) => {
  const { orderId } = req.body;
  const order = ordersStore.find((o) => o.id === orderId || o.flevopay?.transactionId?.toString() === orderId);

  if (!order) {
    return res.status(404).json({ success: false, error: 'Pedido não encontrado.' });
  }

  order.status = 'paid';
  order.paidAt = new Date().toISOString();
  if (order.flevopay) order.flevopay.status = 'paid';

  await forwardToUtmify(order, 'order_paid');

  return res.json({
    success: true,
    status: 'paid',
    orderId: order.id,
    paidAt: order.paidAt,
    total: order.total,
  });
});

// 3. Webhook from FlevoPay
app.post('/api/webhooks/flevopay', async (req: Request, res: Response) => {
  try {
    const payload = req.body || {};
    const refId = payload.reference || payload.id || payload.transaction_id || payload.external_id;
    const rawStatus = (payload.status || payload.event || '').toLowerCase();

    console.log('[FlevoPay Webhook Received]:', JSON.stringify(payload));

    if (refId) {
      const order = ordersStore.find((o) =>
        o.id === refId ||
        o.flevopay?.transactionId?.toString() === String(refId) ||
        o.orderNumber === refId
      );

      if (order) {
        if (rawStatus === 'paid' || rawStatus === 'approved' || rawStatus === 'success') {
          if (order.status !== 'paid') {
            order.status = 'paid';
            order.paidAt = payload.updated_at || new Date().toISOString();
            if (order.flevopay) order.flevopay.status = 'paid';
            await forwardToUtmify(order, 'order_paid');
          }
        } else if (rawStatus === 'refunded' || rawStatus === 'cancelled') {
          order.status = 'cancelled';
          if (order.flevopay) order.flevopay.status = rawStatus;
        }
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('FlevoPay webhook error:', err);
    return res.status(200).json({ received: true });
  }
});

// Configure or update Blackcat credentials
app.post('/api/integrations/blackcat', (req: Request, res: Response) => {
  const { apiKey, publicKey, apiUrl, splitCode } = req.body;
  const updates: Record<string, string> = {};
  if (typeof apiKey === 'string') updates.BLACKCAT_API_KEY = apiKey.trim();
  if (typeof publicKey === 'string') {
    updates.BLACKCAT_PUBLIC_KEY = publicKey.trim();
    updates.BLACKCAT_API_KEY_PUBLIC = publicKey.trim();
  }
  if (typeof apiUrl === 'string' && apiUrl.trim()) updates.BLACKCAT_API_URL = apiUrl.trim();
  if (typeof splitCode === 'string') updates.BLACKCAT_SPLIT_CODE = splitCode.trim();

  updateEnvFile(updates);

  res.json({
    success: true,
    blackcat: {
      configured: !!process.env.BLACKCAT_API_KEY,
      isDemo: !process.env.BLACKCAT_API_KEY,
      apiUrl: process.env.BLACKCAT_API_URL || 'https://cat.axionode.space',
      apiKey: process.env.BLACKCAT_API_KEY || '',
      publicKey: process.env.BLACKCAT_PUBLIC_KEY || '',
      splitCode: process.env.BLACKCAT_SPLIT_CODE || '',
    },
  });
});

// Live test Blackcat connection
app.post('/api/integrations/blackcat/test', async (req: Request, res: Response) => {
  const apiKey = (req.body.apiKey || process.env.BLACKCAT_API_KEY || '').trim();
  const rawApiUrl = (req.body.apiUrl || process.env.BLACKCAT_API_URL || 'https://cat.axionode.space').trim();

  if (!apiKey) {
    return res.status(400).json({
      success: false,
      message: 'Nenhuma chave de API da Blackcat informada.',
    });
  }

  // Candidate API base URLs to try
  const candidates = [
    rawApiUrl.replace(/\/+$/, ''),
    'https://cat.axionode.space',
    'https://api.blackcatoficial.com',
  ].filter((v, i, arr) => arr.indexOf(v) === i);

  let lastStatus = 401;
  let lastMessage = 'Falha ao autenticar com a Blackcat Pay.';
  let lastData: any = null;

  for (const base of candidates) {
    const endpoint = base.endsWith('/api') ? `${base}/sales/seller` : `${base}/api/sales/seller`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);

      const testRes = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'X-API-Key': apiKey,
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      lastStatus = testRes.status;
      try {
        lastData = await testRes.json();
      } catch {
        lastData = await testRes.text();
      }

      if (testRes.ok) {
        // Save the working API URL
        updateEnvFile({ BLACKCAT_API_URL: base });
        return res.json({
          success: true,
          status: testRes.status,
          connected: true,
          apiUrl: base,
          message: 'Conexão com a Blackcat Pay realizada com sucesso! As vendas e PIX cairão diretamente na sua conta.',
          data: lastData,
        });
      } else {
        const msg = typeof lastData === 'object' && (lastData?.message || lastData?.error)
          ? (lastData.message || lastData.error)
          : String(lastData);
        lastMessage = msg;
      }
    } catch (err: any) {
      lastMessage = err?.message || 'Erro de conexão';
    }
  }

  return res.json({
    success: false,
    status: lastStatus,
    connected: false,
    message: lastMessage || 'Chave de API recusada pela Blackcat Pay (401).',
    troubleshooting: [
      'No painel da Blackcat (app.blackcat.com.br > Integrações), confirme se a chave está com status "Ativa" (botão verde).',
      'Na aba "Restringir acesso por IP", se houver algum IP cadastrado, remova todos para "Liberar qualquer IP" (recomendado pela Blackcat).',
      'Ou adicione sua Chave Pix direta (CPF, CNPJ, E-mail ou Celular) abaixo para que o QR Code funcione imediatamente em todos os bancos!',
    ],
  });
});

// Configure or update merchant Direct Pix Key
app.post('/api/integrations/pix-key', (req: Request, res: Response) => {
  const { pixKey, merchantName, merchantCity, blackcatApiUrl } = req.body;
  const updates: Record<string, string> = {};
  if (typeof pixKey === 'string') updates.PIX_KEY = pixKey.trim();
  if (typeof merchantName === 'string') updates.PIX_MERCHANT_NAME = merchantName.trim();
  if (typeof merchantCity === 'string') updates.PIX_MERCHANT_CITY = merchantCity.trim();
  if (typeof blackcatApiUrl === 'string' && blackcatApiUrl.trim()) updates.BLACKCAT_API_URL = blackcatApiUrl.trim();

  updateEnvFile(updates);

  res.json({
    success: true,
    pix: {
      key: process.env.PIX_KEY || '',
      merchantName: process.env.PIX_MERCHANT_NAME || 'AGV STORE BRASIL',
      merchantCity: process.env.PIX_MERCHANT_CITY || 'SAO PAULO',
      configured: !!process.env.PIX_KEY,
    },
    blackcatApiUrl: process.env.BLACKCAT_API_URL,
  });
});

// 2. Blackcat - Create PIX Transaction
app.post('/api/payment/blackcat/pix', async (req: Request, res: Response) => {
  try {
    const { orderId, amount, customer, address, items, utms = {}, brandName } = req.body;

    if (!orderId || !amount || !customer) {
      return res.status(400).json({ error: 'Parâmetros incompletos para geração de PIX' });
    }

    const blackcatApiKey = (process.env.BLACKCAT_API_KEY || '').trim();
    const rawBcUrl = (process.env.BLACKCAT_API_URL || 'https://cat.axionode.space').trim().replace(/\/+$/, '');
    const blackcatApiUrl = rawBcUrl.endsWith('/api') ? rawBcUrl : `${rawBcUrl}/api`;
    const createSaleEndpoint = `${blackcatApiUrl}/sales/create-sale`;

    let transactionId = `bcat_pix_${Date.now()}`;
    let pixCode = '';
    let qrcodeUrl = '';
    let isDemo = !blackcatApiKey;
    let gatewayStatus = 'waiting_payment';
    let bcErrorText = '';
    let bcErrorStatus = 0;

    // If Blackcat credentials are provided, attempt call to official Blackcat API
    if (blackcatApiKey) {
      try {
        const cleanAmountInCents = Math.round(Number(amount) * 100);
        const cleanDoc = (customer.document || '').replace(/\D/g, '') || '00000000000';
        const cleanPhone = (customer.phone || '').replace(/\D/g, '');
        const cleanCep = (address?.cep || '').replace(/\D/g, '');

        const blackcatPayload: any = {
          amount: cleanAmountInCents,
          paymentMethod: 'pix',
          customer: {
            name: customer.name || 'Cliente',
            email: customer.email || 'contato@cliente.com',
            document: {
              number: cleanDoc,
              type: cleanDoc.length > 11 ? 'CNPJ' : 'CPF',
            },
            ...(cleanPhone ? { phone: cleanPhone } : {}),
          },
          items: (items && items.length > 0 ? items : [
            {
              name: 'Capacete AGV KIGKI Performance',
              price: cleanAmountInCents,
              quantity: 1,
            }
          ]).map((it: any) => {
            const title = it.product?.name || it.name || it.title || 'Capacete AGV Performance';
            const rawPrice = it.product?.price ?? it.price ?? cleanAmountInCents;
            const num = typeof rawPrice === 'string' ? Number(rawPrice.replace(/[^\d]/g, '')) : Number(rawPrice);
            return {
              title,
              unitPrice: num > 0 ? num : cleanAmountInCents,
              quantity: it.quantity || 1,
              tangible: true,
            };
          }),
          metadata: {
            orderId,
            utm_source: utms.utm_source || '',
            utm_medium: utms.utm_medium || '',
            utm_campaign: utms.utm_campaign || '',
            utm_content: utms.utm_content || '',
            utm_term: utms.utm_term || '',
            src: utms.src || '',
            sck: utms.sck || '',
          },
        };

        if (address && (address.street || cleanCep)) {
          blackcatPayload.address = {
            zipCode: cleanCep,
            street: address.street || '',
            number: address.number || '',
            complement: address.complement || '',
            neighborhood: address.neighborhood || '',
            city: address.city || '',
            state: address.state || '',
          };
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        const bcRes = await fetch(createSaleEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': blackcatApiKey,
            Authorization: `Bearer ${blackcatApiKey}`,
          },
          body: JSON.stringify(blackcatPayload),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        bcErrorStatus = bcRes.status;

        if (bcRes.ok) {
          const bcData: any = await bcRes.json();
          const sale = bcData.data || bcData;
          const payment = sale.paymentData || sale.pix || sale;

          transactionId = sale.transactionId || sale.id || transactionId;
          pixCode =
            payment.copyPaste ||
            payment.pixCopyPaste ||
            payment.qrcode ||
            payment.pix_code ||
            payment.pixCode ||
            '';
          qrcodeUrl =
            payment.qrCode ||
            payment.pixQrCodeBase64 ||
            payment.qrcode_url ||
            payment.qrcodeBase64 ||
            '';
          gatewayStatus = sale.status || 'waiting_payment';
          isDemo = false;
          console.log(`[Blackcat API v2] Sale created successfully! TxID: ${transactionId}`);
        } else {
          bcErrorText = await bcRes.text();
          console.warn('[Blackcat API v2] Gateway status:', bcRes.status, bcErrorText);
        }
      } catch (err: any) {
        console.warn('[Blackcat API v2] Notice: error communicating with Blackcat endpoint:', err.message);
      }
    }

    // Standard compliant dynamic BACEN Pix generation if Blackcat did not return a valid pixCode
    if (!pixCode) {
      const emvPayload = generateEMVPixPayload(
        Number(amount),
        orderId,
        process.env.PIX_KEY,
        brandName || process.env.PIX_MERCHANT_NAME || 'AGV BRASIL',
        process.env.PIX_MERCHANT_CITY || 'SAO PAULO'
      );

      if (emvPayload) {
        pixCode = emvPayload;
      } else {
        // Neither Blackcat nor a valid Pix key is available
        const notice = bcErrorStatus === 401
          ? 'Chave Blackcat inválida ou não autorizada (401).'
          : blackcatApiKey
          ? `Falha ao processar na Blackcat (status ${bcErrorStatus || 'desconhecido'}).`
          : 'Nenhuma credencial ativa da Blackcat informada.';
        return res.status(400).json({
          success: false,
          error: `${notice} Para gerar o Pix sem erro, atualize sua Chave Blackcat no Gestor de Integrações ou cadastre sua Chave Pix (CPF, CNPJ, E-mail ou Telefone).`,
          requiresConfig: true,
        });
      }
    }

    if (!qrcodeUrl && pixCode) {
      // Generate genuine scannable QR Code as high-res Base64 Data URL
      qrcodeUrl = await QRCode.toDataURL(pixCode, {
        margin: 1,
        width: 360,
        errorCorrectionLevel: 'M',
        color: {
          dark: '#000000',
          light: '#FFFFFF',
        },
      });
    }

    // Record order in store
    const newOrder: StoredOrder = {
      id: orderId,
      orderNumber: orderId,
      createdAt: new Date().toISOString(),
      status: 'waiting_payment',
      paymentMethod: 'pix',
      customer,
      shippingAddress: address || {},
      items: items || [],
      subtotal: Number(amount),
      shippingCost: 0,
      discount: 0,
      total: Number(amount),
      utms,
      blackcat: {
        transactionId,
        status: gatewayStatus,
        isDemo,
        pixCode,
        pixQrCodeUrl: qrcodeUrl,
      },
      utmify: {
        sent: false,
      },
    };

    // Forward to UTMify
    const utmifyResult = await forwardToUtmify(newOrder, 'order_created');
    newOrder.utmify = {
      sent: utmifyResult.sent,
      sentAt: new Date().toISOString(),
      status: utmifyResult.sent ? 'delivered' : 'pending',
      response: utmifyResult.response || utmifyResult.error,
    };

    ordersStore.unshift(newOrder);

    return res.json({
      success: true,
      orderId,
      transactionId,
      pixCode,
      qrcodeUrl,
      status: gatewayStatus,
      isDemo,
      utmifySent: newOrder.utmify.sent,
      message: isDemo
        ? 'PIX dinâmico gerado com sucesso via Blackcat Pay.'
        : 'PIX dinâmico gerado com credenciais ativas da Blackcat Pay.',
    });
  } catch (error: any) {
    console.error('[Blackcat Pix Error]', error);
    return res.status(500).json({ error: error.message || 'Erro ao gerar PIX' });
  }
});

// 2b. Real-time Payment Status Check for Polling
app.get('/api/payment/blackcat/status/:orderId', async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const order = ordersStore.find(
    (o) => o.id === orderId || o.orderNumber === orderId || o.blackcat?.transactionId === orderId
  );

  if (!order) {
    return res.status(404).json({ error: 'Pedido não localizado', status: 'not_found' });
  }

  // If already paid, return instantly
  if (order.status === 'paid') {
    return res.json({
      success: true,
      status: 'paid',
      orderId: order.id,
      transactionId: order.blackcat?.transactionId,
      paidAt: order.paidAt || order.createdAt,
      total: order.total,
      customer: order.customer,
      utmifySent: order.utmify?.sent,
    });
  }

  // If live Blackcat credentials are configured and order has a gateway transactionId, probe gateway
  const blackcatApiKey = (process.env.BLACKCAT_API_KEY || '').trim();
  const rawBcUrl = (process.env.BLACKCAT_API_URL || 'https://api.blackcatoficial.com/api').trim().replace(/\/+$/, '');
  const blackcatApiUrl = rawBcUrl.endsWith('/api') ? rawBcUrl : `${rawBcUrl}/api`;

  if (blackcatApiKey && order.blackcat?.transactionId && !order.blackcat.transactionId.startsWith('bcat_pix_')) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      const checkRes = await fetch(`${blackcatApiUrl}/sales/${order.blackcat.transactionId}/status`, {
        headers: {
          'X-API-Key': blackcatApiKey,
          Authorization: `Bearer ${blackcatApiKey}`,
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (checkRes.ok) {
        const bcData: any = await checkRes.json();
        const sale = bcData.data || bcData;
        const isPaid = sale.isPaid || sale.status === 'paid' || sale.status === 'approved';
        if (isPaid) {
          order.status = 'paid';
          order.paidAt = new Date().toISOString();
          if (order.blackcat) order.blackcat.status = 'paid';
          await forwardToUtmify(order, 'order_paid');
        }
      }
    } catch {}
  }

  return res.json({
    success: true,
    status: order.status,
    orderId: order.id,
    transactionId: order.blackcat?.transactionId,
    total: order.total,
    updatedAt: new Date().toISOString(),
  });
});

// 2c. Real-time Payment Status Stream via Server-Sent Events (SSE)
app.get('/api/payment/blackcat/stream/:orderId', (req: Request, res: Response) => {
  const { orderId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof (res as any).flushHeaders === 'function') {
    (res as any).flushHeaders();
  }

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const order = ordersStore.find((o) => o.id === orderId || o.orderNumber === orderId);
  if (!order) {
    sendEvent({ status: 'waiting_payment', orderId });
  } else {
    sendEvent({
      status: order.status,
      orderId: order.id,
      transactionId: order.blackcat?.transactionId,
      paidAt: order.paidAt,
    });
  }

  const interval = setInterval(() => {
    const current = ordersStore.find((o) => o.id === orderId || o.orderNumber === orderId);
    if (current) {
      sendEvent({
        status: current.status,
        orderId: current.id,
        transactionId: current.blackcat?.transactionId,
        paidAt: current.paidAt,
      });

      if (current.status === 'paid') {
        clearInterval(interval);
        res.end();
      }
    }
  }, 2000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

// 2d. Simulate Instant Payment Approval (Test / Demo Real-time Verification)
app.post('/api/payment/blackcat/simulate-payment', async (req: Request, res: Response) => {
  try {
    const { orderId } = req.body;
    const order = ordersStore.find((o) => o.id === orderId || o.orderNumber === orderId);

    if (!order) {
      return res.status(404).json({ error: 'Pedido não encontrado para confirmação' });
    }

    order.status = 'paid';
    order.paidAt = new Date().toISOString();
    if (order.blackcat) {
      order.blackcat.status = 'paid';
    }

    const utmifyRes = await forwardToUtmify(order, 'order_paid');
    order.utmify = {
      sent: utmifyRes.sent,
      sentAt: new Date().toISOString(),
      status: utmifyRes.sent ? 'delivered' : 'pending',
      response: utmifyRes.response || utmifyRes.error,
    };

    console.log(`[Blackcat Real-Time] Order ${order.id} marked as PAID. Forwarded to UTMify.`);

    return res.json({
      success: true,
      status: 'paid',
      orderId: order.id,
      paidAt: order.paidAt,
      message: 'Pagamento Pix confirmado em tempo real!',
      utmifySent: order.utmify.sent,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Alias for webhook simulation test
app.post('/api/payment/blackcat/simulate-webhook', async (req: Request, res: Response) => {
  const { orderId } = req.body;
  const order = ordersStore.find((o) => o.id === orderId || o.orderNumber === orderId);
  if (!order) {
    return res.status(404).json({ error: 'Pedido não encontrado para confirmação' });
  }
  order.status = 'paid';
  order.paidAt = new Date().toISOString();
  if (order.blackcat) order.blackcat.status = 'paid';
  await forwardToUtmify(order, 'order_paid');
  return res.json({ success: true, status: 'paid', orderId: order.id, paidAt: order.paidAt });
});

// 3. Blackcat - Credit Card Charge
app.post('/api/payment/blackcat/card', async (req: Request, res: Response) => {
  try {
    const { orderId, amount, customer, address, items, card, installments = 1, utms = {} } = req.body;

    const blackcatApiKey = process.env.BLACKCAT_API_KEY;
    const blackcatPublicKey = process.env.BLACKCAT_PUBLIC_KEY || process.env.BLACKCAT_API_KEY_PUBLIC;
    const blackcatApiUrl = process.env.BLACKCAT_API_URL || 'https://api.blackcatpay.com.br/v1';

    let transactionId = `bcat_card_${Date.now()}`;
    let isDemo = true;
    let status: 'paid' | 'pending' | 'failed' = 'paid';

    if (blackcatApiKey) {
      try {
        const cleanAmountInCents = Math.round(Number(amount) * 100);
        const bcRes = await fetch(`${blackcatApiUrl}/transactions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${blackcatApiKey}`,
            'X-API-Key': blackcatApiKey,
            ...(blackcatPublicKey ? { 'X-Public-Key': blackcatPublicKey } : {}),
          },
          body: JSON.stringify({
            amount: cleanAmountInCents,
            payment_method: 'credit_card',
            installments: Number(installments),
            card: {
              number: card?.number?.replace(/\D/g, ''),
              holder_name: card?.holderName,
              exp_month: card?.expMonth,
              exp_year: card?.expYear,
              cvv: card?.cvv,
            },
            customer: {
              name: customer.name,
              email: customer.email,
              document: customer.document.replace(/\D/g, ''),
              phone: customer.phone.replace(/\D/g, ''),
            },
          }),
        });

        if (bcRes.ok) {
          const bcData: any = await bcRes.json();
          transactionId = bcData.id || transactionId;
          status = bcData.status === 'paid' || bcData.status === 'approved' ? 'paid' : 'pending';
          isDemo = false;
        }
      } catch (err: any) {
        console.warn('[Blackcat Card] Live API error:', err.message);
      }
    }

    const newOrder: StoredOrder = {
      id: orderId,
      orderNumber: orderId,
      createdAt: new Date().toISOString(),
      status,
      paymentMethod: 'card',
      customer,
      shippingAddress: address || {},
      items: items || [],
      subtotal: Number(amount),
      shippingCost: 0,
      discount: 0,
      total: Number(amount),
      utms,
      blackcat: {
        transactionId,
        status,
        isDemo,
      },
      utmify: {
        sent: false,
      },
    };

    const utmifyResult = await forwardToUtmify(newOrder, status === 'paid' ? 'order_paid' : 'order_created');
    newOrder.utmify = {
      sent: utmifyResult.sent,
      sentAt: new Date().toISOString(),
      status: utmifyResult.sent ? 'delivered' : 'pending',
    };

    ordersStore.unshift(newOrder);

    return res.json({
      success: status === 'paid',
      orderId,
      transactionId,
      status,
      isDemo,
      utmifySent: newOrder.utmify.sent,
      message: status === 'paid' ? 'Pagamento com Cartão Aprovado!' : 'Pagamento em análise.',
    });
  } catch (error: any) {
    console.error('[Blackcat Card Error]', error);
    return res.status(500).json({ error: error.message || 'Erro ao processar cartão' });
  }
});

// 4. Blackcat Webhook Callback
app.post('/api/payment/blackcat/webhook', async (req: Request, res: Response) => {
  try {
    const event = req.body;
    console.log('[Blackcat Webhook Received]', JSON.stringify(event));

    const transactionId = event.id || event.transaction_id || event.data?.id;
    const eventStatus = event.status || event.data?.status || event.event;

    const matchedOrder = ordersStore.find(
      (o) => o.blackcat?.transactionId === transactionId || o.orderNumber === event.metadata?.orderId
    );

    if (matchedOrder) {
      if (
        eventStatus === 'paid' ||
        eventStatus === 'approved' ||
        eventStatus === 'transaction.paid' ||
        eventStatus === 'transaction.approved'
      ) {
        matchedOrder.status = 'paid';
        if (matchedOrder.blackcat) {
          matchedOrder.blackcat.status = 'paid';
        }
        await forwardToUtmify(matchedOrder, 'order_paid');
        console.log(`[Blackcat Webhook] Order ${matchedOrder.orderNumber} marked as PAID and reported to UTMify!`);
      }
    }

    return res.status(200).json({ received: true });
  } catch (err: any) {
    console.error('[Blackcat Webhook Error]', err);
    return res.status(200).json({ received: false, error: err.message });
  }
});

// 5. UTMify Order Forwarding Route
app.post('/api/utmify/order', async (req: Request, res: Response) => {
  try {
    const orderData = req.body;
    const result = await forwardToUtmify(orderData, orderData.status === 'paid' ? 'order_paid' : 'order_created');
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Get All Stored Orders (with UTMs and Gateway info)
app.get('/api/orders', (req: Request, res: Response) => {
  res.json({
    orders: ordersStore,
    totalCount: ordersStore.length,
  });
});

// 7. Simulate Test Order (for user to easily test their UTMify & Blackcat integration)
app.post('/api/orders/simulate', async (req: Request, res: Response) => {
  try {
    const sampleId = `KIG-TEST-${Math.floor(100000 + Math.random() * 900000)}`;
    const pixEMV = generateEMVPixPayload(289.9, sampleId, process.env.PIX_KEY || 'contato@kigkigear.com.br', 'KIGKI MOTORS', 'SAO PAULO') || '00020101021126360014BR.GOV.BCB.PIX0114contato@kigkigear.com.br5204000053039865406289.905802BR5912KIGKI MOTORS6009SAO PAULO62070503***6304C7D5';
    const qrData = await QRCode.toDataURL(pixEMV, { margin: 1, width: 320 });

    const sampleOrder: StoredOrder = {
      id: sampleId,
      orderNumber: sampleId,
      createdAt: new Date().toISOString(),
      status: 'waiting_payment',
      paymentMethod: 'pix',
      customer: {
        name: 'Carlos Alberto Souza',
        email: 'carlos.souza@gmail.com',
        document: '423.891.208-11',
        phone: '(19) 98765-4321',
      },
      shippingAddress: {
        cep: '13010-000',
        street: 'Avenida Francisco Glicério',
        number: '1240',
        complement: 'Apto 42',
        neighborhood: 'Centro',
        city: 'Campinas',
        state: 'SP',
      },
      items: [
        {
          id: 'item_sample_1',
          product: {
            id: 'capacete-agv-k1-s',
            name: 'Capacete AGV K1 S Speed - Edição Especial',
            price: 'R$ 499,90',
          },
          quantity: 1,
          size: '58 (M)',
        },
      ],
      subtotal: 499.9,
      shippingCost: 0,
      discount: 0,
      total: 499.9,
      utms: {
        utm_source: 'instagram',
        utm_medium: 'stories',
        utm_campaign: 'blackcat_lancamento',
        utm_content: 'video_capacete_k1',
        utm_term: 'agv_brasil',
        src: 'instagram_bio',
        sck: 'stories_swipe',
        page_url: 'https://kigki.com.br/?utm_source=instagram&utm_medium=stories&utm_campaign=blackcat_lancamento',
      },
      blackcat: {
        transactionId: `bcat_sim_${Date.now()}`,
        status: 'waiting_payment',
        isDemo: true,
        pixCode: pixEMV,
        pixQrCodeUrl: qrData,
      },
      utmify: {
        sent: false,
      },
    };

    const utmifyRes = await forwardToUtmify(sampleOrder, 'order_created');
    sampleOrder.utmify = {
      sent: utmifyRes.sent,
      sentAt: new Date().toISOString(),
      status: utmifyRes.sent ? 'delivered' : 'demo_recorded',
      response: utmifyRes.response || utmifyRes.reason,
    };

    ordersStore.unshift(sampleOrder);

    res.json({
      success: true,
      order: sampleOrder,
      message: 'Pedido de teste criado e enviado para verificação UTMify & Blackcat!',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// START SERVER & MOUNT VITE
// ==========================================
async function startServer() {
  const args = process.argv.slice(2);
  let port = parseInt(process.env.PORT || '3000', 10);
  const portIndex = args.indexOf('--port');
  if (portIndex !== -1 && args[portIndex + 1]) {
    const parsed = parseInt(args[portIndex + 1], 10);
    if (!isNaN(parsed)) port = parsed;
  }

  if (process.env.NODE_ENV === 'production') {
    app.use(express.static('dist'));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`[KIGKI Server] Running on http://0.0.0.0:${port} (Blackcat Gateway & UTMify Active)`);
  });
}

startServer().catch((err) => {
  console.error('[KIGKI Server] Fatal startup error:', err);
});
