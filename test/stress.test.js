import test from 'node:test';
import assert from 'node:assert/strict';
import { runHandlerStress, runWorkerContention, runCrashRecovery } from '../scripts/stress-audit.js';

function externalFixtureTransport(f,{failCompletionResponses=false}={}) {
  let completions=0;
  return async(url,options={})=>{
    const path=new URL(url).pathname+new URL(url).search;
    const body=options.body?JSON.parse(options.body):undefined;
    let result;
    if(failCompletionResponses&&path==='/__audit/telegram'&&body?.callback_query?.data.startsWith('complete:')&&++completions>1)result={status:500,body:{error:'Synthetic failure to test the benchmark itself.'}};
    else if(path==='/__audit/status')result={status:200,body:{fixture:'NERC_ISOLATED_AUDIT',fakeTelegram:true,managers:f.managers,volunteers:f.volunteers,calls:f.calls,memory:process.memoryUsage()}};
    else if(path==='/__audit/telegram')result={status:200,body:await f.bot.handleUpdate(body)};
    else if(path==='/__audit/drain'){await f.drain();result={status:200,body:{ok:true,calls:f.calls}};}
    else result=await f.request(path,{method:options.method,body,headers:options.headers});
    return new Response(JSON.stringify(result.body),{status:result.status,headers:result.headers});
  };
}

test('нагрузка: 50 конкурирующих HTTP-обработчиков, 200 волонтёров, callbacks и OR-уведомления без дублей', {timeout:30000}, async()=>{
  const report=await runHandlerStress();
  assert.equal(report.serverErrors,0);
  assert.equal(report.claimRace.statuses[200],1);
  assert.equal(report.assignmentRace.statuses[200],1);
  assert.equal(report.mixedRace.statuses[200],1);
  assert.equal(report.massAssignment.recipients,200);
  assert.equal(report.massAssignment.messages,200);
  assert.equal(report.questions.duplicateNotifications,0);
});

test('конкуренция: 50 реальных потоков SQLite оставляют одного исполнителя при смешанном claim/assign', {timeout:30000}, async()=>{
  const report=await runWorkerContention();
  assert.equal(report.success,1);
  assert.equal(report.controlledConflicts,49);
  assert.equal(report.sqliteBusyErrors,0);
});

test('жёсткий перезапуск: SIGKILL сохраняет задачи, назначения, вопросы, аудит, outbox и дедупликацию', {timeout:20000}, async()=>{
  const report=await runCrashRecovery();
  assert.equal(report.integrity,'ok');
  assert.equal(report.uncommittedChangesRolledBack,true);
  assert.equal(report.telegramEventDedupePreserved,true);
});

test('внешний нагрузочный runner использует только идентифицированный тестовый стенд и проверяет HTTP/Bot API цикл', {timeout:20000}, async()=>{
  const {createAuditHarness,runExternalStress}=await import('../scripts/stress-audit.js');
  const f=await createAuditHarness({organizers:2,poolSize:200});
  try{
    const fetchImpl=externalFixtureTransport(f);
    const report=await runExternalStress({url:'http://127.0.0.1:4338',auditToken:'synthetic',fetchImpl});
    assert.match(report.mode,/no TCP/);
    assert.equal(report.claimRace.statuses[200],1);
    assert.equal(report.assignmentRace.statuses[200],1);
    assert.equal(report.massAssignment.messages,200);
    assert.equal(report.callbackComplete.businessSuccess,1);
    assert.equal(report.callbackRefreshDelivery.actualCardEdits,200);
  }finally{await f.close();}
});

test('изолированный стенд отказывается открывать существующий файл базы и не меняет его', async t=>{
  const {mkdtempSync,writeFileSync,readFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const directory=mkdtempSync(join(tmpdir(),'nerc-fixture-safety-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const database=join(directory,'existing.sqlite');
  writeFileSync(database,'existing-file-must-stay-unchanged');
  const {createAuditHarness}=await import('../scripts/stress-audit.js');
  await assert.rejects(()=>createAuditHarness({database}),/refusing an existing file/);
  assert.equal(readFileSync(database,'utf8'),'existing-file-must-stay-unchanged');
});


test('внешний runner отклоняет HTTP500 в completion burst вместо ложного отчёта о 49 конфликтах', {timeout:20000}, async()=>{
  const {createAuditHarness,runExternalStress}=await import('../scripts/stress-audit.js');
  const f=await createAuditHarness({organizers:2,poolSize:50});
  try {
    const fetchImpl=externalFixtureTransport(f,{failCompletionResponses:true});
    await assert.rejects(()=>runExternalStress({url:'http://127.0.0.1:4338',auditToken:'synthetic',fetchImpl}),/non-200 HTTP response/);
  }finally{await f.close();}
});
