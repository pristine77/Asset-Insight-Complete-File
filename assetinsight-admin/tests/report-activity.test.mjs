import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ACTIVITY_LABELS, activityEventLabel, activityOutcomeLabel, activityQuery, activityReceiptNote, activityRemoval, activityIdValid, backupReasonLabel, isBackupActivity, isUploadTransferActivity, uploadReasonLabel, logoLabel, parseActivityPage, parseActivityDetail, parseActivityLotPage } from '../lib/reportActivity.ts';
test('offline review opens have a distinct searchable label, never a submission label', () => {
 assert.equal(ACTIVITY_LABELS.draft_opened, 'Draft opened for review');
 assert.equal(new URLSearchParams(activityQuery(new URLSearchParams('action=draft_opened'))).get('action'), 'draft_opened');
});
const id='a'.repeat(64);
const row={id,owner:{id:'a'.repeat(24),name:'Example',email:'test@example.test'},source:'web',reportType:'asset',contract:'93530',latestCounts:{lots:1,photos:2,mainPhotos:1,extraPhotos:1},revision:2};
const backupEvent = (changes = {}) => ({
 id, action:'backup_interrupted', outcome:'completed', source:'android', authority:'device', actor:null, actorRole:'user',
 observedAt:'2026-10-06T09:00:00Z', receivedAt:'2026-10-06T11:00:00Z', sequence:3, appVersion:'1.0.2 (build 24)',
 data:{beforeCounts:null,afterCounts:null,backupPlanId:'backup-plan-1',backupRevision:4,backupReason:'unknown',backupCountAuthority:'server_verified',backupCounts:{totalFiles:225,verifiedFiles:51,totalPhotos:224,verifiedPhotos:50}},
 ...changes,
});
const eventPage = event => ({data:{items:[event],total:1,page:1,limit:25}});
test('backup actions are searchable independently of report submission', () => {
 for(const action of ['backup_started','backup_paused','backup_resumed','backup_interrupted','backup_completed']) {
  assert.equal(isBackupActivity(action),true);
  assert.equal(new URLSearchParams(activityQuery(new URLSearchParams({action}))).get('action'),action);
  assert.doesNotMatch(ACTIVITY_LABELS[action],/submit|upload accepted/i);
 }
 assert.equal(isBackupActivity('submission_requested'),false);
});
test('only an explicit pause attributes backup interruption to the user', () => {
 const event=backupEvent();
 assert.equal(activityEventLabel(event),'Backup interrupted');
 assert.equal(activityEventLabel({...event,action:'backup_paused'}),'Backup paused');
 assert.equal(activityEventLabel({...event,action:'backup_paused',data:{...event.data,backupReason:'user_pause'}}),'Backup paused by user');
 assert.equal(activityEventLabel({...event,action:'backup_paused',data:{...event.data,backupReason:'draft_deleted'}}),'Backup paused after draft deletion');
 assert.equal(backupReasonLabel('draft_deleted'),'Local draft deleted');
 assert.equal(parseActivityPage(eventPage({...event,action:'backup_paused',data:{...event.data,backupReason:'draft_deleted'}})).items[0].data.backupReason,'draft_deleted');
 assert.equal(backupReasonLabel('unknown'),'Cause not recorded');
 assert.equal(backupReasonLabel(),'Cause not recorded');
 assert.equal(backupReasonLabel('network_unavailable'),'Network unavailable');
 assert.equal(backupReasonLabel('system_interruption'),'System interruption');
 assert.equal(backupReasonLabel('authentication_required'),'Sign-in required');
 assert.throws(()=>parseActivityPage(eventPage({...event,data:{...event.data,backupReason:'user_pause'}})));
});
test('a recorded backup pause or interruption never displays as a completed backup', () => {
 for(const action of ['backup_started','backup_paused','backup_resumed','backup_interrupted'])assert.equal(activityOutcomeLabel(action,'completed'),'Recorded');
 assert.equal(activityOutcomeLabel('backup_completed','completed'),'completed');
 assert.equal(activityOutcomeLabel('backup_interrupted','failed'),'failed');
 assert.equal(activityOutcomeLabel('generation_completed','completed'),'completed');
});
test('backup receipt counts remain separate from captured counts and reject impossible evidence', () => {
 const event=backupEvent();
 const parsed=parseActivityPage(eventPage(event)).items[0];
 assert.equal(parsed.data.afterCounts,null);
 assert.equal(parsed.data.backupCounts.verifiedPhotos,50);
 assert.equal(parsed.authority,'device');
 assert.equal(parsed.data.backupCountAuthority,'server_verified');
 for(const counts of [{verifiedFiles:226},{verifiedPhotos:225},{verifiedFiles:49},{totalPhotos:226},{verifiedFiles:55},{verifiedPhotos:-1},{verifiedPhotos:'50'},{totalFiles:undefined}]) {
  assert.throws(()=>parseActivityPage(eventPage({...event,data:{...event.data,backupCounts:{...event.data.backupCounts,...counts}}})));
 }
 for(const data of [{backupReason:'force_stopped_by_user'},{backupCountAuthority:'device_reported'},{backupRevision:-1},{backupPlanId:'x'.repeat(161)}]) {
  assert.throws(()=>parseActivityPage(eventPage({...event,data:{...event.data,...data}})));
 }
});
test('completed backup requires server verification of every file and photo', () => {
 const event=backupEvent({action:'backup_completed',authority:'server'});
 assert.throws(()=>parseActivityPage(eventPage(event)));
 const completed={...event,data:{...event.data,backupReason:null,backupCounts:{totalFiles:225,verifiedFiles:225,totalPhotos:224,verifiedPhotos:224}}};
 assert.equal(parseActivityPage(eventPage(completed)).items[0].action,'backup_completed');
 assert.throws(()=>parseActivityPage(eventPage({...completed,authority:'device'})));
 assert.throws(()=>parseActivityPage(eventPage({...completed,data:{...completed.data,backupCountAuthority:undefined}})));
});
test('delayed device receipt explains timing without identifying a cause or treating clocks as authoritative', () => {
 const event=backupEvent();
 assert.match(activityReceiptNote(event),/does not identify why an upload or backup stopped/);
 assert.match(activityReceiptNote(event),/device clock may also differ/);
 assert.equal(activityReceiptNote({...event,authority:'server'}),null);
 assert.equal(activityReceiptNote({...event,observedAt:null}),null);
 assert.equal(activityReceiptNote({...event,observedAt:'invalid'}),null);
 assert.equal(activityReceiptNote({...event,observedAt:event.receivedAt}),null);
 assert.equal(activityReceiptNote({...event,observedAt:'2026-10-07T11:00:00Z'}),null);
});
test('last received native version is optional, bounded and labelled without inventing old versions',()=>{
 const page=lastReportedApp=>({data:{items:[{...row,lastReportedApp}],total:1,page:1,limit:25}});
 const version={appVersion:'1.0.1 (build 73)',source:'android',receivedAt:'2026-10-02T12:00:00Z'};
 assert.deepEqual(parseActivityPage(page(version)).items[0].lastReportedApp,version);
 assert.equal(parseActivityPage(page(null)).items[0].lastReportedApp,null);
 for(const change of [{appVersion:73},{appVersion:'x'.repeat(81)},{source:'guessed'},{receivedAt:'bad'}])assert.throws(()=>parseActivityPage(page({...version,...change})));
});
test('per-lot pages preserve numbers and unknown availability without inventing zeros', () => {
 const item={id,lotNumber:'X',position:4,photos:13,mainPhotos:10,extraPhotos:3,missingPhotos:null};
 const data={items:[item],total:43,page:1,limit:10,source:'report',asOf:null};
 assert.equal(parseActivityLotPage({data}).items[0].lotNumber,'X');
 assert.equal(parseActivityLotPage({data}).items[0].missingPhotos,null);
 for(const changes of [{photos:14},{extraPhotos:undefined},{mainPhotos:-1},{missingPhotos:14},{lotNumber:5}]) assert.throws(()=>parseActivityLotPage({data:{...data,items:[{...item,...changes}]}}));
 for(const changes of [{source:'unavailable'},{source:'guessed'},{asOf:'not-date'},{limit:101},{page:0}]) assert.throws(()=>parseActivityLotPage({data:{...data,...changes}}));
 assert.equal(parseActivityLotPage({data:{...data,source:'unavailable',total:0,items:[]}}).source,'unavailable');
 const route=readFileSync(new URL('../app/api/admin/report-activity/[id]/lots/route.ts',import.meta.url),'utf8');
 assert.match(route,/proxyJsonWithAdminAuth/); assert.match(route,/activityQuery/); assert.match(route,/no-store/);
});
test('unknown logo evidence is never shown as Off',()=>{assert.equal(logoLabel(null),'Not recorded');assert.equal(logoLabel(),'Not recorded');assert.equal(logoLabel(false),'Off');assert.equal(logoLabel(true),'On');});
test('bounded search, filters and identities',()=>{
 assert.equal(activityIdValid(id),true);assert.equal(activityIdValid('a'.repeat(24)),false);
 const query=new URLSearchParams(activityQuery(new URLSearchParams('search=93530%20%26%20B&action=preview_saved&role=superadmin')));
 assert.equal(query.get('search'),'93530 & B');assert.equal(query.has('role'),false);
 for(const q of ['page=0','limit=101','page=1&page=2','reportType=salvage','source=forged','from=2026-02-30','from=2026-09-19&to=2026-09-18'])assert.throws(()=>activityQuery(new URLSearchParams(q)));
});
test('removal accepts only reviewed revisions',()=>{assert.deepEqual(activityRemoval({revision:2}),{revision:2});for(const b of [{},{revision:-1},{revision:'2'},{revision:2,owner:'forged'}])assert.throws(()=>activityRemoval(b));});
test('malformed counts do not become zero and baselines keep unknown counts',()=>{
 const page=item=>({data:{items:[item],total:1,page:1,limit:25}});
 assert.equal(parseActivityPage(page({...row,latestCounts:null})).items[0].latestCounts,null);
 for(const counts of [{lots:1,photos:5,mainPhotos:1,extraPhotos:1},{lots:1,photos:0,mainPhotos:undefined,extraPhotos:0}])assert.throws(()=>parseActivityPage(page({...row,latestCounts:counts})));
});
test('preview links must remain local, exact and permission checked',()=>{
 const detail={...row,canViewValues:true,canOpenPreview:true,canRemove:true,reportExists:true,previewPath:'/preview-reports'};
 assert.equal(parseActivityDetail({data:detail}).previewPath,'/preview-reports');
 assert.equal(parseActivityDetail({data:{...detail,previewPath:'/reports/'+'b'.repeat(24)+'/data'}}).canOpenPreview,true);
 for(const path of ['https://example.test','//example.test','/reports/../data'])assert.throws(()=>parseActivityDetail({data:{...detail,previewPath:path}}));
});
test('admin BFF preserves auth boundary and guarded removal',()=>{
 const route=readFileSync(new URL('../app/api/admin/report-activity/[id]/route.ts',import.meta.url),'utf8');
 assert.match(route,/proxyJsonWithAdminAuth/);assert.match(route,/readPreviewMutationJson\(request, 1024\)/);assert.match(route,/activityRemoval/);
 const legacy=readFileSync(new URL('../app/offline-captures/page.tsx',import.meta.url),'utf8');assert.match(legacy,/report-activity\?tab=captures/);
});

const transferEvent = (changes = {}) => ({
 id,action:'upload_interrupted',outcome:'completed',source:'android',authority:'device',actor:null,actorRole:'user',
 observedAt:'2026-10-08T08:00:00Z',receivedAt:'2026-10-08T09:00:00Z',sequence:4,appVersion:'1.0.4 (build 29)',
 data:{beforeCounts:null,afterCounts:null,uploadSessionId:'b'.repeat(24),uploadReason:'unknown',uploadCountAuthority:'server_verified',uploadCounts:{totalFiles:974,verifiedFiles:843}},...changes,
});
test('background transfer observations have distinct searchable labels, not completed reports',()=>{
 for(const action of ['upload_queued','upload_paused','upload_resumed','upload_interrupted','upload_failed']) {
  assert.equal(isUploadTransferActivity(action),true);
  assert.equal(new URLSearchParams(activityQuery(new URLSearchParams({action}))).get('action'),action);
  assert.equal(activityOutcomeLabel(action,'completed'),'Recorded');
  assert.doesNotMatch(ACTIVITY_LABELS[action],/report accepted|deleted|report ready/i);
 }
 assert.equal(isUploadTransferActivity('upload_accepted'),false);
 assert.equal(activityOutcomeLabel('upload_accepted','completed'),'completed');
 assert.equal(activityOutcomeLabel('upload_failed','failed'),'failed');
});
test('only explicit pause evidence attributes a background upload stop to the user',()=>{
 const event=transferEvent();
 assert.equal(activityEventLabel(event),'Upload interrupted');
 assert.equal(activityEventLabel({...event,action:'upload_paused'}),'Upload paused');
 assert.equal(activityEventLabel({...event,action:'upload_paused',data:{...event.data,uploadReason:'user_pause'}}),'Upload paused by user');
 assert.equal(uploadReasonLabel('unknown'),'Cause not recorded');
 assert.equal(uploadReasonLabel('system_stop'),'Android stopped or deferred the transfer');
 assert.equal(uploadReasonLabel('network_unavailable'),'Network unavailable');
 assert.equal(uploadReasonLabel('authentication_required'),'Sign-in required');
 assert.throws(()=>parseActivityPage(eventPage({...event,data:{...event.data,uploadReason:'user_pause'}})));
 assert.match(activityReceiptNote(event),/delay does not identify why/);
});
test('transfer verification counts stay separate from captures and reject invalid receipts',()=>{
 const event=transferEvent();
 const parsed=parseActivityPage(eventPage(event)).items[0];
 assert.equal(parsed.data.afterCounts,null);
 assert.equal(parsed.data.uploadCounts.verifiedFiles,843);
 for(const uploadCounts of [{totalFiles:974,verifiedFiles:975},{totalFiles:974,verifiedFiles:-1},{totalFiles:974,verifiedFiles:'843'},{totalFiles:-1,verifiedFiles:0}]) {
  assert.throws(()=>parseActivityPage(eventPage({...event,data:{...event.data,uploadCounts}})));
 }
 for(const extra of [{uploadReason:'user_deleted'},{uploadSessionId:'../reports'},{uploadCountAuthority:'device_reported'}]) {
  assert.throws(()=>parseActivityPage(eventPage({...event,data:{...event.data,...extra}})));
 }
 assert.equal(parseActivityPage(eventPage({...event,data:{...event.data,uploadCounts:null,uploadCountAuthority:undefined}})).items[0].data.uploadCounts,null);
});
