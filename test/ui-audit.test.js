import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';

// Unit boundary: execute the shipped UI with DOM/fetch dependencies substituted.
// Browser bootstrap is excluded; rendering and async handlers themselves are real.
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/\ninit\(\);\s*$/,'');
function setup(fetchImpl=async()=>({ok:true,json:async()=>({})})) {
  const nodes=new Map(),documentListeners=new Map();
  const node=()=>({innerHTML:'',textContent:'',open:false,hidden:false,dataset:{},listeners:{},classList:{remove(){},toggle(){}},
    addEventListener(type,listener){this.listeners[type]=listener;},showModal(){this.open=true;},close(){this.open=false;},querySelector(){return null;},querySelectorAll(){return [];}});
  for(const id of ['app','modal','page','page-content','preview-count','assignment-preview','assign-submit','toast'])nodes.set('#'+id,node());
  const context=vm.createContext({console,URLSearchParams,Intl,Date,crypto:{randomUUID},fetch:fetchImpl,
    setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},
    document:{querySelector:selector=>nodes.get(selector)||null,querySelectorAll:()=>[],addEventListener:(type,listener)=>documentListeners.set(type,listener),activeElement:null,hidden:false}});
  const run=code=>vm.runInContext(code,context);
  run(source);
  run(`state.boot={user:{id:2,name:'Менеджер',roles:['manager'],homeHallId:8,tagIds:[8]},users:[{id:2,name:'Менеджер'},{id:4,name:'Волонтёр'}],tags:[{id:8,name:'Hall 1',kind:'hall'}],personalTags:[],settings:{crossHall:false},notifications:[]};`);
  return {nodes,node,run,documentListeners};
}
const question={id:7,taskId:1,askedBy:3,controllerId:3,source:'volunteer',forwarded:false,blocking:true,urgency:'normal',state:'open',tagIds:[],messages:[]};

test('UI: администратор не видит закрытие и переадресацию чужого вопроса',()=>{
  const f=setup();f.run("state.boot.user.roles=['admin'];");
  const html=f.run(`renderDiscussion(${JSON.stringify(question)})`);
  assert.ok(!html.includes('data-action="close-question"'));
  assert.ok(!html.includes('data-action="forward-question"'));
});

test('UI: получивший вопрос менеджер видит подтверждение решения и переадресацию',()=>{
  const f=setup();
  const html=f.run(`renderDiscussion(${JSON.stringify({...question,controllerId:2})})`);
  assert.ok(html.includes('data-action="close-question"'));
  assert.ok(html.includes('data-action="forward-question"'));
});

test('UI: завершённое групповое назначение не показывает участника продолжающим работу',()=>{
  const f=setup();
  f.run(`state.modalType='task';state.detail={id:1,title:'Доставить',description:'',status:'done',authorId:2,assignedBy:2,hallId:8,tagIds:[8],assignments:[{volunteerId:4,acceptedAt:'2026-11-15T12:00:00Z'}],siblings:[],history:[],questions:[],canWork:true,canReset:false};renderTaskDetail();`);
  const html=f.nodes.get('#modal').innerHTML;
  assert.ok(!html.includes('>В работе</span>'));
  assert.ok(html.includes('Выполнена'));
});

test('UI: незакрытый блокирующий вопрос не предлагает завершить задачу',()=>{
  const f=setup();
  f.run(`state.modalType='task';state.detail={id:1,title:'Доставить',description:'',status:'in_progress',blocked:true,authorId:2,claimedBy:2,hallId:8,tagIds:[8],assignments:[],siblings:[],history:[],questions:[],canWork:true,canReset:true};renderTaskDetail();`);
  assert.ok(!f.nodes.get('#modal').innerHTML.includes('data-task-action="complete"'));
});

test('UI: устаревший предпросмотр закрытой формы не меняет получателей новой задачи',async()=>{
  const requests=[];
  const f=setup(()=>new Promise(resolve=>requests.push(resolve)));
  const formA={...f.node(),elements:{mode:{value:'free'}}};
  const formB={...f.node(),elements:{mode:{value:'free'}}};
  f.nodes.set('#assignment-form',formA);
  f.run("state.modalType='assignment';state.previewRevision=0;state.assignmentPreview=[];");
  const pendingA=f.run('refreshAssignmentPreview()');
  f.nodes.set('#assignment-form',formB);
  f.run('state.previewRevision=0;');
  const pendingB=f.run('refreshAssignmentPreview()');
  const response=id=>({ok:true,json:async()=>({volunteers:[{id,name:'Волонтёр '+id,available:true,tasks:[],personalTagIds:[]}]})});
  requests[1](response(5));await pendingB;
  requests[0](response(4));await pendingA;
  assert.equal(f.run('state.assignmentPreview[0].id'),5);
});

test('UI: уведомления обновляются во время периодического получения данных',async()=>{
  const f=setup();
  f.run("state.view='notifications';state.boot.notifications=[{id:1,text:'Получен новый ответ',createdAt:'2026-11-15T12:00:00Z'}];");
  await f.run('loadCurrent()');
  assert.ok(f.nodes.get('#page-content').innerHTML.includes('Получен новый ответ'));
});

test('UI: отменённая доставка имеет русское состояние и не предлагает повтор',()=>{
  const f=setup();f.nodes.set('#deliveries-results',f.node());
  f.run("state.deliveries=[{id:1,status:'cancelled',userId:4,error:'Адресат больше не имеет доступа'}];renderDeliveries();");
  const html=f.nodes.get('#deliveries-results').innerHTML;
  assert.ok(html.includes('>Отменено</span>'));
  assert.ok(!html.includes('retry-delivery'));
});

test('UI: главная очередь менеджера явно называет его холл',()=>{
  const f=setup();f.run("state.scope='home';");
  assert.ok(f.run('titleForView()').includes('Hall 1'));
});

test('UI: обновление названия холла меняет навигацию, сохраняя черновик диалога',async()=>{
  const boot={user:{id:2,name:'Менеджер',roles:['manager'],homeHallId:8,tagIds:[8]},users:[],tags:[{id:8,name:'Главный зал',kind:'hall'}],settings:{crossHall:false},notifications:[]};
  const f=setup(async()=>({ok:true,json:async()=>boot}));
  f.nodes.set('#sidebar',f.node());
  const modal=f.nodes.get('#modal');modal.innerHTML='<textarea>Незаконченный ответ</textarea>';modal.open=true;
  await f.run('refreshBootstrap()');
  assert.ok(f.nodes.get('#sidebar').innerHTML.includes('Главный зал'));
  assert.equal(modal.innerHTML,'<textarea>Незаконченный ответ</textarea>');
  assert.equal(modal.open,true);
});

test('UI: фильтр общего тега доступен совместно с фильтрами основной очереди',()=>{
  const f=setup();
  for(const id of ['task-count','task-stats','tasks-results'])f.nodes.set('#'+id,f.node());
  f.run("state.scope='home';renderTasksPage();");
  assert.ok(f.nodes.get('#page-content').innerHTML.includes('name="tagId"'));
});

test('UI: назначивший менеджер может явно передать итог всем участникам группы',async()=>{
  const task={id:1,assignedBy:2,assignments:[{volunteerId:4},{volunteerId:5}]};
  const f=setup(async()=>({ok:true,json:async()=>task}));
  f.run(`state.questions=[${JSON.stringify({...question,controllerId:2})}];`);
  await f.run('showCloseQuestion(7)');
  const html=f.nodes.get('#modal').innerHTML;
  assert.ok(html.includes('name="sendToVolunteers"'));
  assert.ok(html.includes('Волонтёр'));
});

test('UI: контролирующий вопрос участник не рассылает итог чужому пулу',async()=>{
  const task={id:1,assignedBy:3,assignments:[{volunteerId:4}]};
  const f=setup(async()=>({ok:true,json:async()=>task}));
  f.run(`state.questions=[${JSON.stringify({...question,controllerId:2})}];`);
  await f.run('showCloseQuestion(7)');
  assert.ok(!f.nodes.get('#modal').innerHTML.includes('name="sendToVolunteers"'));
});

const response=body=>({ok:true,json:async()=>body});
const taskDetail=(id,title='Задача')=>({id,title,status:'queued',authorId:2,tagIds:[],assignments:[],siblings:[],history:[],questions:[],canWork:true,canReset:false});
async function until(predicate){for(let i=0;i<30&&!predicate();i++)await Promise.resolve();assert.ok(predicate(),'Ожидаемый запрос не был начат.');}

test('UI: отложенное открытие назначения не заменяет уже открытую другую задачу',async()=>{
 const requests=[];const f=setup(()=>new Promise(resolve=>requests.push(resolve)));
 f.run("state.detailId=1;showModal('task','Задача A');");
 const pending=f.run('showAssignment(1)');
 f.run("closeModal();state.detailId=2;showModal('task','Черновик задачи B');");
 requests[0](response({volunteers:[]}));await pending;
 assert.equal(f.run('state.modalType'),'task');
 assert.equal(f.nodes.get('#modal').innerHTML,'Черновик задачи B');
});

test('UI: отложенное открытие закрытия вопроса не возвращается после отмены',async()=>{
 const requests=[];const f=setup(()=>new Promise(resolve=>requests.push(resolve)));
 f.run(`state.questions=[${JSON.stringify({...question,controllerId:2})}];`);
 const pending=f.run('showCloseQuestion(7)');
 f.run("closeModal();showModal('edit-tag','Черновик нового тега');");
 requests[0](response({id:1,assignedBy:2,assignments:[]}));await pending;
 assert.equal(f.run('state.modalType'),'edit-tag');
 assert.equal(f.nodes.get('#modal').innerHTML,'Черновик нового тега');
});

test('UI: ссылка Telegram не показывается после выхода и входа в новую сессию',async()=>{
 const requests=[];const f=setup(()=>new Promise(resolve=>requests.push(resolve)));
 f.run("state.boot.csrf='first-session';");
 const pending=f.run('connectVolunteer(4)');
 f.run("closeModal();state.boot.csrf='new-session';showModal('edit-user','Новый диалог');");
 requests[0](response({url:'https://t.me/example_bot?start=private-invitation',expiresAt:'2026-11-16T12:00:00Z'}));await pending;
 assert.equal(f.run('state.modalType'),'edit-user');
 assert.ok(!f.nodes.get('#modal').innerHTML.includes('private-invitation'));
});

test('UI: устаревшая загрузка вопроса не открывает задачу поверх нового диалога',async()=>{
 const requests=[];const f=setup(()=>new Promise(resolve=>requests.push(resolve)));
 const pending=f.run('openQuestion(7)');
 f.run("showModal('edit-tag','Черновик');");
 const count=requests.length;
 for(const resolve of requests.slice())resolve(response({questions:[question]}));
 await until(()=>requests.length>count||f.nodes.get('#modal').innerHTML==='Черновик');
 // A stale implementation starts another task fetch. Resolve it to expose the UI overwrite.
 for(let i=0;i<20;i++)await Promise.resolve();
 if(requests.length>count)requests.at(-1)(response(taskDetail(1)));
 await pending;
 assert.equal(requests.length,count);
 assert.equal(f.nodes.get('#modal').innerHTML,'Черновик');
});

test('UI: повторное открытие того же ID сохраняет ответ последней загрузки',async()=>{
 const requests=[];const f=setup(()=>new Promise(resolve=>requests.push(resolve)));
 const first=f.run('openTask(1)'),second=f.run('openTask(1)');
 requests[1](response(taskDetail(1,'Актуальные данные')));await second;
 requests[0](response(taskDetail(1,'Устаревшие данные')));await first;
 assert.equal(f.run('state.detail.title'),'Актуальные данные');
});

test('UI: обновление после действия не заменяет другую открытую карточку',async()=>{
 const requests=[];const f=setup(()=>new Promise(resolve=>requests.push(resolve)));
 const boot=f.run('JSON.parse(JSON.stringify(state.boot))');
 f.run("state.view='account';state.detailId=1;showModal('task','Задача A');");
 const pending=f.run('refreshAfterAction(1)');
 requests[0](response(boot));await until(()=>requests.length===2);
 f.run("state.detailId=2;showModal('task','Черновик B');");
 requests[1](response(taskDetail(1)));await pending;
 assert.equal(f.nodes.get('#modal').innerHTML,'Черновик B');
});

test('UI: фоновая загрузка не стирает черновик, начатый во время запроса',async()=>{
 const requests=[];const f=setup(()=>new Promise(resolve=>requests.push(resolve)));
 const boot=f.run('JSON.parse(JSON.stringify(state.boot))');
 f.run("state.view='account';state.detailId=1;showModal('task','Карточка');");
 const pending=f.run('poll()');
 requests[0](response(boot));await until(()=>requests.length===2);
 const modal=f.nodes.get('#modal');modal.innerHTML='Новый черновик';modal.querySelector=()=>({dataset:{dirty:'1'}});
 requests[1](response(taskDetail(1)));await pending;
 assert.equal(modal.innerHTML,'Новый черновик');
});

test('UI: запоздалое событие close не очищает заново открытый диалог',()=>{
 const f=setup();const modal=f.nodes.get('#modal');
 f.run("showModal('task','A');closeModal();state.detailId=2;showModal('task','B');");
 modal.listeners.close();
 assert.equal(f.run('state.detailId'),2);
 assert.equal(f.run('state.modalType'),'task');
});

test('UI: у заблокированной задачи отмена доступна отдельно от запрещённого возврата',()=>{
 const f=setup();
 f.run(`state.modalType='task';state.detail={...${JSON.stringify(taskDetail(1))},status:'in_progress',blocked:true,claimedBy:2,canReset:true,canCancel:true};renderTaskDetail();`);
 const html=f.nodes.get('#modal').innerHTML;
 assert.ok(!html.includes('data-action="reset-task"'));
 assert.ok(html.includes('data-action="cancel-task"'));
});

test('UI: большой список получателей свёрнут и раскрывает все экранированные имена',()=>{
 const f=setup();
 f.run("state.boot.users=Array.from({length:9},(_,i)=>({id:i+10,name:'Получатель <'+(i+1)+'>'}));");
 const html=f.run(`renderDiscussion(${JSON.stringify({...question,recipientIds:Array.from({length:9},(_,i)=>i+10)})})`);
 assert.ok(html.includes('<details><summary>Получатели: 9</summary>'));
 assert.ok(html.includes('Получатель &lt;9&gt;</details>'));
 assert.ok(!html.includes('Получатель <9>'));
 const short=f.run(`renderDiscussion(${JSON.stringify({...question,recipientIds:[10,11]})})`);
 assert.ok(short.includes('<br>Получатели: Получатель &lt;1&gt;, Получатель &lt;2&gt;'));
 assert.ok(!short.includes('<summary>Получатели:'));
});


test('UI: завершение отправки старой формы не закрывает и не заменяет новый диалог',async()=>{
 let complete;const paths=[];let boot;
 const f=setup(path=>{
  paths.push(path);
  if(paths.length===1)return new Promise(resolve=>complete=resolve);
  return Promise.resolve(response(path==='/api/bootstrap'?boot:taskDetail(1)));
 });
 boot=f.run('JSON.parse(JSON.stringify(state.boot))');
 f.run("globalThis.FormData=class {constructor(){}get(){return null;}has(){return false;}};state.view='account';state.assignmentPreview=[{id:4}];showModal('assignment','Форма A');");
 const pending=f.run("submitForm({id:'assignment-form',dataset:{taskId:'1'},isConnected:true})");
 f.run("showModal('edit-user','Черновик нового участника');");
 complete(response({}));await pending;
 assert.equal(f.run('state.modalType'),'edit-user');
 assert.equal(f.nodes.get('#modal').innerHTML,'Черновик нового участника');
 assert.deepEqual(paths,['/api/tasks/1/assign']);
});

test('UI: результат отправки заменённой формы не перерисовывает её новую копию',async()=>{
 let complete;let boot;const paths=[];
 const f=setup(path=>{
  paths.push(path);
  if(paths.length===1)return new Promise(resolve=>complete=resolve);
  return Promise.resolve(response(path==='/api/bootstrap'?boot:taskDetail(1)));
 });
 boot=f.run('JSON.parse(JSON.stringify(state.boot))');
 f.run("globalThis.FormData=class {constructor(){}get(){return null;}has(){return false;}};state.view='account';state.assignmentPreview=[{id:4}];showModal('assignment','Форма A');globalThis.oldForm={id:'assignment-form',dataset:{taskId:'1'},isConnected:true};");
 const pending=f.run('submitForm(oldForm)');
 // Replacing DOM content disconnects the original form even when a refresh keeps the same modal epoch.
 f.run("oldForm.isConnected=false;showModal('assignment','Новый выбор',true);");
 complete(response({}));await pending;
 assert.equal(f.nodes.get('#modal').innerHTML,'Новый выбор');
 assert.deepEqual(paths,['/api/tasks/1/assign']);
});

test('UI: результат кнопки старой задачи не обновляет другую карточку',async()=>{
 let complete;let boot;const paths=[];
 const f=setup(path=>{
  paths.push(path);
  if(paths.length===1)return new Promise(resolve=>complete=resolve);
  return Promise.resolve(response(path==='/api/bootstrap'?boot:taskDetail(2)));
 });
 boot=f.run('JSON.parse(JSON.stringify(state.boot))');
 f.run("state.view='account';state.detailId=1;showModal('task','Задача A');");
 const button={dataset:{taskAction:'claim',id:'1'},isConnected:true};
 const pending=f.documentListeners.get('click')({target:{closest:()=>button}});
 f.run("state.detailId=2;showModal('task','Черновик B');");
 complete(response({}));await pending;
 assert.equal(f.nodes.get('#modal').innerHTML,'Черновик B');
 assert.deepEqual(paths,['/api/tasks/1/claim']);
});

test('UI: уход во время обновления после отправки не открывает старую задачу',async()=>{
 const paths=[],requests=[];let boot;
 const f=setup(path=>{paths.push(path);return new Promise(resolve=>requests.push(resolve));});
 boot=f.run('JSON.parse(JSON.stringify(state.boot))');
 f.run("globalThis.FormData=class {constructor(){}get(){return null;}has(){return false;}};state.view='account';state.assignmentPreview=[{id:4}];showModal('assignment','Форма A');");
 const pending=f.run("submitForm({id:'assignment-form',dataset:{taskId:'1'},isConnected:true})");
 requests[0](response({}));await until(()=>requests.length===2);
 f.run("showModal('edit-tag','Новый черновик');");
 requests[1](response(boot));await pending;
 assert.equal(f.nodes.get('#modal').innerHTML,'Новый черновик');
 assert.deepEqual(paths,['/api/tasks/1/assign','/api/bootstrap']);
});

test('UI: действующая форма назначения после отправки открывает актуальную задачу',async()=>{
 const paths=[];let boot;
 const f=setup(async path=>{paths.push(path);return response(path==='/api/bootstrap'?boot:taskDetail(1,'Назначенная задача'));});
 boot=f.run('JSON.parse(JSON.stringify(state.boot))');
 f.run("globalThis.FormData=class {constructor(){}get(){return null;}has(){return false;}};state.view='account';state.assignmentPreview=[{id:4}];showModal('assignment','Форма');");
 await f.run("submitForm({id:'assignment-form',dataset:{taskId:'1'},isConnected:true})");
 assert.equal(f.run('state.modalType'),'task');
 assert.equal(f.run('state.detail.title'),'Назначенная задача');
 assert.deepEqual(paths,['/api/tasks/1/assign','/api/bootstrap','/api/tasks/1']);
});

test('UI: поздний 401 старого запроса не завершает новую сессию',async()=>{
 let complete;const f=setup(()=>new Promise(resolve=>complete=resolve));
 f.run("state.boot.csrf='session-A';");
 const pending=f.run("api('/api/tasks/1').catch(()=>{})");
 f.run("closeModal();state.boot.csrf='session-B';showModal('edit-user','Новая сессия');");
 complete({ok:false,status:401,json:async()=>({error:'Старая сессия завершилась'})});await pending;
 assert.equal(f.run('state.boot?.csrf'),'session-B');
 assert.equal(f.run('state.modalType'),'edit-user');
 assert.equal(f.nodes.get('#modal').innerHTML,'Новая сессия');
 assert.ok(!f.nodes.get('#app').innerHTML.includes('login-form'));
});

test('UI: поздний bootstrap старой сессии не возвращает прежнего пользователя',async()=>{
 let complete;const f=setup(()=>new Promise(resolve=>complete=resolve));
 f.run("state.boot.csrf='session-A';");const oldBoot=f.run('JSON.parse(JSON.stringify(state.boot))');
 const pending=f.run('refreshBootstrap()');
 f.run("closeModal();state.boot={...state.boot,csrf:'session-B',user:{...state.boot.user,id:99,name:'Новый пользователь'}};showModal('edit-user','Новая сессия');");
 complete(response(oldBoot));await pending;
 assert.equal(f.run('state.boot.csrf'),'session-B');
 assert.equal(f.run('me().id'),99);
 assert.equal(f.nodes.get('#modal').innerHTML,'Новая сессия');
});
