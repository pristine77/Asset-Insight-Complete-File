import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseYouTubeStatus, parseYouTubeAuthorization, parseYouTubeCallback, youtubeConnectBody, youtubeCompleteBody, youtubeDisconnectBody, youtubeEraseBody, finishYouTubeConnection, youtubeConnectionFailure } from '../lib/youtube.ts';
import { readPreviewMutationJson } from '../lib/previewResubmitRequest.ts';
import { parseYouTubeVideoPage, youtubeVideoQuery, youtubeVideoRetryBody, youtubeVideoFailure, youtubeVideoStatusLabel, youtubeVideoStatusMessage } from '../lib/youtubeVideos.ts';

const state = 'a'.repeat(64);
const status = { configured: true, configurationIssue: null, connected: true, needsReconnect: false, revision: 1, channel: { id: 'UC' + 'a'.repeat(22), title: 'Example channel', url: 'https://malicious.example' }, connectedAt: '2026-09-28T12:00:00Z', privacyStatus: 'public', accessToken: 'never-browser' };
const response = (body, code = 200) => new Response(JSON.stringify(body), { status: code });
test('completion first refreshes the session through a read, then exchanges the code once', async () => {
  const calls = [];
  const result = await finishYouTubeConnection({ code: 'fixture-code', state }, async (url, init) => {
    calls.push({ url, init });
    return response(status);
  });
  assert.equal(result.connected, true);
  assert.deepEqual(calls.map(c => c.url), ['/api/admin/youtube/status', '/api/admin/youtube/complete']);
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[1].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].init.body), { code: 'fixture-code', state });
  assert.equal('accessToken' in result, false);
});
test('failed or malformed authentication preflight never consumes the code', async () => {
  for (const fail of [() => response({}, 401), () => response({}, 403), () => response({}), () => { throw new Error('secret transport detail'); }]) {
    const calls = [];
    await assert.rejects(finishYouTubeConnection({ code: 'fixture-code', state }, async url => { calls.push(url); return fail(); }), error => !error.message.includes('secret transport detail'));
    assert.deepEqual(calls, ['/api/admin/youtube/status']);
  }
});
test('leaving the callback during preflight prevents a delayed code exchange', async () => {
  const controller = new AbortController();
  const calls = [];
  await assert.rejects(finishYouTubeConnection({ code: 'fixture-code', state }, async url => {
    calls.push(url); controller.abort(); return response(status);
  }, controller.signal), /interrupted/);
  assert.deepEqual(calls, ['/api/admin/youtube/status']);
});
test('known connection errors retain their safe code and correction, not provider details', () => {
  for (const code of ['YOUTUBE_STATE_INVALID', 'YOUTUBE_SCOPE_REQUIRED', 'YOUTUBE_CHANNEL_REQUIRED', 'YOUTUBE_CONNECTION_CHANGED', 'YOUTUBE_AUTHORIZATION_INCOMPLETE']) {
    const issue = youtubeConnectionFailure({ code, message: 'secret-code-token', access_token: 'secret-token' }, 409);
    assert.equal(issue.code, code);
    assert.match(issue.message, new RegExp(code));
    assert.doesNotMatch(JSON.stringify(issue), /secret/);
  }
  for (const value of [null, {}, { code: 'toString', message: 'secret' }, { code: 'YOUTUBE_UNKNOWN_SECRET', message: 'secret' }]) {
    assert.equal(youtubeConnectionFailure(value, 502).code, undefined);
    assert.doesNotMatch(youtubeConnectionFailure(value, 502).message, /secret/i);
  }
});
test('failed, timed-out and invalid completion responses are never replayed or declared connected', async () => {
  for (const fail of [() => response({code:'YOUTUBE_STATE_INVALID'},409), () => response({},401), () => response({ ...status, needsReconnect: true }), () => response({ ...status, connected:false, channel:null }), () => response({}), () => { throw new DOMException('fixture-token','TimeoutError'); }]) {
    let count = 0;
    await assert.rejects(finishYouTubeConnection({ code: 'fixture-code', state }, async () => ++count === 1 ? response(status) : fail()), error => !error.message.includes('fixture-token'));
    assert.equal(count, 2);
  }
});
test('status projects only safe fields and a canonical channel URL', () => {
  const result = parseYouTubeStatus(status);
  assert.equal(result.channel.url, `https://www.youtube.com/channel/${status.channel.id}`);
  assert.equal('accessToken' in result, false);
  assert.equal(parseYouTubeStatus({ ...status, channel: { ...status.channel, title: 'x'.repeat(300) } }).channel.title.length, 300);
  assert.equal(parseYouTubeStatus({ ...status, connected: false, channel: null, revision: 0, connectedAt: null }).channel, null);
  assert.equal(result.canConnect, false);
  assert.equal(result.publicationMode, null);
  assert.equal(parseYouTubeStatus({ ...status, publicationMode: 'automatic_public' }).publicationMode, 'automatic_public');
  assert.equal(parseYouTubeStatus({ ...status, privacyStatus: 'private', canConnect: true }).canConnect, true);
  for (const bad of [{ revision: -1 }, { connected: 'true' }, { connected: false }, { channel: { id: 'evil', title: 'X' } }, { privacyStatus: 'unknown' }, { connectedAt: 'never' }, { canConnect: 'true' }, { publicationMode: 'reviewed' }, { publicationMode: {} }]) assert.throws(() => parseYouTubeStatus({ ...status, ...bad }));
});
test('mutations have strict keys, consent and revision checks', () => {
  assert.deepEqual(youtubeConnectBody({ policyConsent: true }), { policyConsent: true });
  assert.deepEqual(youtubeCompleteBody({ code: 'google-code', state }), { code: 'google-code', state });
  assert.deepEqual(youtubeDisconnectBody({ revision: 2 }), { revision: 2 });
  for (const bad of [{}, { policyConsent: false }, { publicationConsent: true }, { policyConsent: true, channel: 'injected' }]) assert.throws(() => youtubeConnectBody(bad));
  for (const bad of [{ code: 'x', state: 'short' }, { code: 'x\nsecret', state }, { code: 'x', state, accessToken: 'x' }, { code: 'x'.repeat(4097), state }]) assert.throws(() => youtubeCompleteBody(bad));
  for (const bad of [{ revision: 0 }, { revision: '1' }, { revision: 1, channel: 'x' }]) assert.throws(() => youtubeDisconnectBody(bad));
});
test('callbacks do not reflect provider errors and reject repeated parameters', () => {
  assert.deepEqual(parseYouTubeCallback(`?code=abc&state=${state}&scope=ignored`), { code: 'abc', state });
  for (const query of [`?code=a&code=b&state=${state}`, `?code=a&state=${state}&state=${state}`, '?error=secret-provider-detail', '?code=a']) assert.throws(() => parseYouTubeCallback(query), error => !error.message.includes('secret-provider-detail'));
});
test('authorization navigation only accepts Google and the exact current callback origin', () => {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('state', state); url.searchParams.set('response_type', 'code'); url.searchParams.set('redirect_uri', 'https://admin.example/youtube/callback');
  const value = { authorizationUrl: url.href, expiresAt: '2026-09-28T12:10:00Z' };
  assert.equal(parseYouTubeAuthorization(value, 'https://admin.example').authorizationUrl, url.href);
  for (const bad of [url.href.replace('accounts.google.com', 'evil.example'), url.href.replace('/v2/auth', '/wrong')]) assert.throws(() => parseYouTubeAuthorization({ ...value, authorizationUrl: bad }));
  assert.throws(() => parseYouTubeAuthorization(value, 'https://different.example'));
  url.searchParams.set('state', 'short'); assert.throws(() => parseYouTubeAuthorization({ ...value, authorizationUrl: url.href }));
});
test('cookie mutations require same-origin JSON and a streaming size bound', async () => {
  const request = (body, headers = {}) => new Request('https://admin.example/api/admin/youtube/connect', { method: 'POST', headers: { Origin: 'https://admin.example', 'content-type': 'application/json', ...headers }, body });
  assert.deepEqual(await readPreviewMutationJson(request('{"policyConsent":true}'), 1024), { policyConsent: true });
  await assert.rejects(readPreviewMutationJson(request('{}', { Origin: 'https://evil.example' }), 1024), { status: 403 });
  await assert.rejects(readPreviewMutationJson(request('{}', { 'content-type': 'text/plain' }), 1024), { status: 415 });
  await assert.rejects(readPreviewMutationJson(request(JSON.stringify({ data: 'x'.repeat(2048) })), 1024), { status: 413 });
});
test('privacy actions require exact fresh revision and affirmative confirmation', () => {
  for (const revision of [0, 1, 20]) assert.deepEqual(youtubeEraseBody({ revision, confirm: true }), { revision, confirm: true });
  for (const bad of [{}, { revision: 1 }, { revision: -1, confirm: true }, { revision: '1', confirm: true }, { revision: 1, confirm: false }, { revision: 1, confirm: true, videos: 'delete' }]) assert.throws(() => youtubeEraseBody(bad));
});
test('data cleanup and Google revocation remain separate, safe status projections', () => {
  const value = { ...status, canConnect: false, dataCleanup: { status: 'completed', requestedAt: '2026-09-29T12:00:00Z', completedAt: '2026-09-29T12:01:00Z', reason: 'admin_request', providerBody: 'secret' }, revocation: { status: 'needs_attention', requestedAt: '2026-09-29T12:00:00Z', completedAt: null, token: 'secret' } };
  const parsed = parseYouTubeStatus(value);
  assert.equal(parsed.dataCleanup.status, 'completed'); assert.equal(parsed.revocation.status, 'needs_attention');
  assert.equal(parsed.canAcknowledgeRevocation, false);
  const manuallyConfirmedAt = '2026-09-29T12:03:00Z';
  const confirmed = parseYouTubeStatus({ ...value, canAcknowledgeRevocation: true, revocation: { status: 'manually_confirmed', manuallyConfirmedAt } });
  assert.equal(confirmed.revocation.status, 'manually_confirmed'); assert.equal(confirmed.revocation.manuallyConfirmedAt, manuallyConfirmedAt);
  assert.equal('providerBody' in parsed.dataCleanup, false); assert.equal('token' in parsed.revocation, false);
  for (const patch of [{ dataCleanup: { status: 'unknown' } }, { revocation: { status: 'failed', completedAt: null } }, { dataCleanup: { status: 'pending', requestedAt: 'never' } }]) assert.throws(() => parseYouTubeStatus({ ...value, ...patch }));
});
test('automatic publication DTO suppresses legacy review flags and preserves exact safe metadata', () => {
  const video = { id: 'a'.repeat(64), reportId: 'b'.repeat(24), reportType: 'lotListing', lotNumber: '12', status: 'pending_review', url: null, lastError: null, updatedAt: '2026-09-29T12:00:00Z', retryEligible: false, title: 'Lot 12', description: 'Exact text', privacyStatus: 'private', reviewRequired: true, reviewEligible: true, sourceUrl: 'secret' };
  const page = value => parseYouTubeVideoPage({ items: [value], page: 1, total: 1, totalPages: 1 }).items[0];
  assert.equal(page(video).reviewEligible, false); assert.equal(page(video).reviewRequired, false); assert.equal('sourceUrl' in page(video), false);
  assert.equal(page(video).title, video.title); assert.equal(page(video).description, video.description);
  assert.equal(page(video).publicationMode, null); assert.equal(page(video).targetPrivacyStatus, null);
  const automatic = page({ ...video, status: 'queued', publicationMode: 'automatic_public', targetPrivacyStatus: 'public' });
  assert.equal(automatic.publicationMode, 'automatic_public'); assert.equal(automatic.targetPrivacyStatus, 'public');
  assert.equal(automatic.status, 'queued'); assert.equal(automatic.url, null);
  const legacy = { ...video }; delete legacy.reviewEligible; delete legacy.reviewRequired;
  assert.equal(page(legacy).reviewEligible, false);
  assert.equal(page(legacy).metadataOmitted, false);
  assert.equal(page({ ...video, title: '', description: '', metadataOmitted: true }).reviewEligible, false);
  assert.throws(() => page({ ...video, metadataOmitted: true }));
  assert.throws(() => page({ ...video, metadataOmitted: 'yes' }));
  for (const status of ['pending_review', 'unlisted', 'data_removed']) assert.equal(page({ ...video, status }).status, status);
  const removed = page({ ...video, status: 'data_removed', reportType: null, reportId: null, privacyStatus: null });
  assert.equal(removed.reportId, null); assert.equal(removed.title, ''); assert.equal(removed.privacyStatus, null); assert.equal(removed.reviewEligible, false);
  assert.equal(page({ ...video, status: 'data_removed', updatedAt: null }).updatedAt, null);
  for (const patch of [{ reviewEligible: 'yes' }, { privacyStatus: 'everyone' }, { description: 'x'.repeat(10001) }, { title: {} }, { publicationMode: 'manual' }, { targetPrivacyStatus: 'private' }, { publicationMode: {} }]) assert.throws(() => page({ ...video, ...patch }));
});
test('retired review endpoint cannot mutate metadata and privacy actions retain explicit consent', () => {
  const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const route = source('../app/api/admin/youtube/videos/[id]/review/route.ts');
  assert.match(route, /YOUTUBE_REVIEW_REMOVED/); assert.match(route, /status: 410/);
  assert.match(route, /"Cache-Control": "no-store"/);
  assert.doesNotMatch(route, /proxyJsonWithAdminAuth|fetch\(|request\.json|youtubeVideoReviewBody/);
  for (const action of ['revoke', 'erase-data', 'acknowledge-revocation']) assert.match(source(`../app/api/admin/youtube/${action}/route.ts`), /youtubeProxy/);
  const settings = source('../app/components/youtube/YouTubeSettings.tsx');
  assert.match(settings, /policyConsent: true/); assert.doesNotMatch(settings, /publicationConsent: true/);
  assert.match(settings, /authorize automatic public publication/);
  assert.match(settings, /without a separate per-video review/);
  assert.match(settings, /www\.youtube\.com\/t\/terms/); assert.match(settings, /assetinsightvaluator\.com\/privacy/);
  assert.match(settings, /!eraseConfirmed/); assert.match(settings, /myaccount\.google\.com\/connections/);
  assert.match(settings, /fetch\("\/api\/admin\/youtube\/revoke"/);
  assert.match(settings, /!acknowledgeConfirmed/); assert.match(settings, /!status\.canAcknowledgeRevocation/);
  assert.match(settings, /not a Google-verified revocation response/);
});
test('YouTube guidance retains the original Excel layout without regeneration advice', () => {
  const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const settings = source('../app/components/youtube/YouTubeSettings.tsx');
  assert.match(settings, /Excel keeps its original column layout without a YouTube column/);
  for (const file of ['YouTubeSettings', 'YouTubeVideos']) {
    const text = source(`../app/components/youtube/${file}.tsx`);
    assert.doesNotMatch(text, /regenerate[^.]*Excel links|regenerate[^.]*YouTube links in Excel|link may appear in report Excel exports/i);
  }
});
test('publication guidance does not infer a private-only restriction from project verification', () => {
  const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const settings = source('../app/components/youtube/YouTubeSettings.tsx');
  assert.match(settings, /YouTube confirms publication/);
  assert.match(settings, /channel authorization, video processing and a confirmed visibility response/);
  assert.match(settings, /https:\/\/developers\.google\.com\/youtube\/v3\/docs\/videos\/insert/);
  for (const file of ['YouTubeSettings', 'YouTubeVideos']) {
    assert.doesNotMatch(source(`../app/components/youtube/${file}.tsx`), /unverified API projects|API compliance audit|Google eligibility/);
  }
});
test('route and UI boundaries preserve roles, single attempts and credential stripping', () => {
  const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.match(source('../lib/requireOperationalAdminPage.ts'), /\["admin", "superadmin"\]/);
  assert.match(source('../lib/youtubeProxy.ts'), /replayAfterRefresh: action === "status"/);
  assert.match(source('../lib/adminProxy.ts'), /init\.replayAfterRefresh === false/);
  assert.match(source('../app/youtube/page.tsx'), /requireOperationalAdminPage/);
  assert.match(source('../app/youtube/callback/page.tsx'), /requireOperationalAdminPage/);
  const callback = source('../app/components/youtube/YouTubeCallback.tsx');
  assert.match(callback, /history\.replaceState/); assert.match(callback, /credentials\.current = null/);
  assert.match(callback, /publish to Public automatically after report release/);
  assert.match(callback, /already in the queue may resume automatically/);
  assert.doesNotMatch(callback, /Future reviewed|does not upload or publish existing reports/);
  assert.doesNotMatch(callback, /localStorage|sessionStorage|console\./);
  assert.match(source('../app/components/common/AdminNavbarV2.tsx'), /href: "\/youtube"/);
  assert.match(source('../middleware.ts'), /renderUrl\.search = ""/);
});
test('video inventory is bounded, scoped and public links require a confirmed public status', () => {
  const video = { id: 'a'.repeat(64), reportId: 'b'.repeat(24), reportType: 'asset', lotNumber: '12A', status: 'public', url: 'https://www.youtube.com/watch?v=abcDEF123_-', lastError: null, updatedAt: '2026-09-28T12:00:00.000Z', retryEligible: false, sourceUrl: 'private-original' };
  const page = { items: [video], page: 1, total: 1, totalPages: 1 };
  assert.equal('sourceUrl' in parseYouTubeVideoPage(page).items[0], false);
  for (const patch of [{ status: 'private' }, { url: 'https://evil.example' }, { id: 'a'.repeat(24) }, { reportType: 'salvage' }, { updatedAt: 'bad' }]) assert.throws(() => parseYouTubeVideoPage({ ...page, items: [{ ...video, ...patch }] }));
  assert.throws(() => parseYouTubeVideoPage({ ...page, items: Array(21).fill(video) }));
  assert.equal(youtubeVideoQuery(new URLSearchParams('page=2')), 'page=2');
  for (const query of ['page=0', 'page=1&page=2', 'limit=100', 'reportId=abc']) assert.throws(() => youtubeVideoQuery(new URLSearchParams(query)));
  assert.deepEqual(youtubeVideoRetryBody({ updatedAt: video.updatedAt }), { updatedAt: video.updatedAt });
  assert.throws(() => youtubeVideoRetryBody({ updatedAt: video.updatedAt, privacyStatus: 'public' }));
});
test('upload retry and automatic retry timing are explicit server capabilities', () => {
  const video = { id: 'a'.repeat(64), reportId: 'b'.repeat(24), reportType: 'lotListing', lotNumber: '20', status: 'needs_attention', url: null, lastError: 'Saved upload stopped.', updatedAt: '2026-10-10T20:04:04.000Z', retryEligible: true, retryKind: 'upload', nextAttemptAt: null, reviewRequired: false };
  const parse = row => parseYouTubeVideoPage({ items: [row], page: 1, total: 1, totalPages: 1 }).items[0];
  assert.equal(parse(video).retryKind, 'upload');
  assert.equal(parse(video).nextAttemptAt, null);
  const scheduled = parse({ ...video, status: 'uploading', nextAttemptAt: '2026-10-10T20:30:00.000Z' });
  assert.equal(scheduled.status, 'uploading');
  assert.equal(scheduled.nextAttemptAt, '2026-10-10T20:30:00.000Z');
  for (const patch of [{ retryKind: 'new_upload' }, { retryKind: null }, { nextAttemptAt: 'later' }, { nextAttemptAt: '2026-10-10T20:30:00.000Z' }]) assert.throws(() => parse({ ...video, ...patch }));
  assert.equal(parse({ ...video, retryKind: undefined }).retryKind, 'publication');
  assert.equal(parse({ ...video, retryKind: undefined, retryEligible: false }).retryKind, null);
  const removed = parse({ ...video, status: 'data_removed', sessionCipher: 'secret', nextAttemptAt: '2026-10-10T20:30:00.000Z' });
  assert.equal(removed.retryKind, null); assert.equal(removed.nextAttemptAt, null); assert.equal(removed.retryEligible, false);
  assert.doesNotMatch(JSON.stringify(removed), /secret/);
});
test('video action failures explain known causes without provider bodies or raw status codes', () => {
  for (const code of ['YOUTUBE_REVIEW_REMOVED', 'YOUTUBE_RETRY_INVALID', 'YOUTUBE_VIDEO_NOT_FOUND', 'YOUTUBE_RETRY_UNAVAILABLE', 'YOUTUBE_RETRY_CHANGED', 'YOUTUBE_RECONCILIATION_REQUIRED', 'YOUTUBE_RETRY_UNCONFIRMED']) {
    const issue = youtubeVideoFailure({ code, message: 'secret provider URL', access_token: 'secret token' }, 409);
    assert.equal(issue.code, code); assert.doesNotMatch(issue.message, /secret|HTTP|409/);
  }
  assert.match(youtubeVideoFailure({}, 401).message, /session expired/);
  assert.match(youtubeVideoFailure({}, 403).message, /denied/);
  assert.match(youtubeVideoFailure({}, 404).message, /no longer available/);
  assert.match(youtubeVideoFailure({}, 409).message, /changed/);
  for (const code of ['unknown', 'constructor', 'toString', '__proto__']) {
    const issue = youtubeVideoFailure({ code, message: 'secret provider URL' }, 500);
    assert.equal(issue.code, undefined); assert.doesNotMatch(issue.message, /secret|HTTP|500/);
  }
});
test('automatic publication status never claims target visibility as confirmed', () => {
  const row = patch => parseYouTubeVideoPage({ items: [{ id: 'a'.repeat(64), reportId: 'b'.repeat(24), reportType: 'asset', lotNumber: '1', status: 'queued', url: null, lastError: null, updatedAt: '2026-10-18T12:00:00Z', retryEligible: false, privacyStatus: 'public', publicationMode: 'automatic_public', targetPrivacyStatus: 'public', ...patch }], page: 1, total: 1, totalPages: 1 }).items[0];
  for (const status of ['queued', 'pending_review']) {
    assert.equal(youtubeVideoStatusLabel(row({ status })), 'Queued for automatic publication');
    assert.match(youtubeVideoStatusMessage(row({ status })), /Report release, channel authorization and YouTube confirmation/);
  }
  for (const status of ['private', 'unlisted']) {
    const video = row({ status });
    assert.equal(youtubeVideoStatusLabel(video), status === 'private' ? 'Private' : 'Unlisted');
    assert.match(youtubeVideoStatusMessage(video), /not yet confirmed/);
    assert.equal(video.url, null);
  }
  assert.equal(youtubeVideoStatusLabel(row({ status: 'public' })), 'Public');
  assert.match(youtubeVideoStatusMessage(row({ status: 'public' })), /confirmed by YouTube/);
  assert.equal(youtubeVideoStatusMessage(row({ status: 'needs_attention', lastError: 'Reconnect the channel.' })), 'Reconnect the channel.');
  assert.equal(youtubeVideoStatusLabel(row({ status: 'uploading', nextAttemptAt: '2026-10-18T14:00:00Z' })), 'Waiting to resume');
});
test('retry BFF and review-free UI use safe errors without replaying requests', () => {
  const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  for (const action of ['retry-publication']) {
    const route = source(`../app/api/admin/youtube/videos/[id]/${action}/route.ts`);
    assert.match(route, /youtubeVideoFailure/); assert.match(route, /replayAfterRefresh: false/);
    assert.doesNotMatch(route, /message: (?:payload|body|result)\.message/);
  }
  const ui = source('../app/components/youtube/YouTubeVideos.tsx');
  assert.match(ui, /Resume upload/); assert.match(ui, /youtubeVideoStatusLabel/);
  assert.match(ui, /An automatic attempt is scheduled/); assert.match(ui, /youtubeVideoFailure\(await response.json\(\).catch\(\(\) => null\), response.status\)/);
  assert.match(ui, /JSON\.stringify\(\{ updatedAt: video.updatedAt \}\)/);
  assert.match(ui, /Refresh retrieves saved worker status/);
  assert.match(ui, /md: "minmax\(0,1fr\) max-content minmax\(0,1\.6fr\) auto"/);
  assert.doesNotMatch(ui, /110px minmax/);
  assert.doesNotMatch(ui, /result\.message|setInterval/);
  assert.doesNotMatch(ui, /YouTubeReviewDialog|submitReview|setReview|\/review`|Review required|Review video|Edit YouTube settings/);
  assert.match(ui, /no separate video review/);
});
