const { createHash, createHmac } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const decode = value => value.replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[entity]));
function field(xml, name) { return decode(xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] || ''); }
function parsePage(xml) {
  if (!xml.includes('<ListBucketResult')) throw Error('Invalid R2 storage response');
  const objects = Array.from(xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g), row => {
    const size = Number(field(row[1], 'Size'));
    if (!Number.isSafeInteger(size) || size < 0) throw Error('Invalid R2 object size');
    return { key: field(row[1], 'Key'), bytes: size, modified: field(row[1], 'LastModified') };
  });
  const truncated = field(xml, 'IsTruncated') === 'true';
  const next = field(xml, 'NextContinuationToken');
  if (truncated && !next) throw Error('Incomplete R2 storage listing');
  return { objects, truncated, next };
}
function signedRequest(config, token, now = new Date(), objectKey = null) {
  const host = `${config.account}.r2.cloudflarestorage.com`;
  const uri = '/' + encode(config.bucket) + (objectKey === null ? '' : '/' + objectKey.split('/').map(encode).join('/'));
  const params = objectKey === null ? [['list-type', '2'], ['max-keys', '1000']] : [];
  if (token) params.push(['continuation-token', token]);
  const query = params.sort((a,b) => a[0].localeCompare(b[0])).map(([k,v]) => `${encode(k)}=${encode(v)}`).join('&');
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = date.slice(0, 8), payload = hash('');
  const names = 'host;x-amz-content-sha256;x-amz-date';
  const canonical = ['GET', uri, query, `host:${host}\nx-amz-content-sha256:${payload}\nx-amz-date:${date}\n`, names, payload].join('\n');
  const scope = `${day}/auto/s3/aws4_request`;
  const key = hmac(hmac(hmac(hmac('AWS4' + config.secret, day), 'auto'), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).digest('hex');
  return { url: `https://${host}${uri}?${query}`, headers: {
    'x-amz-date': date, 'x-amz-content-sha256': payload,
    Authorization: `AWS4-HMAC-SHA256 Credential=${config.access}/${scope}, SignedHeaders=${names}, Signature=${signature}`
  }};
}
let cache, inFlight;
async function readUsage() {
  const config = { account: process.env.R2_ACCOUNT_ID, access: process.env.R2_ACCESS_KEY_ID,
    secret: process.env.R2_SECRET_ACCESS_KEY, bucket: process.env.R2_BUCKET };
  if (!Object.values(config).every(Boolean)) throw Error('R2 connection is not configured on the server');
  let token = '', bytes = 0, count = 0, largest = 0, lastModified = '', pages = 0;
  const categories = { videos: { bytes: 0, files: 0 }, images: { bytes: 0, files: 0 }, other: { bytes: 0, files: 0 } };
  const seen = new Set();
  do {
    const request = signedRequest(config, token);
    const response = await fetch(request.url, { headers: request.headers, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw Error(response.status === 403 ? 'R2 access denied. Check bucket read permissions.' : 'R2 storage could not be read');
    const page = parsePage(await response.text());
    for (const object of page.objects) {
      bytes += object.bytes; count++; largest = Math.max(largest, object.bytes);
      if (object.modified > lastModified) lastModified = object.modified;
      const type = /\.(mp4|mov|mkv|webm|m4v|ts|m3u8)$/i.test(object.key) ? 'videos' : /\.(png|jpe?g|webp|gif|svg|heic)$/i.test(object.key) ? 'images' : 'other';
      categories[type].bytes += object.bytes; categories[type].files++;
    }
    token = page.truncated ? page.next : '';
    if (token && seen.has(token)) throw Error('R2 listing repeated a page');
    seen.add(token);
    if (++pages > 10000) throw Error('R2 bucket listing is too large; use Cloudflare analytics');
  } while (token);
  const budget = Number(process.env.R2_STORAGE_BUDGET_GB);
  const budgetBytes = Number.isFinite(budget) && budget > 0 ? budget * 1e9 : null;
  return { bucket: config.bucket, bytes, files: count, largestBytes: largest, categories,
    lastModified: lastModified || null, updatedAt: new Date().toISOString(),
    budgetBytes, remainingBytes: budgetBytes === null ? null : Math.max(0, budgetBytes - bytes),
    capacity: 'Unlimited', scope: 'Configured bucket only; current stored objects. Billing and request usage are not included.' };
}
async function getUsage() {
  if (cache && Date.now() - cache.at < 300000) return cache.value;
  if (!inFlight) inFlight = readUsage().then(value => { cache = { at: Date.now(), value }; return value; }).finally(() => { inFlight = null; });
  return inFlight;
}
module.exports = { getUsage, parsePage, signedRequest, signedObjectRequest: (config, key) => signedRequest(config, "", new Date(), key) };
