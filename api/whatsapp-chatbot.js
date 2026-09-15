const getQueryValue = (value) => Array.isArray(value) ? value[0] : value;

export function verifyWhatsAppWebhook(query, verifyToken = process.env.WHATSAPP_VERIFY_TOKEN) {
  const mode = getQueryValue(query?.['hub.mode']);
  const token = getQueryValue(query?.['hub.verify_token']);
  const challenge = getQueryValue(query?.['hub.challenge']);

  if (mode !== 'subscribe' || !verifyToken || token !== verifyToken || challenge === undefined) {
    return null;
  }

  return String(challenge);
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const challenge = verifyWhatsAppWebhook(req.query);
    return challenge === null ? res.status(403).send('Forbidden') : res.status(200).send(challenge);
  }

  if (req.method === 'POST') {
    if (req.body?.object && req.body.object !== 'whatsapp_business_account') {
      return res.status(400).json({ success: false });
    }

    return res.status(200).send('EVENT_RECEIVED');
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ success: false, message: 'Método no permitido' });
}