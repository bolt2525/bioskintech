import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Real HTTP handlers and lifecycle helpers; deterministic local DB/R2/SMTP
// adapters, no credentials, network, migrations or Worker activation.
const CLINIC='11111111-2222-4333-8444-555555555555';
const PERIOD='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const T=Date.parse('2026-08-01T00:00:00Z'), DAY=86400000;
let now=T, actor, clinic, periods, orders, notices, parts, schema, smtpFail, deliveries, photoRows, r2Metadata;
const statements=[];
mock.method(Date,'now',()=>now);
const url=path=>new URL(path,import.meta.url).href;
mock.module(url('../lib/admin-auth.js'),{namedExports:{authenticateRequest:async()=>actor}});
mock.module('nodemailer',{defaultExport:{createTransport:()=>({
  async sendMail(message) { deliveries.push(message); if(smtpFail) throw new Error('SMTP fictitious failure'); },
  close() {},
})}});
mock.module(url('../lib/r2-service.js'),{namedExports:{
  generateDownloadUrl:async key=>`https://example.invalid/${key}`,
  r2ObjectExists:async()=>true, putR2Object:async()=>{},
  listR2Objects:async key=>[{key,size:r2Metadata}],
}});
mock.module(url('../lib/backup-service.js'),{namedExports:{
  collectClinicData:async()=>({patients:{tables:{clinical_photos:[]}}}),
}});
mock.module(url('../lib/portable-clinical-export.js'),{namedExports:{buildPortableDocuments:()=>[]}});
const eligible=row=>row && (!row.expired_at || (row.status==='APPROVED' && row.last_error==='SOURCES_EXPIRED')) &&
  Date.parse(row.created_at)<Date.parse(row.entitlement_deadline_at) &&
  (row.entitlement_kind==='FREE' || (row.payment_status==='PAID' && row.confirmed_provider_id!=null &&
    row.payment_reference && row.quote_total_cents>0 && row.quote_accepted_at && row.paid_at &&
    Date.parse(row.paid_at)<Date.parse(row.entitlement_deadline_at)));
const db={
  async query(sql,p=[]) {
    statements.push({sql,p});
    if(sql.includes('AS annual_schema_ready')) return {rows:[{annual_schema_ready:schema}]};
    if(sql.includes('information_schema.columns')) return {rows:[{ready:schema}]};
    if(sql.includes("to_regclass('public.annual_photo_backup_requests')")) return {rows:[{requests:schema?'annual_photo_backup_requests':null}]};
    if(sql.includes('AS paid_subscription') || sql.includes("SELECT c.is_active,cs.general ? '_purge'"))
      return {rows:[{...clinic,purging:false}]};
    if(sql.includes('SELECT subscription_expires_at,subscription_days')) return {rows:[clinic]};
    if(sql.includes('AS request_deadline_at')) {
      assert.ok(sql.includes('NOT EXISTS (SELECT 1 FROM annual_photo_backup_periods newer'));
      const period=periods.filter(row=>Date.parse(row.starts_at)<=now &&
        (Date.parse(row.ends_at)>now || (p[2] && row.ends_at===p[1] && now<Date.parse(row.ends_at)+45*DAY)))
        .sort((a,b)=>Date.parse(b.starts_at)-Date.parse(a.starts_at))[0];
      return {rows:period?[{...period,request_deadline_at:new Date(Date.parse(period.ends_at)+(p[2]?45*DAY:0)).toISOString()}]:[]};
    }
    if(sql.includes('AS entitled') && sql.includes('WHERE r.id=')) {
      const row=orders.find(order=>order.id===p[0]);
      assert.ok(sql.includes('r.created_at<r.entitlement_deadline_at'));
      assert.ok(sql.includes("r.payment_status='PAID' AND r.confirmed_provider_id IS NOT NULL"));
      return {rows:row?[{...row,entitled:Boolean(eligible(row))}]:[]};
    }
    if(sql.includes('AS entitled') && sql.includes('r.created_at < $2')) {
      assert.ok(!sql.includes('r.created_at < p.ends_at'));
      return {rows:orders.filter(row=>eligible(row) && Date.parse(row.created_at)<Date.parse(p[1]) &&
        ['REQUESTED','APPROVED','READY'].includes(row.status)).map(row=>({...row,entitled:true}))};
    }
    if(sql.includes('SELECT email FROM clinic_users')) return {rows:[{email:'clinic@example.invalid'}]};
    if(sql.includes('SELECT id,status,last_error,lease_expires_at,expired_at'))
      return {rows:orders.filter(row=>row.entitlement_kind==='FREE' && row.period_id===p[1])};
    if(sql.includes('SELECT 1 FROM annual_photo_backup_requests'))
      return {rows:orders.filter(row=>row.period_id===p[1] && row.entitlement_kind==='FREE' && row.status!=='REJECTED')};
    if(sql.includes('INSERT INTO annual_photo_backup_requests')) {
      const row={id:p[0],clinic_id:p[1],period_id:p[2],requester_email:p[4],entitlement_kind:p[5],
        payment_status:p[6],entitlement_deadline_at:p[7],recovery_allowed:p[8],created_at:new Date(now).toISOString(),
        status:'REQUESTED',quote_cursor:0,quote_bytes_progress:0};
      orders.push(row); return {rows:[row]};
    }
    if(sql.includes('INSERT INTO annual_photo_backup_notifications')) {
      if(!notices.some(row=>row.request_id===p[1] && row.kind===p[3]))
        notices.push({id:p[0],request_id:p[1],clinic_id:p[2],kind:p[3],recipient:p[4],status:'PENDING',attempts:0});
    }
    if(sql.includes("SET status='SENDING'")) {
      const rows=notices.filter(row=>row.request_id===p[0] && ['PENDING','FAILED'].includes(row.status));
      rows.forEach(row=>{row.status='SENDING';row.attempts++;}); return {rows};
    }
    if(sql.includes('UPDATE annual_photo_backup_notifications') && sql.includes('SET status=$2')) {
      const row=notices.find(row=>row.id===p[0]); row.status=p[1]; row.last_error=p[2];
    }
    if(sql.includes('LEFT JOIN LATERAL')) return {rows:orders.map(row=>({...row,total_bytes:0,parts:[],notification_failed:false}))};
    if(sql.includes('SELECT * FROM annual_photo_backup_requests')) return {rows:orders.filter(row=>row.id===p[0])};
    if(sql.includes('SET quote_cursor=')) Object.assign(orders.find(row=>row.id===p[0]),{
      quote_cursor:p[2],quote_bytes_progress:p[3],quote_inventory_hash:p[4],original_total_bytes:p[5],
      quote_total_cents:p[6],quote_provider_id:p[7],payment_status:p[8]});
    if(sql.includes('SET quote_total_cents=$3')) Object.assign(orders.find(row=>row.id===p[0]),{quote_total_cents:p[2],payment_status:'PAYMENT_PENDING'});
    if(sql.includes('SET quote_accepted_at=')) orders.find(row=>row.id===p[0]).quote_accepted_at=new Date(now).toISOString();
    if(sql.includes("SET payment_status='PAID'")) Object.assign(orders.find(row=>row.id===p[0]),{
      payment_status:'PAID',paid_at:new Date(now).toISOString(),confirmed_provider_id:p[2],payment_reference:p[3]});
    if(sql.includes('SELECT id,record_id,clinic_id,r2_key FROM clinical_photos')) return {rows:photoRows};
    if(sql.includes('SELECT transaction_timestamp() AS at')) return {rows:[{at:new Date(now).toISOString()}]};
    if(sql.includes('SELECT id,clinic_id,status,') && sql.includes('FOR UPDATE'))
      return {rows:orders.filter(row=>row.id===p[0]).map(row=>({...row,expired:false}))};
    if(sql.includes('INSERT INTO annual_photo_backup_parts')) parts.push({part_number:p[2],completed_at:null});
    if(sql.includes("SET status='APPROVED'")) Object.assign(orders.find(row=>row.id===p[0]),{status:'APPROVED',approved_at:new Date(now).toISOString()});
    if(sql.includes("SET status='REQUESTED',approved_at=NULL")) Object.assign(orders.find(row=>row.id===p[0]),{
      status:'REQUESTED',expired_at:null,last_error:null});
    if(sql.includes('DELETE FROM annual_photo_backup_parts')) parts=[];
    if(sql.includes("SET dispatch_status='DISPATCHING'")) return {rows:[{id:p[0]}]};
    if(sql.includes('SET dispatch_status=$3')) return {rows:[{id:p[0]}]};
    if(sql.includes('SELECT status,lease_expires_at,')) return {rows:orders.filter(row=>row.id===p[0])};
    if(sql.includes("SELECT id FROM annual_photo_backup_requests")) return {rows:orders.filter(row=>row.id===p[0] &&
      (!sql.includes("status='READY'") || row.status==='READY'))};
    if(sql.includes('SET lease_hash=$3')) {
      const row=orders.find(row=>row.id===p[0]); row.lease_hash=p[2]; row.lease_expires_at=new Date(now+DAY).toISOString(); return {rows:[row]};
    }
    if(sql.includes('WHERE id=$1 AND clinic_id=$2 AND status=\'APPROVED\' AND lease_hash=$3'))
      return {rows:orders.filter(row=>row.id===p[0] && row.lease_hash===p[2])};
    if(sql.includes('count(*) FILTER(WHERE completed_at IS NULL)')) return {rows:[{total:parts.length,pending:parts.filter(row=>!row.completed_at).length}]};
    if(sql.includes("SET status='READY'")) {
      const row=orders.find(row=>row.id===p[0]); Object.assign(row,{status:'READY',ready_at:new Date(now).toISOString()}); return {rows:[row]};
    }
    if(sql.includes('UPDATE annual_photo_backup_periods SET consumed_at')) {
      if(orders.find(row=>row.id===p[2])?.entitlement_kind==='FREE') periods[0].consumed_at=new Date(now).toISOString();
    }
    if(sql.includes('SELECT id,ready_at FROM annual_photo_backup_requests')) return {rows:orders.filter(row=>row.id===p[0] && row.status==='READY')};
    if(sql.includes('SELECT part_number,r2_key,size_bytes')) return {rows:parts};
    return {rows:[]};
  }, release() {},
};
const pool={query:(...args)=>db.query(...args),connect:async()=>db};
mock.module(url('../lib/neon-clinical-db.js'),{namedExports:{
  getPool:()=>pool,getAppPool:()=>pool,withTenantContext:async(_id,fn)=>fn(db),
}});
const {handleAnnualPhotoBackup,annualPhotoQuote,createAnnualPhotoBackupSchema}=await import('../lib/annual-photo-backup.js');
const {annualPurgeProtection,SUBSCRIPTION_POLICY_VERSION}=await import('../lib/subscription-lifecycle.js');
mock.method(globalThis,'fetch',async()=>({ok:true,body:null}));
function reset(offset=0) {
  now=T+offset; schema=true; smtpFail=false; orders=[];notices=[];parts=[];deliveries=[];photoRows=[];r2Metadata=17;statements.length=0;
  actor={valid:true,role:'clinic_admin',id:7,clinic_id:CLINIC};
  clinic={is_active:true,subscription_expires_at:new Date(T).toISOString(),subscription_days:365,paid_subscription:true,general:{
    _subscription_policy:{kind:'paid',policy_version:SUBSCRIPTION_POLICY_VERSION,opt_in:true,acceptance_confirmed:true,
      basis:'new_contract',contract_reference:'fictitious-provider-contract',accepted_at:new Date(T-DAY).toISOString(),
      effective_at:new Date(T-DAY).toISOString(),recorded_at:new Date(T-DAY).toISOString(),recorded_by:{role:'master_admin',username:'provider'}},
  }};
  periods=[{id:PERIOD,clinic_id:CLINIC,starts_at:'2025-08-01T00:00:00.000Z',ends_at:new Date(T).toISOString(),consumed_at:null}];
  Object.assign(process.env,{EMAIL_USER:'robot@example.invalid',EMAIL_PASS:'fictitious',ANNUAL_PHOTO_BACKUP_MASTER_EMAIL:'master@example.invalid',
    ANNUAL_PHOTO_BACKUP_ENABLED:'false',ANNUAL_PHOTO_BACKUP_WORKER_URL:'https://worker.example.invalid',
    ANNUAL_PHOTO_BACKUP_SECRET:'s'.repeat(40),R2_ACCESS_KEY_ID:'fictitious',R2_SECRET_ACCESS_KEY:'fictitious'});
}
async function invoke(action,body=null) {
  const res={code:0,body:null,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await handleAnnualPhotoBackup({method:body?'POST':'GET',headers:{},query:{},body:body||undefined},res,action);
  return res;
}
test('expired annual free period survives through T+45-1; exact T+45 blocks new registration',async()=>{
  reset(45*DAY-1);
  let status=await invoke('photoBackupStatus'); assert.equal(status.body.eligible,true); assert.equal(status.body.processor_ready,false);
  const accepted=await invoke('requestPhotoBackup',{entitlement_kind:'PAID',paid:true});
  assert.equal(accepted.code,200); assert.equal(accepted.body.entitlement_kind,'FREE'); assert.equal(orders.length,1);
  assert.equal(notices[0].status,'SENT'); assert.equal(deliveries[0].attachments,undefined);
  now++; assert.equal((await invoke('requestPhotoBackup',{})).code,403); assert.equal(orders.length,1);
  assert.equal((await annualPurgeProtection(db,CLINIC,new Date(T+45*DAY),now)).protected,true);
});
test('consumed free quota is never eligible but multiple additional requests persist, ignoring client paid flags',async()=>{
  reset(40*DAY); periods[0].consumed_at=new Date(T).toISOString();
  assert.equal((await invoke('photoBackupStatus')).body.eligible,false);
  for(let n=0;n<2;n++) {
    const response=await invoke('requestPhotoBackup',{paid:true,payment_status:'PAID',confirmed_provider_id:1});
    assert.equal(response.code,200); assert.equal(response.body.status,'PAYMENT_PENDING'); assert.equal(response.body.needs_quote,true);
  }
  assert.equal(orders.length,2); assert.ok(orders.every(row=>row.payment_status==='NEEDS_QUOTE'));
  now=T+45*DAY; assert.equal((await annualPurgeProtection(db,CLINIC,new Date(now),now)).protected,false);
});
test('a newer registered annual period prevents accumulated old free eligibility; legacy contracts get no silent extension',async()=>{
  reset(1); clinic.subscription_expires_at=new Date(T+365*DAY).toISOString();
  periods.push({...periods[0],id:'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee',starts_at:new Date(T).toISOString(),ends_at:new Date(T+365*DAY).toISOString()});
  const current=await invoke('photoBackupStatus'); assert.equal(current.body.period.id,periods[1].id);
  periods.pop(); assert.equal((await invoke('photoBackupStatus')).body.eligible,false);
  reset(1); clinic.general._subscription_policy={kind:'legacy'};
  assert.equal((await invoke('requestPhotoBackup',{})).code,403);
});
test('registration survives SMTP failure exactly once; authenticated provider retries outbox without new request or duplicate SENT',async()=>{
  reset(40*DAY);smtpFail=true;
  const result=await invoke('requestPhotoBackup',{});assert.equal(result.code,200);assert.equal(orders.length,1);assert.equal(notices[0].status,'FAILED');
  actor={valid:true,role:'master_admin',id:1,clinic_id:null};smtpFail=false;
  const retry={requestId:orders[0].id,clinicId:CLINIC};
  assert.equal((await invoke('retryPhotoBackupNotifications',retry)).code,200);
  assert.equal(notices[0].status,'SENT'); assert.equal(deliveries.length,2);
  await invoke('retryPhotoBackupNotifications',retry);
  assert.equal(deliveries.length,2);assert.equal(orders.length,1);
  assert.equal(deliveries[0].messageId,deliveries[1].messageId);
});
test('schema absent fails closed without fake acceptance; configured status reports migration_needed',async()=>{
  reset(40*DAY);schema=false;
  const status=await invoke('photoBackupStatus');assert.equal(status.body.configured,false);assert.equal(status.body.reason,'migration_needed');
  assert.equal((await invoke('requestPhotoBackup',{})).code,503);assert.equal(orders.length,0);assert.equal(notices.length,0);
});
test('existing pre-migration annual requests block destructive callers instead of declaring no hold',async()=>{
  reset(45*DAY);
  const calls=[];
  const legacyDb={async query(sql) {
    calls.push(sql);
    if(sql.includes("to_regclass('public.annual_photo_backup_requests')"))
      return {rows:[{requests:'annual_photo_backup_requests'}]};
    if(sql.includes('information_schema.columns')) return {rows:[{ready:false}]};
    assert.fail('Unverifiable legacy requests must not be read as entitled or unprotected');
  }};
  await assert.rejects(annualPurgeProtection(legacyDb,CLINIC,new Date(now),now),
    {status:503,code:'ANNUAL_MIGRATION_NEEDED'});
  assert.equal(calls.length,2);
});
test('quote pricing uses decimal original bytes and IVA-inclusive final USD tiers',()=>{
  for(const [bytes,cents] of [[0,1000],[5e9,1000],[5e9+1,2000],[20e9,2000],[20e9+1,3500],[50e9,3500],[50e9+1,null]]) {
    const quote=annualPhotoQuote(bytes);assert.equal(quote.quote_total_cents,cents);assert.equal(quote.iva_included,true);assert.equal(quote.gb_unit_bytes,1e9);
  }
});
test('server quote uses trusted R2 metadata, not photo/client sizes; paid provider evidence holds to READY+24h, download is job-scoped',async()=>{
  reset(40*DAY);periods[0].consumed_at=new Date(T).toISOString();
  await invoke('requestPhotoBackup',{paid:true});const order=orders[0];
  const payload={requestId:order.id,clinicId:CLINIC};
  assert.equal((await invoke('confirmPhotoBackupPayment',{...payload,paymentConfirmed:true,paymentReference:'forged'})).code,403);
  actor={valid:true,role:'master_admin',id:1,clinic_id:null};
  photoRows=[{id:1,record_id:7,clinic_id:CLINIC,r2_key:`clinics/${CLINIC}/records/7/photos/1.jpg`,file_size:99999999}];
  const quote=await invoke('quotePhotoBackup',{...payload,totalBytes:1,paid:true});
  assert.equal(quote.code,200);assert.equal(quote.body.original_total_bytes,17);assert.equal(order.quote_total_cents,1000);
  assert.equal((await invoke('confirmPhotoBackupPayment',{...payload,paymentConfirmed:true,paymentReference:'provider-proof'})).code,400);
  await invoke('acceptPhotoBackupQuote',{...payload,acceptanceConfirmed:true});
  assert.equal((await invoke('confirmPhotoBackupPayment',{...payload,paymentConfirmed:true,paymentReference:'provider-proof'})).code,200);
  assert.equal(order.confirmed_provider_id,1); assert.equal(order.payment_status,'PAID');
  assert.equal((await invoke('approvePhotoBackup',payload)).code,503); // Worker remains OFF.
  now=T+45*DAY;
  assert.equal((await annualPurgeProtection(db,CLINIC,new Date(now),now)).protected,true);
  process.env.ANNUAL_PHOTO_BACKUP_ENABLED='true'; // Test-only config, no infrastructure activation.
  const approval=await invoke('approvePhotoBackup',payload);assert.equal(approval.code,200);
  parts[0].completed_at=new Date(now).toISOString();parts[0].size_bytes=10;
  const callback=async(action,body)=>{
    const res={code:0,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await handleAnnualPhotoBackup({method:'POST',headers:{'x-photo-backup-secret':'s'.repeat(40)},body:{...payload,...body},query:{}},res,action);return res;
  };
  const claimed=await callback('photoBackupWorkerClaim',{});
  assert.equal(claimed.code,200);
  const complete=await callback('photoBackupWorkerComplete',{leaseToken:claimed.body.leaseToken});
  assert.equal(complete.code,200);assert.equal(order.status,'READY');
  actor={valid:true,role:'clinic_admin',id:7,clinic_id:CLINIC};
  assert.equal((await invoke('photoBackupDownload',{requestId:order.id,index:0})).code,200);
  assert.equal((await invoke('photoBackupDownload',{requestId:PERIOD,index:0})).code,404);
  now+=DAY-1;assert.equal((await annualPurgeProtection(db,CLINIC,new Date(T+45*DAY),now)).protected,true);
  now++;assert.equal((await annualPurgeProtection(db,CLINIC,new Date(T+45*DAY),now)).protected,false);
  assert.equal((await invoke('photoBackupDownload',{requestId:order.id,index:0})).code,403);
});
test('migration generator remains idempotent, preserves old free jobs and removes single-period uniqueness locally only',async()=>{
  const sql=[];const adapter={query:async statement=>{sql.push(statement);return {rows:[]};}};
  await createAnnualPhotoBackupSchema(adapter);const first=[...sql];sql.length=0;await createAnnualPhotoBackupSchema(adapter);
  assert.deepEqual(sql,first);
  assert.ok(first.some(statement=>statement.includes('annual_backup_one_free_period') && statement.includes("WHERE entitlement_kind='FREE'")));
  assert.ok(first.some(statement=>statement.includes('r.entitlement_deadline_at IS NULL')));
  assert.ok(first.some(statement=>statement.includes('DROP CONSTRAINT %I')));
});
test('provider source-retention fault keeps accepted free hold and retries same order after cleanup without consuming a second entitlement',async()=>{
  reset(40*DAY);await invoke('requestPhotoBackup',{});
  const order=orders[0],created=order.created_at;
  Object.assign(order,{status:'APPROVED',last_error:'SOURCES_EXPIRED',expired_at:new Date(now).toISOString(),
    sources_deleted_at:new Date(now).toISOString(),artifacts_deleted_at:new Date(now).toISOString()});
  now=T+50*DAY;
  assert.equal((await annualPurgeProtection(db,CLINIC,new Date(T+45*DAY),now)).protected,true);
  actor={valid:true,role:'master_admin',id:1,clinic_id:null};process.env.ANNUAL_PHOTO_BACKUP_ENABLED='true';
  assert.equal((await invoke('approvePhotoBackup',{clinicId:CLINIC,requestId:order.id})).code,200);
  assert.equal(orders.length,1);assert.equal(order.created_at,created);assert.equal(order.entitlement_kind,'FREE');
  assert.equal(order.payment_status,'NOT_REQUIRED');assert.equal(order.status,'APPROVED');
});
