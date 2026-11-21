import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

test('Android app: asset links, package name and site agree', () => {
  const links = JSON.parse(read('apps/web/public/.well-known/assetlinks.json'));
  const gradle = read('apps/android/app/build.gradle');
  const strings = read('apps/android/app/src/main/res/values/strings.xml');
  const applicationId = gradle.match(/applicationId '([^']+)'/)?.[1];
  assert.ok(applicationId, 'applicationId in app/build.gradle');
  assert.equal(links.length, 1);
  assert.deepEqual(links[0].relation, ['delegate_permission/common.handle_all_urls']);
  assert.equal(links[0].target.namespace, 'android_app');
  assert.equal(links[0].target.package_name, applicationId);
  for (const fp of links[0].target.sha256_cert_fingerprints) assert.match(fp, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  // The app opens the site that serves the asset links: the same host everywhere.
  const host = strings.match(/name="app_host"[^>]*>([^<]+)</)?.[1];
  const url = strings.match(/name="app_url"[^>]*>([^<]+)</)?.[1];
  assert.equal(url, `https://${host}/`);
  assert.ok(strings.includes(`\\"site\\": \\"https://${host}\\"`), 'asset_statements names the same site');
  assert.ok(read('README.md').includes(`https://${host}`), 'README names the site');
});
