//  ОБЩИЙ МОДУЛЬ ШИФРОВАНИЯ СЕКРЕТОВ API-КЛЮЧЕЙ (AES-256-GCM).
//  Формат хранения: "iv:tag:data" в hex. Ключ — ENCRYPTION_KEY
//  (64 hex-символа = 32 байта).
//
//  Используется и серверными функциями (api/keys/*), и торговым
//  воркером — единый источник, чтобы форматы не разошлись.
//  Префикс «_» — Vercel не превращает файл в эндпоинт.
const crypto = require('crypto');

// Шифруем секрет. Нельзя хешировать — боту нужен оригинал для подписи запросов.
function encrypt(text) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const iv  = crypto.randomBytes(12); // 96-битный IV для GCM

  const cipher    = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag   = cipher.getAuthTag();

  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

// Расшифровываем секрет обратно.
function decrypt(encryptedText) {
  const [ivHex, tagHex, dataHex] = encryptedText.split(':');
  const key       = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const iv        = Buffer.from(ivHex,  'hex');
  const authTag   = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(dataHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
