const { createClient } = require('@supabase/supabase-js');
const { authUser } = require('../_auth');
const { isUuid } = require('../_validation');
const { applyCors } = require('../_cors');
const { loadKeyCreds, signedRequest } = require('../_exchange'); // единый клиент биржи (подпись + расшифровка ключа)

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  applyCors(res, 'GET');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  // Проверяем JWT
  const userId = authUser(req, res);
  if (!userId) return;

  const keyId = req.query.keyId;
  if (!isUuid(keyId)) {
    return res.status(400).json({ error: 'Некорректный идентификатор ключа' });
  }

  // Ключ пользователя + расшифровка секрета (проверка владения внутри)
  const creds = await loadKeyCreds(supabase, keyId, userId);
  if (!creds) {
    return res.status(404).json({ error: 'Ключ не найден' });
  }

  // Баланс спота: get_balance (include_null — монеты даже с нулём)
  try {
    const result = await signedRequest(
      'get_balance', { category: 'spot', include_null: true }, creds.apiKey, creds.secret);
    const balances  = Array.isArray(result) ? result : [];
    const usdtItem  = balances.find(b => b.coin_name === 'USDT');
    const citroItem = balances.find(b => b.coin_name === 'CITRO');
    return res.status(200).json({
      usdt:  usdtItem  ? parseFloat(usdtItem.available)  : 0,
      citro: citroItem ? parseFloat(citroItem.available) : 0
    });
  } catch {
    return res.status(502).json({ error: 'Не удалось связаться с биржей' });
  }
};
