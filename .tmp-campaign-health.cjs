const { Client } = require('pg');
const fs = require('fs');
const envText = fs.readFileSync('.env', 'utf8');
const line = envText.split(/\r?\n/).find((s) => s.startsWith('DATABASE_URL='));
const connectionString = line ? line.slice('DATABASE_URL='.length) : '';
const client = new Client({ connectionString });
(async () => {
  await client.connect();
  const checks = {
    campaign: `select c.slug, c.status, c.published_version_id, v.id as version_id, v.status as version_status, v.privacy_notice_version, v.privacy_notice_url from recall_campaigns c left join campaign_versions v on v.id = c.published_version_id where c.slug = 'music-lollipop-demo-2026'`,
    localization: `select locale, title from campaign_localizations where campaign_version_id = (select published_version_id from recall_campaigns where slug = 'music-lollipop-demo-2026') order by locale`,
    products: `select count(*)::int as count from campaign_products where campaign_version_id = (select published_version_id from recall_campaigns where slug = 'music-lollipop-demo-2026')`,
    lots: `select count(*)::int as count from campaign_product_lots where campaign_product_id in (select id from campaign_products where campaign_version_id = (select published_version_id from recall_campaigns where slug = 'music-lollipop-demo-2026'))`,
    remedies: `select count(*)::int as count from campaign_remedy_options where campaign_version_id = (select published_version_id from recall_campaigns where slug = 'music-lollipop-demo-2026')`,
    evidence: `select count(*)::int as count from campaign_evidence_requirements where campaign_version_id = (select published_version_id from recall_campaigns where slug = 'music-lollipop-demo-2026')`
  };
  for (const [label, sql] of Object.entries(checks)) {
    const res = await client.query(sql);
    console.log(`--- ${label} ---`);
    console.log(JSON.stringify(res.rows, null, 2));
  }
  await client.end();
})().catch(async (error) => {
  console.error(error);
  try { await client.end(); } catch {}
  process.exit(1);
});
