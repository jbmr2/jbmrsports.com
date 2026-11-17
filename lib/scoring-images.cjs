'use strict';
function install(app, { load = () => require('./ott-feed-api.cjs').productionData(),
  read = (...args) => require('./mysql-scoring.cjs').readImage(...args) } = {}) {
  app.get('/api/scoring-images/:entity/:id/:hash', async (req, res) => {
    const { entity, id, hash } = req.params;
    if (!['players', 'teams', 'tournaments'].includes(entity) || !/^[1-9][0-9]{0,19}$/.test(id) || !/^[a-f0-9]{64}$/.test(hash)) return res.sendStatus(404);
    try {
      const data = await load();
      const source = require('./mysql-scoring.cjs').SOURCE;
      const row = data.scorers?.[source]?.tables?.[entity]?.[id];
      const url = entity === 'players' ? row?.photo_url : row?.logo_url;
      if (url !== `https://jbmrsports.com/api/scoring-images/${entity}/${id}/${hash}`) return res.sendStatus(404);
      const image = await read(entity, id, hash);
      if (!image || !['image/jpeg','image/png','image/webp','image/gif'].includes(image.mime_type) || !Buffer.isBuffer(image.image_bytes)) return res.sendStatus(404);
      res.set({ 'Content-Type': image.mime_type, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', ETag: `"${hash}"` });
      if (req.headers['if-none-match'] === `"${hash}"`) return res.status(304).end();
      return res.send(image.image_bytes);
    } catch { return res.sendStatus(503); }
  });
}
module.exports = { install };
