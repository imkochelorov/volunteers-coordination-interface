const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const paths = {
  grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  list:'M9 6h12 M9 12h12 M9 18h12 M3 6h.01 M3 12h.01 M3 18h.01',
  check:'M5 12l4 4L19 6',
  message:'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z',
  users:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  hall:'M3 21h18 M5 21V5l7-3 7 3v16 M9 8h.01 M15 8h.01 M9 12h.01 M15 12h.01 M10 21v-5h4v5',
  settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z M3 12l2-2-.2-3 3-.2L10 4l2 1 2-1 2.2 2.8 3 .2-.2 3 2 2-2 2 .2 3-3 .2L14 20l-2-1-2 1-2.2-2.8-3-.2.2-3-2-2Z',
  plus:'M12 5v14 M5 12h14',
  search:'M21 21l-4.3-4.3 M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  clock:'M12 8v4l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  alert:'M12 8v4 M12 16h.01 M10.3 3.9 1.8 18.6A1.6 1.6 0 0 0 3.2 21h17.6a1.6 1.6 0 0 0 1.4-2.4L13.7 3.9a2 2 0 0 0-3.4 0Z',
  close:'M6 6l12 12 M6 18 18 6',
  arrow:'M7 17 17 7 M7 7h10v10',
  logout:'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
  menu:'M3 6h18 M3 12h18 M3 18h18',
  send:'m22 2-7 20-4-9-9-4L22 2Z M22 2 11 13',
  lock:'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
  refresh:'M20 7v5h-5 M4 17v-5h5 M6.1 7a7 7 0 0 1 11.55-2L20 8 M4 16l2.35 3A7 7 0 0 0 17.9 17',
  tag:'M20.6 13.6 13.6 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8Z M7 7h.01',
  inbox:'M4 4h16l2 12v4H2v-4L4 4Z M2 16h6l2 3h4l2-3h6',
  bell:'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4',
  bolt:'m13 2-9 12h7l-1 8 10-12h-7l1-8Z',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.list}"/></svg>`;
const state = {boot:null,view:'tasks',scope:'all',hallId:'',tagId:'',box:'incoming',tasks:[],questions:[],volunteers:[],deliveries:[],filters:{status:'',assignment:'',q:'',blocked:false,openQuestions:false},detailId:null,detail:null,modalType:null,modalEpoch:0,offline:false,polling:false};
const statusNames = {queued:'В очереди',in_progress:'В процессе',done:'Выполнена',cancelled:'Отменена'};
const roleNames = {admin:'Администратор',organizer:'Организатор',manager:'Менеджер',volunteer:'Волонтёр'};
const eventNames = {created:'Задача опубликована',task_created:'Задача опубликована',claimed:'Задача взята в работу',task_claimed:'Задача взята в работу',assigned:'Назначены волонтёры',task_assigned:'Назначены волонтёры',accepted:'Волонтёр начал выполнение',task_accepted:'Волонтёр начал выполнение',completed:'Задача выполнена',task_completed:'Задача выполнена',done:'Задача выполнена',cancelled:'Задача отменена',task_cancelled:'Задача отменена',reset:'Задача возвращена в очередь',task_reset:'Задача возвращена в очередь',question_created:'Задан вопрос',question_replied:'Добавлен ответ',question_answered:'Добавлен ответ',question_forwarded:'Вопрос передан адресатам',question_closed:'Вопрос решён'};
const listFrom = (value, key) => Array.isArray(value) ? value : value?.[key] || [];
const ids = values => [...new Set((values || []).map(Number).filter(Number.isFinite))];
const me = () => state.boot?.user || {};
function sessionContext() {
 const userId=me().id,csrf=state.boot?.csrf;
 return ()=>userId===me().id&&csrf===state.boot?.csrf;
}
const hasRole = role => (me().roles || []).includes(role);
const canManage = () => hasRole('manager') || hasRole('admin');
const getUser = id => (state.boot?.users || []).find(user => Number(user.id) === Number(id));
const userName = id => getUser(id)?.name || (id ? `Участник #${id}` : '—');
const getTag = id => (state.boot?.tags || []).find(tag => Number(tag.id) === Number(id));
const tagName = id => getTag(id)?.name || `Тег #${id}`;
const hallTags = () => (state.boot?.tags || []).filter(tag => tag.kind === 'hall');
const directionTags = () => (state.boot?.tags || []).filter(tag => tag.kind !== 'hall');
const dateText = value => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}).format(date);
};
const initials = name => String(name || '?').trim().split(/\s+/).slice(0,2).map(part=>part[0]).join('').toUpperCase();
const userAvatar = id => `<span class="avatar" title="${esc(userName(id))}">${esc(initials(userName(id)))}</span>`;
const tagList = tagIds => (tagIds || []).map(id=>`<span class="tag ${getTag(id)?.kind==='hall'?'hall':''}">${esc(tagName(id))}</span>`).join('');
const statusBadge = task => `<span class="status ${esc(task.status)}">${esc(statusNames[task.status] || task.status)}</span>`;
const isTerminal = task => ['done','cancelled'].includes(task.status);
const isParticipant = task => hasRole('admin') || [task.authorId,task.claimedBy,task.assignedBy].some(id=>Number(id)===Number(me().id));
const canWork = task => {
  if (typeof task.canWork === 'boolean') return task.canWork;
  if (hasRole('admin') || !task.hallId) return true;
  const myHalls = hasRole('manager') && me().homeHallId ? [Number(me().homeHallId)] : ids(me().tagIds).filter(id=>getTag(id)?.kind==='hall');
  return myHalls.includes(Number(task.hallId)) || !!state.boot?.settings?.crossHall;
};
function toast(message, error = false) {
  const node = $('#toast');node.textContent=message;node.className=`toast${error?' error':''}`;node.hidden=false;
  clearTimeout(toast.timer);toast.timer=setTimeout(()=>node.hidden=true,error?7000:4000);
}
async function api(path, options = {}) {
  const headers = {'Accept':'application/json',...options.headers};
  if(options.method && options.method!=='GET') {headers['Content-Type']='application/json';if(state.boot?.csrf)headers['X-CSRF-Token']=state.boot.csrf;headers['Idempotency-Key']=crypto.randomUUID();}
  const response = await fetch(path,{credentials:'same-origin',...options,headers,body:options.body===undefined?undefined:JSON.stringify(options.body)});
  let result;try{result=await response.json();}catch{result={error:'Сервер вернул непонятный ответ. Попробуйте ещё раз.'};}
  if(!response.ok){if(response.status===401 && state.boot && currentSession()){state.boot=null;closeModal();renderLogin('Сессия завершилась. Войдите снова.');}throw new Error(result.error || 'Не удалось выполнить действие');}
  return result;
}
const post = (path, body={}) => api(path,{method:'POST',body});
function empty(title,description,action='') {return `<div class="empty"><div class="empty-icon">${icon('inbox')}</div><h3>${esc(title)}</h3><p>${esc(description)}</p>${action}</div>`;}
function titleForView() {
  if(state.view==='tasks')return state.scope==='mine'?'Мои задачи':state.scope==='home'?`Мой холл · ${tagName(me().homeHallId)}`:state.scope==='hall'?tagName(state.hallId):state.tagId?tagName(state.tagId):'Все задачи';
  return {questions:{incoming:'Входящие вопросы',outgoing:'Исходящие вопросы',volunteer:'Вопросы волонтёров',unaddressed:'Вопросы без тегов'}[state.box],volunteers:'Мои волонтёры',halls:'Холлы мероприятия',admin:'Управление NERC',deliveries:'Доставка в Telegram',account:'Мой профиль',notifications:'Уведомления'}[state.view] || 'NERC';
}
function syncPageTitle() {
 for(const selector of ['#breadcrumb-title','.page-heading h1']){const node=$(selector);if(node)node.textContent=titleForView();}
}
function tagFilterOptions() {return `<option value="">Все теги</option>${(state.boot.tags||[]).map(tag=>`<option value="${tag.id}" ${Number(state.tagId)===tag.id?'selected':''}>${esc(tag.name)}</option>`).join('')}`;}
function navButton(view,label,iconName,extra={}) {
 const active=state.view===view && Object.entries(extra).every(([key,val])=>String(state[key])===String(val));
 return `<button type="button" class="nav-button ${active?'active':''}" data-nav="${view}" ${Object.entries(extra).map(([key,val])=>`data-${key.toLowerCase()}="${esc(val)}"`).join(' ')}>${icon(iconName)}<span>${esc(label)}</span></button>`;
}
function renderLogin(error='') {
 $('#app').innerHTML=`<main class="login-page"><section class="login-story"><div class="brand"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span><div><strong>NERC</strong><small>КООРДИНАЦИЯ МЕРОПРИЯТИЯ</small></div></div><h1>Координация<br>организаторов<br>и волонтёров.</h1><p>Рабочее пространство организаторов и менеджеров. Волонтёры получают задания и отвечают через Telegram.</p><div class="login-lines"><i></i><i></i><i></i></div></section><section class="login-form-wrap"><form id="login-form" class="login-form form-stack"><div><h2>Добро пожаловать</h2><p class="muted">Войдите в рабочее пространство мероприятия</p></div><label class="field">Логин<input name="login" autocomplete="username" required autofocus placeholder="Ваш логин"></label><label class="field">Пароль<input name="password" type="password" autocomplete="current-password" required placeholder="Ваш пароль"></label>${error?`<div class="inline-error">${esc(error)}</div>`:''}<button class="button primary" type="submit">Войти в NERC ${icon('arrow')}</button><p class="login-footnote">Доступ создаёт администратор мероприятия.<br>Волонтёрам достаточно подключиться к Telegram-боту.</p></form></section></main>`;
}
function sidebarNavigation() {
 const user=me();
 return `<div class="nav-label">Рабочее пространство</div>${user.homeHallId?navButton('tasks','Мой холл','hall',{scope:'home',hallId:'',tagId:''}):''}${navButton('tasks','Все задачи','grid',{scope:'all',hallId:'',tagId:''})}${navButton('tasks','Мои задачи','check',{scope:'mine',hallId:'',tagId:''})}${canManage()?navButton('volunteers','Мои волонтёры','users'):''}<div class="nav-label">Вопросы и ответы</div>${navButton('questions','Входящие','inbox',{box:'incoming'})}${navButton('questions','Исходящие','send',{box:'outgoing'})}${canManage()?navButton('questions','От волонтёров','message',{box:'volunteer'}):''}${navButton('questions','Без тегов','message',{box:'unaddressed'})}<div class="nav-label nav-section-title">Холлы${hasRole('admin')?`<button class="nav-edit" data-nav="halls" aria-label="Редактировать холлы мероприятия">${icon('settings')}</button>`:''}</div>${hallTags().map(tag=>navButton('tasks',tag.name,'hall',{scope:'hall',hallId:tag.id,tagId:''})).join('')}<div class="nav-label">Направления</div>${directionTags().map(tag=>navButton('tasks',tag.name,'tag',{scope:'all',tagId:tag.id,hallId:''})).join('')}${canManage()?`<div class="nav-label">Управление</div>${navButton('deliveries','Доставка в Telegram','send')}`:''}${hasRole('admin')?navButton('halls','Редактировать холлы','hall')+navButton('admin','Администрирование','settings'):''}<div class="sidebar-footer"><div class="connection" id="connection">Изменения синхронизируются</div></div>`;
}
function renderShell() {
 const user=me();
 $('#app').innerHTML=`<div class="app-shell"><header class="masthead"><div class="brand"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span><div><strong>NERC</strong><small>КООРДИНАЦИЯ МЕРОПРИЯТИЯ</small></div></div><span class="masthead-label">Организаторы и волонтёры</span></header><aside class="sidebar" id="sidebar">${sidebarNavigation()}</aside><main class="main"><header class="topbar"><button class="icon-button mobile-menu" data-action="menu" aria-label="Открыть навигацию">${icon('menu')}</button><div class="breadcrumb">NERC <span>/</span> <strong id="breadcrumb-title">${esc(titleForView())}</strong></div><div class="top-right"><button class="icon-button" data-nav="notifications" aria-label="Уведомления">${icon('bell')}</button><button class="profile" data-nav="account"><span class="avatar">${esc(initials(user.name))}</span><span><span class="profile-name">${esc(user.name)}</span><span class="profile-role">${esc((user.roles || []).map(role=>roleNames[role]).join(' · '))}</span></span></button><button class="icon-button" data-action="logout" aria-label="Выйти">${icon('logout')}</button></div></header><div id="page" class="page"></div></main></div>`;
 renderPage();
}
function renderPage() {
 $('#breadcrumb-title').textContent=titleForView();
 const subtitles={tasks:state.scope==='home'?'Основная рабочая очередь вашего холла':state.scope==='hall'?'Отдельная очередь холла · назначения и выполнение независимы':state.scope==='mine'?'Задачи, которые вы создали, взяли в работу или передали волонтёрам':'Общая очередь организаторов и волонтёров мероприятия',questions:'Один вопрос — одно обсуждение. Ответы сохраняются в общей истории.',volunteers:'Доступность, текущие задачи и личные теги вашего пула',halls:'Создание и переименование холлов мероприятия',admin:'Участники, направления, пулы и права доступа',deliveries:'Контроль отправки заданий и обновлений сообщений',account:'Доступ к рабочему пространству',notifications:'События, которым нужно ваше внимание'};
 $('#page').innerHTML=`<div class="page-heading"><div><div class="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</div><h1>${esc(titleForView())}</h1><p>${esc(subtitles[state.view] || '')}</p></div>${state.view==='tasks'?`<button class="button primary" data-action="create-task" aria-label="Создать задачу">${icon('plus')}<span class="button-label">Создать задачу</span></button>`:''}</div><div id="page-content"></div>`;
 if(state.view==='tasks')renderTasksPage();
 else if(state.view==='questions')$('#page-content').innerHTML='<div id="questions-results" class="questions-list"><div class="loading-line">Загружаем вопросы…</div></div>';
 else if(state.view==='volunteers')$('#page-content').innerHTML='<div id="volunteers-results" class="volunteer-grid"><div class="loading-line">Загружаем волонтёров…</div></div>';
 else if(state.view==='halls')renderHalls();
 else if(state.view==='admin')renderAdmin();
 else if(state.view==='account')renderAccount();
 else if(state.view==='notifications')renderNotifications();
 else if(state.view==='deliveries')$('#page-content').innerHTML='<div id="deliveries-results" class="panel"><div class="loading-line">Загружаем доставки…</div></div>';
 loadCurrent().catch(error=>toast(error.message,true));
}
function renderTasksPage() {
 const otherHall=state.scope==='hall' && me().homeHallId && Number(state.hallId)!==Number(me().homeHallId);
 $('#page-content').innerHTML=`${state.boot.telegram?.configured===false?'<div class="notice warning">Telegram-бот пока не настроен. Назначения сохраняются; для доставки администратору нужно указать токен и имя нового бота в настройках сервера.</div>':''}${otherHall?`<div class="notice ${state.boot.settings.crossHall?'':'warning'}">${state.boot.settings.crossHall?'Открыты задачи другого холла. Можно брать их в работу и назначать волонтёров из своего пула.':'Открыты задачи другого холла. Сейчас доступен просмотр; работу с другими холлами может разрешить администратор.'}</div>`:''}<div id="task-stats" class="stats"></div><section class="panel"><div class="panel-header"><h2>Очередь задач <span class="muted" id="task-count"></span></h2><small id="sync-label">Обновление каждые 4 секунды</small></div><form id="task-filters" class="filters"><label class="search">${icon('search')}<input name="q" value="${esc(state.filters.q)}" placeholder="Поиск по названию и описанию" aria-label="Поиск задач"></label><select name="status" aria-label="Статус"><option value="">Все статусы</option>${Object.entries(statusNames).map(([key,name])=>`<option value="${key}" ${state.filters.status===key?'selected':''}>${name}</option>`).join('')}</select><select name="assignment" aria-label="Назначения"><option value="">Все назначения</option><option value="free" ${state.filters.assignment==='free'?'selected':''}>Без назначений</option><option value="assigned" ${state.filters.assignment==='assigned'?'selected':''}>С назначениями</option><option value="waiting" ${state.filters.assignment==='waiting'?'selected':''}>Ожидают принятия</option></select><select name="tagId" aria-label="Общий тег">${tagFilterOptions()}</select><span class="filter-advanced"><label class="toggle-filter"><input type="checkbox" name="blocked" ${state.filters.blocked?'checked':''}>Заблокированы</label><label class="toggle-filter"><input type="checkbox" name="openQuestions" ${state.filters.openQuestions?'checked':''}>Есть вопросы</label></span></form><div id="tasks-results"></div><div class="table-note"><span>Назначение волонтёрам ещё не означает начало выполнения</span><span>Единая очередь · веб + Telegram</span></div></section>`;
 renderTaskResults();
}
function taskParticipants(task) {
 if(task.claimedBy)return `<div class="people">${userAvatar(task.claimedBy)}<span>${esc(userName(task.claimedBy))}</span></div>`;
 const volunteers=(task.assignments || []).map(assignment=>assignment.volunteerId ?? assignment.userId);
 if(!volunteers.length)return '<span class="free-label">Нет назначений</span>';
 return `<div class="people"><span class="avatar-stack">${volunteers.slice(0,3).map(userAvatar).join('')}</span><span>${volunteers.length===1?esc(userName(volunteers[0])):`${volunteers.length} ${volunteers.length<5?'волонтёра':'волонтёров'}`}</span></div>`;
}
function renderTaskResults() {
 if(!$('#tasks-results'))return;
 const tasks=state.tasks;
 $('#task-count').textContent=`· ${tasks.length}`;
 const stat=(label,count,ico,color,hint)=>`<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-number">${count}</div><div class="stat-hint">${esc(hint)}</div><div class="stat-icon ${color}">${icon(ico)}</div></div>`;
 $('#task-stats').innerHTML=stat('В очереди',tasks.filter(task=>task.status==='queued').length,'list','amber','Ожидают начала работы')+stat('В процессе',tasks.filter(task=>task.status==='in_progress').length,'clock','','Выполняются прямо сейчас')+stat('Требуют внимания',tasks.filter(task=>task.blocked).length,'alert','red','Есть блокирующие вопросы')+stat('Выполнено',tasks.filter(task=>task.status==='done').length,'check','green','Работа завершена');
 if(!tasks.length){$('#tasks-results').innerHTML=empty('В этой очереди пока нет задач','Создайте первую задачу или измените фильтры. Новые назначения появятся здесь автоматически.');return;}
 $('#tasks-results').innerHTML=`<div class="overflow-table"><table class="task-table"><thead><tr><th>Задача</th><th class="hall-column">Направление</th><th>Участники</th><th>Статус</th><th class="created-column">Обновление</th></tr></thead><tbody>${tasks.map(task=>`<tr class="${task.blocked?'blocked-row':''}" data-open-task="${Number(task.id)}"><td><div class="task-code">#${String(task.id).padStart(3,'0')}</div><button class="task-title task-title-button" data-open-task="${Number(task.id)}">${esc(task.title)}</button><div class="task-subtitle">${task.hallId?`<span>${esc(tagName(task.hallId))}</span>`:''}${task.openQuestions?`<span>· ${typeof task.openQuestions==='number'?task.openQuestions:''} открытых вопросов</span>`:''}</div></td><td class="hall-column"><div class="tag-list">${tagList(task.tagIds?.length?task.tagIds:task.hallId?[task.hallId]:[]) || '<span class="muted">Без тегов</span>'}</div></td><td class="people-column">${taskParticipants(task)}</td><td class="status-column"><div class="status-stack">${task.blocked?'<span class="status blocked">Заблокирована</span>':''}${statusBadge(task)}${task.awaitingAcceptance?'<span class="status waiting">Ожидает принятия</span>':''}</div></td><td class="created-column"><small>${esc(dateText(task.updatedAt || task.createdAt))}</small></td></tr>`).join('')}</tbody></table></div>`;
}
async function loadCurrent() {
 if(!state.boot)return;
 if(state.view==='tasks'){
  const params=new URLSearchParams({scope:state.scope});
  if(state.hallId)params.set('hallId',state.hallId);if(state.tagId)params.set('tagId',state.tagId);
  for(const [key,value]of Object.entries(state.filters))if(value)params.set(key,typeof value==='boolean'?'1':value);
  const viewKey=`${state.view}:${state.scope}:${state.hallId}:${state.tagId}`;
  const revision=state.taskLoadRevision=(state.taskLoadRevision||0)+1;
  const result=await api(`/api/tasks?${params}`);
  if(revision!==state.taskLoadRevision || viewKey!==`${state.view}:${state.scope}:${state.hallId}:${state.tagId}`)return;
  state.tasks=listFrom(result,'tasks');renderTaskResults();syncPageTitle();
 } else if(state.view==='questions'){
  const box=state.box;const result=await api(`/api/questions?box=${encodeURIComponent(box)}`);if(state.view!=='questions'||state.box!==box)return;
  state.questions=listFrom(result,'questions');if(!hasQuestionDraft($('#page-content')) && (!$('#page-content')?.contains(document.activeElement) || !document.activeElement.matches('input,textarea,select')))renderQuestionResults();
 } else if(state.view==='volunteers'){
  const result=await api('/api/volunteers');if(state.view!=='volunteers')return;state.volunteers=listFrom(result,'volunteers');renderVolunteers();
 } else if(state.view==='notifications'){
  renderNotifications();
 } else if(state.view==='halls'){
  renderHalls();
 } else if(state.view==='admin'&&!$('#modal').open&&!$('#cross-hall-form')?.dataset.dirty){
  renderAdmin();
 } else if(state.view==='deliveries'){
  const result=await api('/api/deliveries');if(state.view!=='deliveries')return;state.deliveries=listFrom(result,'deliveries');renderDeliveries();
 }
}
function navigate(view, options={}) {
 closeModal();state.view=view;Object.assign(state,options);$('#sidebar')?.classList.remove('open');renderShell();
}
function modalContext() {
 const epoch=state.modalEpoch,currentSession=sessionContext();
 return ()=>epoch===state.modalEpoch&&currentSession();
}
function beginModalRequest(){state.modalEpoch++;return modalContext();}
function showModal(type,html,preserveRequest=false) {
 if(!preserveRequest)state.modalEpoch++;
 const modal=$('#modal');state.modalType=type;modal.className='modal';modal.innerHTML=html;if(!modal.open)modal.showModal();
}
function closeModal(){state.modalEpoch++;const modal=$('#modal');if(modal.open)modal.close();state.modalType=null;state.detailId=null;state.detail=null;}
const modalHead=(title,subtitle='')=>`<div class="modal-head"><div><h2>${esc(title)}</h2>${subtitle?`<small>${esc(subtitle)}</small>`:''}</div><button type="button" class="icon-button" data-action="close-modal" aria-label="Закрыть">${icon('close')}</button></div>`;
function checkTags(name,selected=[],tags=state.boot.tags){return tags.map(tag=>`<label class="check-pill"><input type="checkbox" name="${name}" value="${Number(tag.id)}" ${ids(selected).includes(Number(tag.id))?'checked':''}>${esc(tag.name)}</label>`).join('');}
function selectedValues(form,name){return $$(`[name="${name}"]:checked`,form).map(input=>Number(input.value));}
function showCreateTask() {
 showModal('create-task',`${modalHead('Новая задача','Опишите результат и выберите, где нужно выполнить задачу')}<form id="create-task-form" class="modal-body form-stack"><label class="field">Название задачи<input name="title" required maxlength="250" placeholder="Что нужно сделать?"></label><label class="field">Описание<textarea name="description" rows="4" maxlength="15000" placeholder="Место, время и подробности, которые помогут исполнителям"></textarea></label><div class="field-group"><label class="field">Холлы<small>Для каждого выбранного холла создаётся отдельное выполнение со своим статусом.</small></label><label class="check-line" style="margin-bottom:12px"><input name="allHalls" type="checkbox">Все холлы</label><div class="check-grid">${checkTags('hallIds',[],hallTags())}</div></div><div class="field"><span>Общие теги направлений</span><div class="check-grid">${checkTags('tagIds',[],directionTags())}</div><small>Без тегов задача попадёт в общую очередь.</small></div><div class="modal-footer"><button type="button" class="button secondary" data-action="close-modal">Отмена</button><button class="button primary" type="submit">${icon('plus')}Опубликовать задачу</button></div></form>`);
}
async function openTask(id) {
 state.detailId=Number(id);state.modalType='task';showModal('task',`${modalHead('Загружаем задачу…')}<div class="loading-line">Получаем актуальные данные</div>`);
 const current=beginModalRequest();const result=await api(`/api/tasks/${Number(id)}`);
 if(!current()||state.detailId!==Number(id))return false;state.detail=result.task || result;renderTaskDetail();return true;
}
function historyDetail(entry) {
 const data=entry.data || {};const parts=[];
 if(data.reason || entry.reason)parts.push(esc(data.reason || entry.reason));
 if(data.volunteerIds?.length)parts.push('Назначены: '+data.volunteerIds.map(userName).map(esc).join(', '));
 if(data.previousVolunteerIds?.length)parts.push('Прежние назначения: '+data.previousVolunteerIds.map(userName).map(esc).join(', '));
 if(data.questionId)parts.push('Вопрос #'+Number(data.questionId));
 return parts.length?`<div class="muted">${parts.join('<br>')}</div>`:'';
}
function renderTaskDetail() {
 const task=state.detail;if(!task||state.modalType!=='task')return;
 const working=canWork(task);const free=task.status==='queued'&&!task.claimedBy&&!(task.assignments||[]).length;
 const canCancel=task.canCancel ?? (!isTerminal(task)&&isParticipant(task)&&working);
 const canReset=!task.blocked&&(task.canReset ?? canCancel);
 const canFinish=working && !task.blocked && task.status==='in_progress' && Number(task.claimedBy)===Number(me().id);
 const participants=task.assignments || [];
 const siblings=task.siblings || [];
 const history=task.history || [];
 const questions=task.questions || [];
 const canQuestion=isParticipant(task);
 showModal('task',`${modalHead(task.title,`Задача #${task.id}${task.hallId?' · '+tagName(task.hallId):' · Общая очередь'}`)}<div class="modal-body"><div class="tag-list">${task.blocked?'<span class="status blocked">Заблокирована</span>':''}${statusBadge(task)}${task.awaitingAcceptance?'<span class="status waiting">Ожидает принятия волонтёрами</span>':''}${tagList(task.tagIds)}</div><div class="detail-description">${esc(task.description || 'Описание не добавлено.')}</div><div class="detail-meta"><div><small>Автор задачи</small>${esc(userName(task.authorId))}</div><div><small>Создана</small>${esc(dateText(task.createdAt))}</div><div><small>${task.claimedBy?'Взял в работу':'Назначил волонтёров'}</small>${esc(userName(task.claimedBy || task.assignedBy))}</div><div><small>Выполнение</small>${task.hallId?esc(tagName(task.hallId)):'Общая задача'}</div></div>${!working&&!isTerminal(task)?`<div class="notice warning">Работа с задачами этого холла отключена администратором. Доступен просмотр.</div>`:''}<div class="actions">${free&&working?`<button class="button primary" data-task-action="claim" data-id="${task.id}">${icon('check')}Взять в работу</button>${canManage()?`<button class="button secondary" data-action="assign" data-id="${task.id}">${icon('users')}Назначить волонтёров</button>`:''}`:''}${canFinish?`<button class="button primary" data-task-action="complete" data-id="${task.id}">${icon('check')}Завершить задачу</button>`:''}${canReset?`<button class="button secondary" data-action="reset-task" data-id="${task.id}">${icon('refresh')}Вернуть в очередь</button>`:''}${canCancel?`<button class="button danger" data-action="cancel-task" data-id="${task.id}">Отменить</button>`:''}</div>${siblings.length>1?`<div class="section-label">Выполнение по холлам</div><div class="siblings">${siblings.map(sibling=>`<button class="sibling ${Number(sibling.id)===Number(task.id)?'current':''}" data-open-task="${sibling.id}"><span>${esc(sibling.hallId?tagName(sibling.hallId):'Общая')}</span>${statusBadge(sibling)}${sibling.blocked?icon('alert'):''}</button>`).join('')}</div>`:''}<div class="section-label">Назначенные волонтёры · ${participants.length}</div>${participants.length?participants.map(assignment=>`<div class="select-person" style="cursor:default">${userAvatar(assignment.volunteerId)}<div class="person-info"><strong>${esc(userName(assignment.volunteerId))}</strong><p>${assignment.acceptedAt?'Начал выполнение · '+esc(dateText(assignment.acceptedAt)):isTerminal(task)?'Задача завершена':'Задание назначено, ожидается принятие'}</p></div>${isTerminal(task)?statusBadge(task):assignment.acceptedAt?'<span class="status in_progress">Начал выполнение</span>':''}</div>`).join(''):'<p class="muted" style="font-size:12px">Волонтёры не назначены.</p>'}<div class="section-label">Вопросы по задаче · ${questions.length}</div>${questions.length?questions.map(renderDiscussion).join(''):'<p class="muted" style="font-size:12px">Вопросов пока нет.</p>'}${canQuestion&&!isTerminal(task)?`<details class="question-form"><summary>+ Задать вопрос по задаче</summary><form id="new-question-form" class="form-stack" data-task-id="${task.id}"><label class="field">Вопрос<textarea name="body" required maxlength="10000" placeholder="Что нужно уточнить?"></textarea></label><div class="field"><span>Получатели</span><div class="check-grid">${checkTags('tagIds')}</div><small>Рекомендуем выбрать направления. Без тегов вопрос попадёт в общую очередь вопросов.</small></div><div class="form-row"><label class="check-line"><input type="checkbox" name="blocking">Блокирует выполнение</label><label class="field">Срочность<select name="urgency"><option value="normal">Обычная</option><option value="urgent">Срочная</option></select></label></div><div class="modal-footer"><button class="button primary" type="submit">${icon('send')}Отправить вопрос</button></div></form></details>`:''}<div class="section-label">История изменений</div>${history.length?`<ol class="history">${history.slice().reverse().map(entry=>`<li>${esc(eventNames[entry.event || entry.action] || entry.event || entry.action || 'Изменение задачи')}${entry.actorId?` · ${esc(userName(entry.actorId))}`:''}${historyDetail(entry)}<small>${esc(dateText(entry.createdAt))}</small></li>`).join('')}</ol>`:'<p class="muted" style="font-size:12px">История пока пуста.</p>'}</div>`,true);
}
function questionCanReply(question){return question.state!=='closed';}
function renderDiscussion(question) {
 const messages=question.messages || [];
 const controller=Number(question.controllerId)===Number(me().id);
 const canForward=question.source==='volunteer'&&controller&&!question.forwarded&&question.state!=='closed';
 const expected=question.state==='closed'?'Вопрос решён':question.state==='answered'?`Ожидает подтверждения решения · ${userName(question.controllerId)}`:question.source==='volunteer'&&!question.forwarded?`Ожидает ответа менеджера · ${userName(question.controllerId)}`:question.tagIds?.length?'Ожидает ответа получателей':'Ожидает ответа в общей очереди';
 return `<article class="discussion" data-question="${question.id}"><div class="discussion-head"><div><h3>Вопрос #${question.id} · ${esc(userName(question.askedBy))}${question.taskId&&state.view==='questions'?` <button class="muted-link" data-open-task="${question.taskId}">к задаче #${question.taskId}</button>`:''}</h3><div class="discussion-tags">${question.blocking?'<span class="status blocked">Блокирует работу</span>':'<span class="tag">Не блокирует</span>'}${question.urgency==='urgent'?'<span class="tag" style="background:#fff0f1;color:#ba4c5a">Срочно</span>':''}${tagList(question.tagIds) || `<span class="tag">${question.source==='volunteer'&&!question.forwarded?'Менеджеру':'Без тегов'}</span>`}</div></div><span class="status ${esc(question.state)}">${{open:'Ожидает ответа',answered:'Есть ответ',closed:'Решён'}[question.state] || esc(question.state)}</span></div><div class="discussion-body">${messages.length?messages.map(message=>`<div class="thread-message"><div class="message-meta"><strong>${esc(userName(message.authorId))}</strong><span>${esc(dateText(message.createdAt))}</span></div><div class="message-body">${esc(message.body)}</div></div>`).join(''):`<div class="message-body">${esc(question.body || '')}</div>`}</div><div class="discussion-expectation">${esc(expected)}${question.recipientIds?.length?(question.recipientIds.length>8?`<details><summary>Получатели: ${question.recipientIds.length}</summary>${question.recipientIds.map(userName).map(esc).join(', ')}</details>`:`<br>Получатели: ${question.recipientIds.map(userName).map(esc).join(', ')}`):''}</div>${questionCanReply(question)?`<form class="reply-form" data-reply-id="${question.id}"><textarea name="body" placeholder="Ответить в обсуждении…" aria-label="Ответ на вопрос #${question.id}" maxlength="10000"></textarea><div class="reply-buttons"><button class="button primary small" type="submit">${icon('send')}Ответить</button>${controller?`<button class="button secondary small" type="button" data-action="close-question" data-id="${question.id}">${icon('check')}Подтвердить решение</button>`:''}${canForward?`<button class="button secondary small" type="button" data-action="forward-question" data-id="${question.id}">${icon('arrow')}Передать направлениям</button>`:''}</div>${question.source==='volunteer'&&controller?'<small style="display:block;margin-top:8px">Ответ будет доставлен волонтёру через Telegram.</small>':''}</form>`:''}</article>`;
}
function renderQuestionResults() {
 const target=$('#questions-results');if(!target)return;
 target.innerHTML=state.questions.length?state.questions.map(renderDiscussion).join(''):empty('Новых вопросов нет',{incoming:'Здесь появятся вопросы, адресованные вашим общим тегам.',outgoing:'Вопросы, которые вы задали или передали направлениям, появятся здесь.',volunteer:'Вопросы волонтёров вашего пула поступают сюда из Telegram.',unaddressed:'Вопросы без выбранных тегов получателей появятся в этой общей очереди.'}[state.box]);
}
function volunteerTaskList(volunteer){return volunteer.tasks || volunteer.currentTasks || [];}
function personalNames(volunteer){return volunteer.personalTags?.map(tag=>typeof tag==='string'?tag:tag.name) || (volunteer.personalTagIds||[]).map(id=>state.boot.personalTags?.find(tag=>Number(tag.id)===Number(id))?.name).filter(Boolean) || [];}
function renderVolunteers() {
 const target=$('#volunteers-results');if(!target)return;
 target.innerHTML=state.volunteers.length?state.volunteers.map(volunteer=>{
  const tasks=volunteerTaskList(volunteer);const free=volunteer.available!==false&&volunteer.available!==0&&!tasks.length;
  return `<article class="volunteer-card"><div class="volunteer-heading"><span class="avatar">${esc(initials(volunteer.name))}</span><div><h3>${esc(volunteer.name)}</h3><div class="availability ${!volunteer.available?'unavailable':''}">${!volunteer.available?'Недоступен':free?'Свободен':'Доступен · занят'}</div></div></div><div class="tag-list">${personalNames(volunteer).map(name=>`<span class="tag">${esc(name)}</span>`).join('') || '<small>Нет личных тегов</small>'}</div><div class="volunteer-tasks">${tasks.length?tasks.map(task=>`<button data-open-task="${task.id}">#${task.id} ${esc(task.title)}${task.status==='queued'?' · ожидает принятия':''}</button>`).join(''):'Нет незавершённых задач'}</div><div><small>${volunteer.telegramId?'Telegram подключён':'Telegram ещё не подключён'}</small></div><div class="volunteer-actions">${Number(volunteer.managerId)===Number(me().id)?`<button class="button ghost small" data-action="personal-tags" data-id="${volunteer.id}">${icon('tag')}Личные теги</button>`:''}<button class="button secondary small" data-action="connect-volunteer" data-id="${volunteer.id}" ${volunteer.telegramId?'disabled':''}>${icon('send')}${volunteer.telegramId?'Telegram подключён':'Подключить Telegram'}</button></div></article>`;
 }).join(''):empty('Пул пока не настроен','Администратор добавляет волонтёров и закрепляет их за менеджерами. После этого они появятся здесь.');
}
function renderDeliveries() {
 const target=$('#deliveries-results');if(!target)return;
 target.innerHTML=state.deliveries.length?state.deliveries.map(delivery=>`<div class="delivery"><span class="status ${delivery.status==='sent'?'done':delivery.status==='failed'?'blocked':'waiting'}">${{sent:'Отправлено',pending:'В очереди',failed:'Ошибка',processing:'Отправляется',cancelled:'Отменено'}[delivery.status] || esc(delivery.status)}</span><div class="delivery-text"><strong>${esc(userName(delivery.userId ?? delivery.user_id))}</strong>${delivery.taskId||delivery.task_id?` · <button class="muted-link" data-open-task="${Number(delivery.taskId??delivery.task_id)}">Задача #${Number(delivery.taskId??delivery.task_id)}</button>`:''}<p>${esc(delivery.error || delivery.lastError || delivery.last_error || (delivery.kind==='task'?'Обновление карточки задания':'Сообщение волонтёру'))}</p><small>Попыток: ${Number(delivery.attempts || 0)} · ${esc(dateText(delivery.createdAt || delivery.created_at))}</small></div>${['failed','pending'].includes(delivery.status)?`<button class="button secondary small" data-action="retry-delivery" data-id="${delivery.id}">${icon('refresh')}Повторить</button>`:''}</div>`).join(''):empty('Отправок пока нет','После назначения волонтёров здесь появятся задания и обновления Telegram. Ошибки доставки не отменяют назначение.');
}
function renderAdmin() {
 const users=state.boot.users || [];
 $('#page-content').innerHTML=`<div class="admin-layout"><section class="panel admin-panel"><div class="section-toolbar"><h2>Участники мероприятия</h2><button class="button primary small" data-action="edit-user">${icon('plus')}Добавить</button></div>${users.map(user=>`<div class="admin-user"><span class="avatar">${esc(initials(user.name))}</span><div class="admin-user-info"><strong>${esc(user.name)}${user.active===false?' · отключён':''}</strong><small>${esc((user.roles || []).map(role=>roleNames[role]).join(' · '))}${user.managerId?' · менеджер: '+esc(userName(user.managerId)):''}</small><div class="tag-list" style="margin-top:6px">${tagList(user.tagIds)}</div></div><button class="button secondary small" data-action="edit-user" data-id="${user.id}">Изменить</button></div>`).join('')}</section><div><section class="panel admin-panel"><div class="section-toolbar"><h2>Холлы мероприятия</h2><button class="button secondary small" data-nav="halls">Редактировать холлы</button></div><p class="field-hint">Холлов: ${hallTags().length}. Добавляйте и переименовывайте холлы в отдельном разделе.</p></section><section class="panel admin-panel" style="margin-top:16px"><h2>Работа с другими холлами</h2><form id="cross-hall-form" class="form-stack"><label class="check-line"><input type="checkbox" name="crossHall" ${state.boot.settings.crossHall?'checked':''}>Разрешить работу с задачами других холлов</label><p class="field-hint">При выключенном флаге задачи других холлов доступны для просмотра. При включённом менеджеры могут брать их в работу и назначать свой пул.</p><div><button class="button primary small" type="submit">Сохранить настройку</button></div></form></section><section class="panel admin-panel" style="margin-top:20px"><div class="section-toolbar"><h2>Теги направлений</h2><button class="button secondary small" data-action="edit-tag">${icon('plus')}Добавить</button></div><p class="field-hint">Общие направления для задач и вопросов. Личные теги менеджеров хранятся отдельно.</p><div style="margin-top:14px">${directionTags().map(tag=>`<div class="admin-user"><div class="admin-user-info"><strong>${esc(tag.name)}</strong><small>${tag.kind==='hall'?'Холл · отдельный статус выполнения':'Направление'}</small></div><button class="button ghost small" data-action="edit-tag" data-id="${tag.id}">Изменить</button></div>`).join('')}</div></section></div></div>`;
}
function showUserForm(id) {
 const user=id?getUser(id):{roles:['volunteer'],tagIds:[],active:true};
 if(!user)return;
 showModal('edit-user',`${modalHead(id?'Изменить участника':'Новый участник','Роли могут совмещаться. Волонтёр работает через Telegram.')}<form id="user-form" class="modal-body form-stack" data-user-id="${id||''}"><div class="form-row"><label class="field">Имя<input name="name" required maxlength="160" value="${esc(user.name)}"></label><label class="field">Логин для веба<input name="login" maxlength="100" value="${esc(user.login)}" autocomplete="off"><small>Нужен организаторам, менеджерам и администраторам.</small></label></div><label class="field">${id?'Новый пароль':'Пароль для веба'}<input name="password" type="password" minlength="12" autocomplete="new-password" placeholder="${id?'Оставьте пустым, чтобы сохранить пароль':'Не менее 12 символов'}"></label><div class="field"><span>Возможности</span><div class="check-grid">${Object.entries(roleNames).map(([role,name])=>`<label class="check-pill"><input type="checkbox" name="roles" value="${role}" ${(user.roles||[]).includes(role)?'checked':''}>${esc(name)}</label>`).join('')}</div></div><div class="field"><span>Общие теги</span><div class="check-grid">${checkTags('tagIds',user.tagIds)}</div></div><div class="form-row"><label class="field">Основной холл<select name="homeHallId"><option value="">Не назначен</option>${hallTags().map(tag=>`<option value="${tag.id}" ${Number(user.homeHallId)===Number(tag.id)?'selected':''}>${esc(tag.name)}</option>`).join('')}</select></label><label class="field">Менеджер волонтёра<select name="managerId"><option value="">Не закреплён</option>${state.boot.users.filter(candidate=>(candidate.roles||[]).includes('manager')&&Number(candidate.id)!==Number(id)).map(candidate=>`<option value="${candidate.id}" ${Number(user.managerId)===Number(candidate.id)?'selected':''}>${esc(candidate.name)}</option>`).join('')}</select></label></div><label class="check-line"><input type="checkbox" name="active" ${user.active!==false&&user.active!==0?'checked':''}>Доступ активен</label><div class="modal-footer"><button type="button" class="button secondary" data-action="close-modal">Отмена</button><button type="submit" class="button primary">Сохранить участника</button></div></form>`);
}
function renderHalls() {
 if(!hasRole('admin')){$('#page-content').innerHTML=empty('Доступ ограничен','Холлами управляет администратор сервиса.');return;}
 const halls=hallTags();
 $('#page-content').innerHTML=`<section class="panel halls-panel"><div class="panel-header"><div><h2>Холлы мероприятия <span class="muted">· ${halls.length}</span></h2><p class="field-hint">Названия используются в очередях, задачах и профилях участников.</p></div><button class="button primary" data-action="edit-hall">${icon('plus')}Добавить холл</button></div><div class="hall-grid">${halls.map(hall=>{const managers=state.boot.users.filter(user=>user.active&&user.roles.includes('manager')&&Number(user.homeHallId)===hall.id);return `<article class="hall-card"><div class="hall-card-head"><span class="hall-symbol">${icon('hall')}</span><h3>${esc(hall.name)}</h3><button class="button secondary small" data-action="edit-hall" data-id="${hall.id}" aria-label="Изменить ${esc(hall.name)}">Изменить</button></div><p>${managers.length?'Менеджеры: '+managers.map(user=>esc(user.name)).join(', '):'Основной менеджер не назначен'}</p><button class="muted-link" data-nav="tasks" data-scope="hall" data-hallid="${hall.id}" data-tagid="">Открыть очередь ${icon('arrow')}</button></article>`;}).join('')||empty('Холлы пока не добавлены','Добавьте первый холл, чтобы назначать его участникам и публиковать задачи.')}</div><div class="table-note">Переименование сохраняет задачи, назначения, пользователей и историю холла.</div></section>`;
}
function showTagForm(id, kind='direction') {
 const tag=id?getTag(id):{name:'',kind};
 if(!tag)return;
 const hall=tag.kind==='hall';
 showModal('edit-tag',`${modalHead(hall?(id?'Изменить холл':'Новый холл'):(id?'Изменить общий тег':'Новый общий тег'),hall?(id?'Название изменится во всех очередях и карточках. Связи с задачами и людьми сохранятся.':'Холл появится в очередях, задачах и выборе основного холла участника.'):'Общее направление для участников, задач и вопросов.')}<form id="tag-form" data-tag-id="${id||''}" class="modal-body form-stack"><input type="hidden" name="kind" value="${esc(tag.kind)}"><label class="field">${hall?'Название холла':'Название тега'}<input name="name" value="${esc(tag.name)}" required maxlength="80" placeholder="${hall?'Например, Hall 6':'Например, Трансфер'}" autofocus></label><div class="modal-footer"><button type="button" class="button secondary" data-action="close-modal">Отмена</button><button class="button primary" type="submit">${hall?'Сохранить холл':'Сохранить тег'}</button></div></form>`);
}
function renderAccount() {
 $('#page-content').innerHTML=`<section class="panel account-panel"><h2>Изменить пароль</h2><form id="password-form" class="form-stack" style="margin-top:22px"><label class="field">Текущий пароль<input type="password" name="currentPassword" required autocomplete="current-password"></label><label class="field">Новый пароль<input type="password" name="password" required minlength="12" autocomplete="new-password"><small>Не менее 12 символов.</small></label><button class="button primary" type="submit">Сохранить новый пароль</button></form><div class="admin-block"><button class="button secondary" data-action="logout">${icon('logout')}Выйти из NERC</button></div></section>`;
}
function renderNotifications() {
 const notifications=state.boot.notifications || [];
 $('#page-content').innerHTML=`<section class="panel admin-panel">${notifications.length?`<ul class="notification-list">${notifications.slice().reverse().map(notification=>`<li><p>${esc(notification.text || notification.body || notification.message || 'Обновление обсуждения')}</p><small>${esc(dateText(notification.createdAt || notification.created_at))}</small>${notification.taskId?` <button class="muted-link" data-open-task="${notification.taskId}">${notification.questionId?'Открыть вопрос #'+notification.questionId:'Открыть задачу #'+notification.taskId}</button>`:notification.questionId?` <button class="muted-link" data-action="open-question" data-id="${notification.questionId}">Открыть вопрос #${notification.questionId}</button>`:''}</li>`).join('')}</ul>`:empty('Новых уведомлений нет','Вопросы и обновления, адресованные вам, появятся здесь.')}</section>`;
}
async function showAssignment(taskId) {
 const current=beginModalRequest();const result=await api('/api/volunteers');if(!current())return;state.volunteers=listFrom(result,'volunteers');
 const pool=state.volunteers.filter(volunteer=>Number(volunteer.managerId)===Number(me().id));
 state.assignmentTaskId=Number(taskId);state.assignmentPreview=[];state.previewRevision=0;
 showModal('assignment',`${modalHead('Назначить волонтёров',`Задача #${taskId} · выберите людей из своего пула`)}<form id="assignment-form" class="modal-body form-stack" data-task-id="${taskId}">${pool.length?'':`<div class="notice warning">Ваш пул пока пуст. Администратор может закрепить за вами волонтёров. Для назначения используется только ваш собственный пул.</div>`}<div class="form-row"><label class="field">Способ выбора<select name="mode"><option value="manual">Выбрать людей вручную</option><option value="free">Все свободные</option><option value="all">Весь мой пул</option></select></label><div class="field"><span>Личные теги</span><div class="check-grid">${(state.boot.personalTags||[]).map(tag=>`<label class="check-pill"><input type="checkbox" name="personalTagIds" value="${tag.id}">${esc(tag.name)}</label>`).join('') || '<small>Теги можно добавить в разделе волонтёров</small>'}</div></div></div><div><div class="section-label" style="margin-top:0">Люди в вашем пуле · ${pool.length}</div><div id="assignment-candidates">${pool.map(volunteer=>renderVolunteerChoice(volunteer)).join('')}</div></div><div><div class="preview-summary"><strong>Получат задание: <span id="preview-count">0</span></strong><small>Список перед отправкой</small></div><div id="assignment-preview"><p class="field-hint">Выберите людей, личные теги или способ массового назначения.</p></div></div><div class="notice" style="margin:0">Назначенная задача делает волонтёра занятым сразу. Можно назначить несколько задач одному человеку; недоступность и текущие задачи показаны выше.</div><div class="modal-footer"><button type="button" class="button secondary" data-action="close-modal">Отмена</button><button class="button primary" type="submit" id="assign-submit" disabled>${icon('send')}Отправить задание</button></div></form>`);
}
function renderVolunteerChoice(volunteer,preview=false) {
 const tasks=volunteerTaskList(volunteer);const free=volunteer.free ?? (volunteer.available&&!tasks.length);
 return `<label class="select-person">${preview?`<span class="avatar">${esc(initials(volunteer.name))}</span>`:`<input name="volunteerIds" type="checkbox" value="${volunteer.id}">`}<span class="person-info"><strong>${esc(volunteer.name)}</strong><p class="${!volunteer.available?'warning':''}">${!volunteer.available?'Недоступен':free?'Доступен · свободен':`Доступен · задач: ${tasks.length}`}${!volunteer.telegramId?' · Telegram не подключён':''}</p>${tasks.length?`<p>${tasks.map(task=>`#${task.id} ${esc(task.title)}${task.status==='queued'?' (ожидает принятия)':''}`).join('<br>')}</p>`:''}${personalNames(volunteer).length?`<p>${personalNames(volunteer).map(esc).join(' · ')}</p>`:''}</span></label>`;
}
async function refreshAssignmentPreview() {
 const form=$('#assignment-form');if(!form)return;
 const revision=++state.previewRevision;$('#assign-submit').disabled=true;
 const result=await post('/api/volunteers/preview',{mode:form.elements.mode.value,volunteerIds:selectedValues(form,'volunteerIds'),personalTagIds:selectedValues(form,'personalTagIds')});
 if(state.modalType!=='assignment'||revision!==state.previewRevision||$('#assignment-form')!==form)return;
 state.assignmentPreview=listFrom(result,'volunteers');$('#preview-count').textContent=state.assignmentPreview.length;
 $('#assignment-preview').innerHTML=state.assignmentPreview.length?state.assignmentPreview.map(volunteer=>renderVolunteerChoice(volunteer,true)).join(''):'<p class="field-hint">Никто не выбран. В режиме «Все свободные» недоступные и занятые волонтёры исключены.</p>';
 $('#assign-submit').disabled=!state.assignmentPreview.length;
}
function showReasonDialog(taskId,action) {
 state.returnTaskId=Number(taskId);
 const reset=action==='reset';
 showModal('task-reason',`${modalHead(reset?'Вернуть задачу в очередь':'Отменить задачу',`Задача #${taskId}`)}<form id="task-reason-form" data-task-id="${taskId}" data-task-action="${action}" class="modal-body form-stack"><div class="notice ${reset?'warning':''}">${reset?'Текущие назначения будут сняты, кнопки старых заданий перестанут действовать. После возврата задачу можно взять в работу или назначить заново.':'Выполнение больше не требуется. Назначенные волонтёры увидят отмену в Telegram.'}</div><label class="field">Причина<textarea name="reason" required maxlength="2000" placeholder="Коротко объясните изменение"></textarea></label><div class="modal-footer"><button type="button" class="button secondary" data-action="close-modal">Не менять</button><button type="submit" class="button ${reset?'primary':'danger'}">${reset?'Вернуть в очередь':'Отменить задачу'}</button></div></form>`);
}
function findQuestion(id){return [...state.questions,...(state.detail?.questions||[])].find(question=>Number(question.id)===Number(id));}
async function openQuestion(id) {
 const current=beginModalRequest();const boxes=['incoming','outgoing','unaddressed',...(canManage()?['volunteer']:[])];
 const results=await Promise.all(boxes.map(box=>api(`/api/questions?box=${box}`)));
 if(!current())return;
 const question=results.flatMap(result=>listFrom(result,'questions')).find(question=>Number(question.id)===Number(id));
 if(!question)throw new Error('Обсуждение закрыто или больше недоступно в вашей очереди.');
 if(await openTask(question.taskId))$(`[data-question="${id}"]`,$('#modal'))?.scrollIntoView({behavior:'smooth',block:'center'});
}
function showForwardQuestion(id) {
 const question=findQuestion(id);if(!question)return;
 state.returnTaskId=state.detailId;
 showModal('forward-question',`${modalHead('Передать вопрос направлениям',`Вопрос #${id} · задача #${question.taskId}`)}<form id="forward-question-form" class="modal-body form-stack" data-question-id="${id}"><div class="field"><span>Получатели</span><div class="check-grid">${checkTags('tagIds',question.tagIds)}</div><small>Совпадение хотя бы одного тега. Без тегов вопрос попадёт в общую очередь вопросов.</small></div><label class="field">Пояснение менеджера<textarea name="body" placeholder="Добавьте контекст для получателей" maxlength="10000"></textarea></label><div class="form-row"><label class="check-line"><input type="checkbox" name="blocking" ${question.blocking?'checked':''}>Блокирует выполнение</label><label class="field">Срочность<select name="urgency"><option value="normal" ${question.urgency==='normal'?'selected':''}>Обычная</option><option value="urgent" ${question.urgency==='urgent'?'selected':''}>Срочная</option></select></label></div><div class="modal-footer"><button type="button" class="button secondary" data-action="close-modal">Отмена</button><button type="submit" class="button primary">${icon('send')}Передать вопрос</button></div></form>`);
}
async function showCloseQuestion(id) {
 const question=findQuestion(id);if(!question)return;
 const current=beginModalRequest();const result=state.detail?.id===question.taskId?state.detail:await api(`/api/tasks/${Number(question.taskId)}`);
 if(!current())return;const task=result.task||result;
 const recipients=canManage()&&Number(task.assignedBy)===Number(me().id)?task.assignments||[]:[];
 state.returnTaskId=state.detailId;
 showModal('close-question',`${modalHead('Подтвердить решение вопроса',`Вопрос #${id}`)}<form id="close-question-form" class="modal-body form-stack" data-question-id="${id}"><div class="notice">Закрытие вопроса снимает только его блокировку. Другие открытые блокирующие вопросы продолжат блокировать задачу.</div><label class="field">Итоговое пояснение<textarea name="body" maxlength="10000" placeholder="Что решили? Для вопроса волонтёра пояснение уйдёт в Telegram."></textarea></label>${recipients.length?`<label class="check-line"><input type="checkbox" name="sendToVolunteers">Передать итог всем назначенным волонтёрам</label><p class="field-hint">Получатели: ${recipients.map(a=>userName(a.volunteerId)).map(esc).join(', ')}. Для рассылки заполните итоговое пояснение.</p>`:''}<div class="modal-footer"><button type="button" class="button secondary" data-action="close-modal">Отмена</button><button type="submit" class="button primary">${icon('check')}Вопрос решён</button></div></form>`);
}
function showPersonalTags(id) {
 const volunteer=state.volunteers.find(person=>Number(person.id)===Number(id));if(!volunteer)return;
 showModal('personal-tags',`${modalHead('Личные теги волонтёра',volunteer.name)}<form id="personal-tags-form" class="modal-body form-stack" data-volunteer-id="${id}"><label class="field">Теги через запятую<input name="names" value="${esc(personalNames(volunteer).join(', '))}" placeholder="Например: сцена, переноска, английский"><small>Эти теги видите только вы. Они помогают массово выбирать людей внутри вашего пула.</small></label>${state.boot.personalTags?.length?`<div class="field-hint">Ваши существующие теги: ${state.boot.personalTags.map(tag=>esc(tag.name)).join(', ')}</div>`:''}<div class="modal-footer"><button type="button" class="button secondary" data-action="close-modal">Отмена</button><button type="submit" class="button primary">Сохранить теги</button></div></form>`);
}
async function connectVolunteer(id) {
 const current=beginModalRequest();const result=await post(`/api/volunteers/${Number(id)}/link`);
 if(!current())return;const url=result.url;
 if(!/^https:\/\/t\.me\//.test(url || ''))throw new Error('Ссылка подключения пока недоступна. Проверьте настройку имени Telegram-бота.');
 showModal('volunteer-link',`${modalHead('Подключение Telegram',userName(id))}<div class="modal-body form-stack"><div class="link-result">Передайте эту личную ссылку волонтёру. Он должен открыть её в своём Telegram и нажать «Старт».<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a><small>Ссылка одноразовая. Действует до ${esc(dateText(result.expiresAt))}.</small></div><p class="field-hint">До первого сообщения волонтёра бот не сможет отправлять ему личные задания. Ссылка привязывает именно его учётную запись к выбранному участнику.</p><div class="modal-footer"><button class="button secondary" data-action="copy-link" data-url="${esc(url)}">Скопировать ссылку</button><button class="button primary" data-action="close-modal">Готово</button></div></div>`);
}
async function refreshBootstrap() {
 const currentSession=sessionContext(),previous=state.boot;const result=await api('/api/bootstrap');if(!currentSession())return;state.boot=result;
 const sidebar=$('#sidebar');
 const navigationConfig=boot=>JSON.stringify([boot?.user?.roles,boot?.user?.homeHallId,boot?.tags,boot?.settings]);
 if(navigationConfig(previous)!==navigationConfig(result)){
  if(sidebar)sidebar.innerHTML=sidebarNavigation();
  const tagFilter=$('#task-filters [name="tagId"]');if(tagFilter)tagFilter.innerHTML=tagFilterOptions();
  syncPageTitle();
 }
 const profileName=$('.profile-name'),profileRole=$('.profile-role');
 if(profileName)profileName.textContent=me().name;
 if(profileRole)profileRole.textContent=(me().roles||[]).map(role=>roleNames[role]).join(' · ');
 if((['admin','halls'].includes(state.view)&&!hasRole('admin'))||(['volunteers','deliveries'].includes(state.view)&&!canManage())){
  closeModal();state.view='tasks';state.scope=me().homeHallId?'home':'all';renderShell();
 }
}
async function refreshAfterAction(detailId=state.detailId) {
 const current=modalContext();await refreshBootstrap();await loadCurrent();
 if(current()&&detailId&&state.detailId===detailId&&state.modalType==='task'&&!hasQuestionDraft($('#modal'))){
  const result=await api(`/api/tasks/${Number(detailId)}`);
  if(current()&&state.detailId===detailId&&state.modalType==='task'&&!hasQuestionDraft($('#modal'))){state.detail=result.task||result;renderTaskDetail();}
 }
 if(state.view==='admin'&&!$('#modal').open)renderAdmin();
}
async function submitForm(form) {
 const current=modalContext(),formCurrent=()=>current()&&form.isConnected!==false;
 const data=new FormData(form);
 if(form.id==='login-form'){
  await post('/api/login',{login:data.get('login'),password:data.get('password')});await refreshBootstrap();
  state.view='tasks';state.scope=me().homeHallId?'home':'all';state.hallId='';state.tagId='';renderShell();return;
 }
 if(form.id==='task-filters')return;
 if(form.id==='create-task-form'){
  const result=await post('/api/tasks',{title:data.get('title'),description:data.get('description'),tagIds:selectedValues(form,'tagIds'),hallIds:selectedValues(form,'hallIds'),allHalls:data.has('allHalls')});
  if(!formCurrent())return;const tasks=listFrom(result,'tasks');closeModal();const closed=modalContext();await refreshAfterAction();if(!closed())return;toast(tasks.length>1?`Опубликовано выполнений по холлам: ${tasks.length}`:'Задача опубликована');if(tasks[0])await openTask(tasks[0].id);return;
 }
 if(form.id==='assignment-form'){
  const recipients=state.assignmentPreview || [];if(!recipients.length)throw new Error('Сначала выберите получателей задания.');
  await post(`/api/tasks/${Number(form.dataset.taskId)}/assign`,{mode:'manual',volunteerIds:ids(recipients.map(person=>person.id)),personalTagIds:[]});
  if(!formCurrent())return;const taskId=Number(form.dataset.taskId);closeModal();const closed=modalContext();await refreshAfterAction();if(!closed())return;await openTask(taskId);toast('Волонтёры назначены. Задания добавлены в очередь доставки.');return;
 }
 if(form.id==='new-question-form'){
  await post(`/api/tasks/${Number(form.dataset.taskId)}/questions`,{body:data.get('body'),tagIds:selectedValues(form,'tagIds'),blocking:data.has('blocking'),urgency:data.get('urgency')});
  if(!formCurrent())return;form.reset();delete form.dataset.dirty;await refreshAfterAction();toast('Вопрос отправлен');return;
 }
 if(form.dataset.replyId){
  const body=String(data.get('body') || '').trim();if(!body)throw new Error('Напишите ответ.');await post(`/api/questions/${Number(form.dataset.replyId)}/reply`,{body});if(!formCurrent())return;form.reset();delete form.dataset.dirty;await refreshAfterAction();toast('Ответ сохранён и отправлен участникам');return;
 }
 if(form.id==='forward-question-form'){
  await post(`/api/questions/${Number(form.dataset.questionId)}/forward`,{body:data.get('body'),tagIds:selectedValues(form,'tagIds'),blocking:data.has('blocking'),urgency:data.get('urgency')});
  if(!formCurrent())return;const taskId=state.returnTaskId;closeModal();const closed=modalContext();await refreshAfterAction();if(!closed())return;if(taskId)await openTask(taskId);toast('Вопрос передан выбранным направлениям');return;
 }
 if(form.id==='close-question-form'){
  await post(`/api/questions/${Number(form.dataset.questionId)}/close`,{body:data.get('body'),sendToVolunteers:data.has('sendToVolunteers')});if(!formCurrent())return;const taskId=state.returnTaskId;closeModal();const closed=modalContext();await refreshAfterAction();if(!closed())return;if(taskId)await openTask(taskId);toast('Решение подтверждено. Вопрос закрыт.');return;
 }
 if(form.id==='task-reason-form'){
  const taskId=Number(form.dataset.taskId);await post(`/api/tasks/${taskId}/${form.dataset.taskAction}`,{reason:data.get('reason')});if(!formCurrent())return;closeModal();const closed=modalContext();await refreshAfterAction();if(!closed())return;await openTask(taskId);toast(form.dataset.taskAction==='reset'?'Задача возвращена в очередь':'Задача отменена');return;
 }
 if(form.id==='personal-tags-form'){
  await post(`/api/volunteers/${Number(form.dataset.volunteerId)}/tags`,{names:String(data.get('names')||'').split(',').map(name=>name.trim()).filter(Boolean)});if(!formCurrent())return;closeModal();await refreshAfterAction();toast('Личные теги сохранены');return;
 }
 if(form.id==='cross-hall-form'){
  await post('/api/admin/settings',{crossHall:data.has('crossHall')});if(!formCurrent())return;await refreshBootstrap();if(!formCurrent())return;renderAdmin();toast('Настройка доступа сохранена');return;
 }
 if(form.id==='user-form'){
  const roles=$$('[name="roles"]:checked',form).map(input=>input.value);if(!roles.length)throw new Error('Выберите хотя бы одну возможность участника.');
  const input={name:data.get('name'),login:String(data.get('login')||'').trim()||null,roles,tagIds:selectedValues(form,'tagIds'),homeHallId:Number(data.get('homeHallId'))||null,managerId:Number(data.get('managerId'))||null,active:data.has('active')};
  if(form.dataset.userId)input.id=Number(form.dataset.userId);if(data.get('password'))input.password=data.get('password');
  await post('/api/admin/users',input);if(!formCurrent())return;closeModal();const closed=modalContext();await refreshBootstrap();if(!closed())return;renderAdmin();toast('Участник сохранён');return;
 }
 if(form.id==='tag-form'){
  const input={name:data.get('name'),kind:form.elements.kind.value};if(form.dataset.tagId)input.id=Number(form.dataset.tagId);await post('/api/admin/tags',input);if(!formCurrent())return;closeModal();const closed=modalContext();await refreshBootstrap();if(!closed())return;renderShell();toast(input.kind==='hall'?'Холл сохранён':'Общий тег сохранён');return;
 }
 if(form.id==='password-form'){
  await post('/api/change-password',{currentPassword:data.get('currentPassword'),password:data.get('password')});if(!formCurrent())return;form.reset();toast('Пароль изменён');return;
 }
}
document.addEventListener('submit',async event=>{
 const form=event.target;if(!(form instanceof HTMLFormElement))return;event.preventDefault();
 const button=form.querySelector('button[type="submit"]');if(button?.disabled)return;if(button)button.disabled=true;
 try{await submitForm(form);}catch(error){if(form.id==='login-form'){let node=$('.inline-error',form);if(!node){node=document.createElement('div');node.className='inline-error';form.append(node);}node.textContent=error.message;}else toast(error.message,true);}finally{if(button?.isConnected)button.disabled=false;}
});
document.addEventListener('click',async event=>{
 const button=event.target.closest('button,a,tr[data-open-task]');if(!button)return;
 if(button.dataset.nav){event.preventDefault();const options={};for(const key of ['scope','hallId','tagId','box']){const value=button.dataset[key.toLowerCase()];if(value!==undefined)options[key]=value;}navigate(button.dataset.nav,options);return;}
 if(button.dataset.openTask){event.preventDefault();openTask(Number(button.dataset.openTask)).catch(error=>toast(error.message,true));return;}
 if(button.dataset.taskAction){const current=modalContext();button.disabled=true;try{await post(`/api/tasks/${Number(button.dataset.id)}/${button.dataset.taskAction}`);if(!current()||!button.isConnected)return;await refreshAfterAction();if(current())toast(button.dataset.taskAction==='claim'?'Задача взята в работу':'Задача выполнена');}catch(error){if(current())toast(error.message,true);}finally{if(button.isConnected)button.disabled=false;}return;}
 const action=button.dataset.action;if(!action)return;
 try{
  if(action==='menu')$('#sidebar').classList.toggle('open');
  else if(action==='close-modal')closeModal();
  else if(action==='create-task')showCreateTask();
  else if(action==='logout'){await post('/api/logout');state.boot=null;closeModal();renderLogin();}
  else if(action==='assign')await showAssignment(Number(button.dataset.id));
  else if(action==='reset-task')showReasonDialog(Number(button.dataset.id),'reset');
  else if(action==='cancel-task')showReasonDialog(Number(button.dataset.id),'cancel');
  else if(action==='close-question')await showCloseQuestion(Number(button.dataset.id));
  else if(action==='forward-question')showForwardQuestion(Number(button.dataset.id));
  else if(action==='open-question')await openQuestion(Number(button.dataset.id));
  else if(action==='personal-tags')showPersonalTags(Number(button.dataset.id));
  else if(action==='connect-volunteer')await connectVolunteer(Number(button.dataset.id));
  else if(action==='edit-user')showUserForm(Number(button.dataset.id)||null);
  else if(action==='edit-hall')showTagForm(Number(button.dataset.id)||null,'hall');
  else if(action==='edit-tag')showTagForm(Number(button.dataset.id)||null);
  else if(action==='retry-delivery'){button.disabled=true;await post(`/api/deliveries/${Number(button.dataset.id)}/retry`);await loadCurrent();toast('Повторная отправка добавлена в очередь');}
  else if(action==='copy-link'){try{await navigator.clipboard.writeText(button.dataset.url);toast('Ссылка скопирована');}catch{toast('Выделите ссылку и скопируйте её вручную.',true);}}
 }catch(error){toast(error.message,true);if(button.isConnected)button.disabled=false;}
});
let searchTimer;
function hasQuestionDraft(root) { return !!root?.querySelector('form[data-dirty="1"]'); }
function markQuestionDraft(event) {
 const form=event.target.closest('#new-question-form,.reply-form,#cross-hall-form');
 if(form)form.dataset.dirty='1';
}
document.addEventListener('input',event=>{
 markQuestionDraft(event);
 if(event.target.closest('#task-filters')){
  const form=$('#task-filters');state.filters.q=form.elements.q.value;
  clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadCurrent().catch(error=>toast(error.message,true)),250);
 }
});
document.addEventListener('change',event=>{
 markQuestionDraft(event);
 if(event.target.closest('#task-filters')){
  const form=$('#task-filters');state.tagId=form.elements.tagId.value;state.filters={q:form.elements.q.value,status:form.elements.status.value,assignment:form.elements.assignment.value,blocked:form.elements.blocked.checked,openQuestions:form.elements.openQuestions.checked};loadCurrent().catch(error=>toast(error.message,true));
 }
 if(event.target.closest('#assignment-form'))refreshAssignmentPreview().catch(error=>toast(error.message,true));
 if(event.target.name==='allHalls'&&event.target.closest('#create-task-form'))$$('[name="hallIds"]',$('#create-task-form')).forEach(input=>{input.disabled=event.target.checked;});
});
$('#modal').addEventListener('close',()=>{if($('#modal').open)return;state.modalEpoch++;state.modalType=null;state.detailId=null;state.detail=null;});
document.addEventListener('keydown',event=>{if(event.key==='Escape')$('#sidebar')?.classList.remove('open');});
async function poll() {
 if(!state.boot||state.polling||document.hidden)return;state.polling=true;
 try{
  await refreshBootstrap();await loadCurrent();
  const focused=document.activeElement?.matches('input,textarea,select');
  if(state.detailId&&state.modalType==='task'&&!focused&&!hasQuestionDraft($('#modal'))){
   const id=state.detailId,current=modalContext();const result=await api(`/api/tasks/${id}`);
   if(current()&&state.detailId===id&&state.modalType==='task'&&!document.activeElement?.matches('input,textarea,select')&&!hasQuestionDraft($('#modal'))){state.detail=result.task||result;renderTaskDetail();}
  }
  state.offline=false;
 }catch(error){state.offline=true;}finally{state.polling=false;const connection=$('#connection');if(connection){connection.classList.toggle('offline',state.offline);connection.textContent=state.offline?'Нет связи · повторяем подключение':'Изменения синхронизируются';}}
}
async function init(){try{await refreshBootstrap();state.scope=me().homeHallId?'home':'all';renderShell();}catch{renderLogin();}setInterval(poll,4000);}
init();
