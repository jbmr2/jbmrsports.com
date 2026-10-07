function clipObjectKey(clip, config, publicBase = '') {
  const bucket = String(config.bucket || '').trim(), account = String(config.account || '').trim();
  const original = new URL(clip.url);
  const valid = key => typeof key === 'string' && key.length > 0 && !key.startsWith('/') && !key.split('/').some(p => p === '..' || p === '.') && !/[\x00-\x1f]/.test(key) && /\.(mp4|mov|m4v)$/i.test(key);
  const key = clip.object_key;
  if (valid(key) && ['r2', 'cloudflare_r2'].includes(clip.provider) && String(clip.bucket).trim() === bucket &&
      original.protocol === 'https:' && original.hostname === `${account}.r2.cloudflarestorage.com` &&
      decodeURIComponent(original.pathname) === `/${bucket}/${key}`) return key;
  if (publicBase) {
    const prefix = new URL(publicBase), root = prefix.pathname.replace(/\/$/, '') + '/';
    if (original.protocol === 'https:' && original.origin === prefix.origin && original.pathname.startsWith(root)) {
      const derived = decodeURIComponent(original.pathname.slice(root.length));
      if (valid(derived)) return derived;
    }
  }
  throw Error('Only original R2 video clips can be downloaded');
}
module.exports = {clipObjectKey};
