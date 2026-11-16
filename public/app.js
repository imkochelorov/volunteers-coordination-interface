import { $, $$, esc, icon, brand } from "./ui.js";
import { portraitScene, bindPortraitScene, bindHeroField } from "./landing.js";
import { landingContent, landingMenu, bindLandingContent } from "./landing-content.js";

const initialFilters = () => ({status:'',assignment:'',q:'',blocked:false,openQuestions:false});
const state = {boot:null,view:'tasks',scope:'all',hallId:'',tagId:'',box:'incoming',tasks:[],questions:[],volunteers:[],deliveries:[],filters:initialFilters(),detailId:null,detail:null,modalType:null,offline:false,polling:false};
const statusNames = {queued:'В очереди',in_progress:'В процессе',done:'Выполнена',cancelled:'Отменена'};
const roleNames = {admin:'Администратор',organizer:'Организатор',manager:'Менеджер',volunteer:'Волонтёр'};
const eventNames = {created:'Задача опубликована',task_created:'Задача опубликована',claimed:'Задача взята в работу',task_claimed:'Задача взята в работу',assigned:'Назначены волонтёры',task_assigned:'Назначены волонтёры',accepted:'Волонтёр начал выполнение',task_accepted:'Волонтёр начал выполнение',completed:'Задача выполнена',task_completed:'Задача выполнена',done:'Задача выполнена',cancelled:'Задача отменена',task_cancelled:'Задача отменена',reset:'Задача возвращена в очередь',task_reset:'Задача возвращена в очередь',question_created:'Задан вопрос',question_replied:'Добавлен ответ',question_answered:'Добавлен ответ',question_forwarded:'Вопрос передан адресатам',question_closed:'Вопрос решён'};
const mobileViewport = matchMedia('(max-width: 800px)');
const listFrom = (value, key) => Array.isArray(value) ? value : value?.[key] || [];
const ids = values => [...new Set((values || []).map(Number).filter(Number.isFinite))];
const me = () => state.boot?.user || {};
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
  const myHalls = me().homeHallId ? [Number(me().homeHallId)] : ids(me().tagIds).filter(id=>getTag(id)?.kind==='hall');
  return myHalls.includes(Number(task.hallId)) || !!state.boot?.settings?.crossHall;
};
function toast(message, error = false) {
  const node = $('#toast');node.textContent=message;node.className=`toast${error?' error':''}`;node.hidden=false;
  clearTimeout(toast.timer);toast.timer=setTimeout(()=>node.hidden=true,error?7000:4000);
}
async function api(path, options = {}) {
  const headers = {'Accept':'application/json',...options.headers};
  if(options.method && options.method!=='GET') {headers['Content-Type']='application/json';if(state.boot?.csrf)headers['X-CSRF-Token']=state.boot.csrf;headers['Idempotency-Key']=Array.from(crypto.getRandomValues(new Uint8Array(16)), byte=>byte.toString(16).padStart(2,'0')).join('');}
  const response = await fetch(path,{credentials:'same-origin',...options,headers,body:options.body===undefined?undefined:JSON.stringify(options.body)});
  let result;try{result=await response.json();}catch{result={error:'Сервер вернул непонятный ответ. Попробуйте ещё раз.'};}
  if(!response.ok){if(response.status===401 && state.boot){state.boot=null;closeModal();renderLogin('Сессия завершилась. Войдите снова.');}throw Object.assign(new Error(result.error || 'Не удалось выполнить действие'),{status:response.status});}
  return result;
}
const post = (path, body={}) => api(path,{method:'POST',body});
function empty(title,description,action='') {return `<div class="empty"><div class="empty-icon">${icon('inbox')}</div><h3>${esc(title)}</h3><p>${esc(description)}</p>${action}</div>`;}
function titleForView() {
  if(state.view==='tasks')return state.scope==='mine'?'Мои задачи':state.scope==='home'?'Мой холл':state.scope==='hall'?tagName(state.hallId):state.tagId?tagName(state.tagId):'Все задачи';
  return {questions:{incoming:'Входящие вопросы',outgoing:'Исходящие вопросы',volunteer:'Вопросы волонтёров',unaddressed:'Вопросы без тегов'}[state.box],volunteers:'Мои волонтёры',admin:'Администрирование',deliveries:'Доставка в Telegram',account:'Мой профиль',notifications:'Уведомления'}[state.view] || 'связь?';
}
function navButton(view,label,iconName,extra={}) {
 const active=state.view===view && Object.entries(extra).every(([key,val])=>String(state[key])===String(val));
 return `<button type="button" class="nav-button ${active?'active':''}" data-nav="${view}" ${active?'aria-current="page"':''} ${Object.entries(extra).map(([key,val])=>`data-${key.toLowerCase()}="${esc(val)}"`).join(' ')}>${icon(iconName)}<span>${esc(label)}</span></button>`;
}
let disposeLanding;

function renderLogin(error = "") {
  disposeLanding?.();
  $("#app").innerHTML = `<main class="login-page">
    ${portraitScene()}
    <header class="landing-header">
      <a class="landing-home" href="#landing-hero" aria-label="На главный экран">${brand}</a>
      <img class="landing-emblem" src="/assets/nerc-logo.svg" alt="NEERC / ICPC">
      <div class="landing-header-actions">
      <details class="login-access" ${error ? "open" : ""}>
        <summary class="login-trigger">${icon("lock")} Войти</summary>
        <form id="login-form" class="login-form form-stack">
          <h1>Вход</h1>
          <label class="field">Логин <input name="login" autocomplete="username" required></label>
          <label class="field">Пароль <input name="password" type="password" autocomplete="current-password" required></label>
          ${error ? `<div class="inline-error" role="alert">${esc(error)}</div>` : ""}
          <button class="button primary" type="submit">Войти ${icon("arrow")}</button>
        </form>
      </details>
      <button class="landing-menu-trigger" type="button" aria-haspopup="dialog" aria-label="Открыть меню" aria-controls="landing-menu" aria-expanded="false">${icon("menu")}</button>
      </div>
    </header>
    ${landingContent()}
    ${landingMenu()}
  </main>`;
  const hero = $("#landing-hero");
  bindPortraitScene(hero);
  const unbindField = bindHeroField(hero);
  const unbindContent = bindLandingContent($(".login-page"));
  disposeLanding = () => { unbindField(); unbindContent(); };
  const access = $(".login-access");
  access.addEventListener("toggle", () => {
    if (access.open) $("#login-form [name=login]").focus({preventScroll: true});
  });
  access.addEventListener("keydown", event => {
    if (event.key === "Escape" && access.open) {
      access.open = false;
      $(".login-trigger", access).focus();
    }
  });
}

function setMenu(requested, restoreFocus=false) {
 const sidebar=$('#sidebar');if(!sidebar)return;
 const open=mobileViewport.matches&&requested;
 const trigger=$('.mobile-menu');
 sidebar.classList.toggle('open',open);
 sidebar.inert=mobileViewport.matches&&!open;
 $('.main').inert=open;
 $('.menu-scrim').hidden=!open;
 trigger.setAttribute('aria-expanded',String(open));
 if(open)$('.drawer-close').focus();
 else if(restoreFocus)trigger.focus();
}
function renderNavigation(user) {
  const all = { scope: "all", hallId: "", tagId: "" };
  return `<nav aria-label="Разделы приложения">
    <div class="nav-label">Задачи</div>
    ${user.homeHallId ? navButton("tasks", "Мой холл", "hall", {...all, scope: "home"}) : ""}
    ${navButton("tasks", "Все задачи", "grid", all)}
    ${navButton("tasks", "Мои задачи", "check", {...all, scope: "mine"})}
    ${canManage() ? navButton("volunteers", "Мои волонтёры", "users") : ""}
    <div class="nav-label">Вопросы и ответы</div>
    ${navButton("questions", "Входящие", "inbox", {box: "incoming"})}
    ${navButton("questions", "Исходящие", "send", {box: "outgoing"})}
    ${canManage() ? navButton("questions", "От волонтёров", "message", {box: "volunteer"}) : ""}
    ${navButton("questions", "Без тегов", "message", {box: "unaddressed"})}
    <div class="nav-label">Холлы</div>
    ${hallTags().map(tag => navButton("tasks", tag.name, "hall", {...all, scope: "hall", hallId: tag.id})).join("")}
    <div class="nav-label">Направления</div>
    ${directionTags().map(tag => navButton("tasks", tag.name, "tag", {...all, tagId: tag.id})).join("")}
    ${canManage() ? `<div class="nav-label">Управление</div>${navButton("deliveries", "Доставка в Telegram", "send")}` : ""}
    ${hasRole("admin") ? navButton("admin", "Администрирование", "settings") : ""}
  </nav>`;
}

function renderShell() {
  if (disposeLanding) {
    disposeLanding();
    disposeLanding = null;
    window.scrollTo({top: 0, behavior: "instant"});
  }
  const user = me();
  const roles = (user.roles || []).map(role => roleNames[role]).join(" · ");
  $("#app").innerHTML = `<div class="app-shell">
    <div class="menu-scrim" data-action="dismiss-menu" hidden></div>
    <aside class="sidebar" id="sidebar">
      <button class="icon-button drawer-close" type="button" data-action="dismiss-menu"
        aria-label="Закрыть навигацию">${icon("close")}</button>
      ${brand}
      ${renderNavigation(user)}
      <div class="sidebar-footer"><div class="connection" id="connection">Синхронизация работает</div></div>
    </aside>
    <main class="main">
      <header class="topbar ${state.view === "tasks" ? "topbar--board" : ""}">
        <button class="icon-button mobile-menu" data-action="menu" aria-label="Открыть навигацию"
          aria-controls="sidebar" aria-expanded="false">${icon("menu")}</button>
        ${state.view === "tasks"
          ? `<h1 class="board-title" tabindex="-1">${esc(titleForView())}</h1>`
          : `<div class="breadcrumb">NEERC / ICPC <span aria-hidden="true">·</span> <strong id="breadcrumb-title"></strong></div>`}
        <div class="top-right">
          <button class="icon-button" data-nav="notifications" aria-label="Уведомления" id="notification-button">${icon("bell")}</button>
          <button class="profile" data-nav="account" aria-label="Мой профиль">
            <span class="avatar">${esc(initials(user.name))}</span>
            <span><span class="profile-name">${esc(user.name)}</span><span class="profile-role">${esc(roles)}</span></span>
          </button>
          <button class="icon-button" data-action="logout" aria-label="Выйти">${icon("logout")}</button>
        </div>
      </header>
      <div id="page" class="page"></div>
    </main>
  </div>`;
  setMenu(false);
  renderPage();
}

function renderPage() {
 const breadcrumb = $('#breadcrumb-title');
 if (breadcrumb) breadcrumb.textContent = titleForView();
 const subtitles={questions:'Один вопрос — одно обсуждение. Ответы сохраняются в общей истории.',volunteers:'Доступность, текущие задачи и личные теги вашего пула',admin:'Участники, направления, пулы и права доступа',deliveries:'Контроль отправки заданий и обновлений сообщений',account:'Доступ к рабочему пространству',notifications:'События, которым нужно ваше внимание'};
 const title = esc(titleForView());
 const subtitle = esc(subtitles[state.view] || "");
 const heading = state.view === "tasks" ? ""
   : `<div class="page-heading"><div><h1 tabindex="-1">${title}</h1><p>${subtitle}</p></div></div>`;
 $("#page").innerHTML = `${heading}<div id="page-content"></div>`;

 if(state.view==='tasks')renderTasksPage();
 else if(state.view==='questions')$('#page-content').innerHTML='<div id="questions-results" class="questions-list"><div class="loading-line">Загружаем вопросы…</div></div>';
 else if(state.view==='volunteers')$('#page-content').innerHTML='<div id="volunteers-results" class="volunteer-grid"><div class="loading-line">Загружаем волонтёров…</div></div>';
 else if(state.view==='admin')renderAdmin();
 else if(state.view==='account')renderAccount();
 else if(state.view==='notifications')renderNotifications();
 else if(state.view==='deliveries')$('#page-content').innerHTML='<div id="deliveries-results" class="panel"><div class="loading-line">Загружаем доставки…</div></div>';
 loadCurrent().catch(error=>{
  const loading=$('#page-content .loading-line');
  if(loading)loading.outerHTML='<div class="empty load-error"><h3>Не удалось загрузить данные</h3><button type="button" class="button secondary" data-action="reload-view">Повторить</button></div>';
  toast(error.message,true);
 });
}
const boardColumns = [
  {status: "queued", label: "В очереди"},
  {status: "in_progress", label: "В работе"},
  {status: "done", label: "Выполнено"},
  {status: "cancelled", label: "Отменено"},
];

function renderTasksPage() {
  const otherHall = state.scope === "hall" && me().homeHallId && Number(state.hallId) !== Number(me().homeHallId);
  const readOnly = otherHall && !state.boot.settings.crossHall && !hasRole("admin");
  const filters = state.filters;
  const assignments = {free: "Без назначений", assigned: "С назначениями", waiting: "Ожидают принятия"};
  const options = (values, selected) => Object.entries(values).map(([value, label]) =>
    `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`
  ).join("");
  $("#page-content").innerHTML = `
    <div class="board-tools">
      <form id="task-filters" class="filters">
        <label class="search">${icon("search")}
          <input type="search" name="q" value="${esc(filters.q)}" placeholder="Поиск по описанию или номеру" aria-label="Поиск задач">
        </label>
        <select name="status" aria-label="Статус">
          <option value="">Все статусы</option>${options(statusNames, filters.status)}
        </select>
        <select name="assignment" aria-label="Назначения">
          <option value="">Все назначения</option>${options(assignments, filters.assignment)}
        </select>
        <div class="filter-advanced">
          <label class="toggle-filter"><input type="checkbox" name="blocked" ${filters.blocked ? "checked" : ""}>Заблокированы</label>
          <label class="toggle-filter"><input type="checkbox" name="openQuestions" ${filters.openQuestions ? "checked" : ""}>Есть вопросы</label>
        </div>
      </form>
      <button class="button primary" data-action="create-task">${icon("plus")} Создать задачу</button>
    </div>
    ${readOnly ? `<div class="notice warning">Задачи этого холла доступны для просмотра.</div>` : ""}
    <div class="board-summary">
      <span id="task-count"></span>
      ${state.boot.telegram?.configured === false ? '<small>Telegram не настроен</small>' : ""}
      <button class="muted-link" type="button" data-action="clear-filters" id="clear-task-filters" hidden>Сбросить фильтры</button>
      <small id="sync-label" class="sync-label">Синхронизация</small>
    </div>
    <div id="tasks-results"><div class="loading-line" role="status">Загружаем задачи…</div></div>`;
}

const taskDescription = task => task.description?.trim() || task.title?.trim() || "Описание отсутствует";

function taskAssignees(task) {
  const volunteerIds = (task.assignments || []).map(assignment => assignment.volunteerId);
  const people = task.claimedBy ? [task.claimedBy] : volunteerIds;
  if (people.length === 0) return "";
  const names = people.map(userName).join(", ");
  return `<span class="avatar-stack" title="${esc(names)}" aria-label="${esc(names)}">
    ${people.slice(0, 3).map(userAvatar).join("")}
    ${people.length > 3 ? `<span class="avatar">+${people.length - 3}</span>` : ""}
  </span>`;
}

function renderTaskCard(task) {
  const code = `#${String(task.id).padStart(3, "0")}`;
  return `<li>
    <button class="board-card${task.blocked ? " board-card--blocked" : ""}" data-open-task="${Number(task.id)}" type="button">
      <span class="board-card-description">${esc(taskDescription(task))}</span>
      <span class="tag-list">
        ${tagList(task.tagIds?.length ? task.tagIds : task.hallId ? [task.hallId] : [])}
        ${task.blocked ? '<span class="status blocked">Заблокирована</span>' : ""}
        ${task.awaitingAcceptance ? '<span class="status waiting">Ожидает принятия</span>' : ""}
      </span>
      <span class="board-card-meta">
        <span class="task-code">${code}</span>
        ${task.openQuestions ? `<span class="board-card-questions" aria-label="Открытых вопросов: ${Number(task.openQuestions)}">${icon("message")} ${Number(task.openQuestions)}</span>` : ""}
        ${taskAssignees(task)}
      </span>
    </button>
  </li>`;
}

function renderTaskResults() {
  const results = $("#tasks-results");
  if (!results) return;
  const tasks = state.tasks;
  $("#task-count").textContent = `Задач: ${tasks.length}`;
  $("#clear-task-filters").hidden = !Object.values(state.filters).some(Boolean);
  const columns = boardColumns.filter(column => !state.filters.status || column.status === state.filters.status);
  results.innerHTML = `<div class="task-board">
    ${columns.map(({status, label}) => {
      const cards = tasks.filter(task => task.status === status);
      return `<section class="board-column" data-status="${status}" aria-labelledby="board-${status}">
        <header class="board-column-header">
          <h2 id="board-${status}">${label}</h2>
          <span class="board-count" aria-label="Задач: ${cards.length}">${cards.length}</span>
        </header>
        ${cards.length ? `<ul class="board-cards">${cards.map(renderTaskCard).join("")}</ul>`
          : '<p class="board-empty">Нет задач</p>'}
      </section>`;
    }).join("")}
  </div>`;
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
  const tasks=listFrom(result,'tasks');
  const signature = JSON.stringify([state.filters, tasks]);
  if (signature === state.taskRenderSignature && $("#tasks-results .task-board")) return;
  state.taskRenderSignature = signature;
  const focus=document.activeElement?.closest('.board-card')?.dataset.openTask;
  state.tasks=tasks;renderTaskResults();
  if(focus)$(`.board-card[data-open-task="${CSS.escape(focus)}"]`)?.focus({preventScroll:true});
 } else if(state.view==='questions'){
  const box=state.box;const result=await api(`/api/questions?box=${encodeURIComponent(box)}`);if(state.view!=='questions'||state.box!==box)return;
  state.questions=listFrom(result,'questions');if(!hasQuestionDraft($('#page-content')) && (!$('#page-content')?.contains(document.activeElement) || !document.activeElement.matches('input,textarea,select')))renderQuestionResults();
 } else if(state.view==='volunteers'){
  const result=await api('/api/volunteers');if(state.view!=='volunteers')return;state.volunteers=listFrom(result,'volunteers');renderVolunteers();
 } else if(state.view==='deliveries'){
  const result=await api('/api/deliveries');if(state.view!=='deliveries')return;state.deliveries=listFrom(result,'deliveries');renderDeliveries();
 }
}
function navigate(view, options={}) {
 state.view=view;Object.assign(state,options);renderShell();
 $('.main h1')?.focus();
}
function showModal(type,html) {
 const modal=$('#modal');state.modalType=type;modal.className='modal';modal.innerHTML=html;if(!modal.open)modal.showModal();
}
function closeModal(){const modal=$('#modal');if(modal.open)modal.close();state.modalType=null;state.detailId=null;state.detail=null;}
const modalHead=(title,subtitle='')=>`<div class="modal-head"><div><h2>${esc(title)}</h2>${subtitle?`<small>${esc(subtitle)}</small>`:''}</div><button type="button" class="icon-button" data-action="close-modal" aria-label="Закрыть">${icon('close')}</button></div>`;
function checkTags(name,selected=[],tags=state.boot.tags){return tags.map(tag=>`<label class="check-pill"><input type="checkbox" name="${name}" value="${Number(tag.id)}" ${ids(selected).includes(Number(tag.id))?'checked':''}>${esc(tag.name)}</label>`).join('');}
function selectedValues(form,name){return $$(`[name="${name}"]:checked`,form).map(input=>Number(input.value));}
function showCreateTask() {
 showModal('create-task',`${modalHead('Новая задача','Опишите результат и выберите, где нужно выполнить задачу')}<form id="create-task-form" class="modal-body form-stack"><label class="field">Описание<textarea name="description" rows="5" required maxlength="15000" placeholder="Место, время и подробности, которые помогут исполнителям"></textarea></label><div class="field-group"><label class="field">Холлы<small>Для каждого выбранного холла создаётся отдельное выполнение со своим статусом.</small></label><label class="check-line" style="margin-bottom:12px"><input name="allHalls" type="checkbox">Все холлы</label><div class="check-grid">${checkTags('hallIds',[],hallTags())}</div></div><div class="field"><span>Общие теги направлений</span><div class="check-grid">${checkTags('tagIds',[],directionTags())}</div><small>Без тегов задача попадёт в общую очередь.</small></div><div class="modal-footer"><button type="button" class="button secondary" data-action="close-modal">Отмена</button><button class="button primary" type="submit">${icon('plus')}Опубликовать задачу</button></div></form>`);
}
async function openTask(id) {
 state.detailId=Number(id);state.modalType='task';showModal('task',`${modalHead('Загружаем задачу…')}<div class="loading-line">Получаем актуальные данные</div>`);
 const result=await api(`/api/tasks/${Number(id)}`);if(state.detailId!==Number(id))return;state.detail=result.task || result;renderTaskDetail();
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
 const canFinish=task.status==='in_progress' && Number(task.claimedBy)===Number(me().id);
 const participants=task.assignments || [];
 const siblings=task.siblings || [];
 const history=task.history || [];
 const questions=task.questions || [];
 const canQuestion=isParticipant(task);
 showModal('task',`${modalHead("Задача #" + task.id,task.hallId ? tagName(task.hallId) : "Общая очередь")}<div class="modal-body"><div class="tag-list">${task.blocked?'<span class="status blocked">Заблокирована</span>':''}${statusBadge(task)}${task.awaitingAcceptance?'<span class="status waiting">Ожидает принятия волонтёрами</span>':''}${tagList(task.tagIds)}</div><div class="detail-description">${esc(taskDescription(task))}</div><div class="detail-meta"><div><small>Автор задачи</small>${esc(userName(task.authorId))}</div><div><small>Создана</small>${esc(dateText(task.createdAt))}</div><div><small>${task.claimedBy?'Взял в работу':'Назначил волонтёров'}</small>${esc(userName(task.claimedBy || task.assignedBy))}</div><div><small>Выполнение</small>${task.hallId?esc(tagName(task.hallId)):'Общая задача'}</div></div>${!working&&!isTerminal(task)?`<div class="notice warning">Работа с задачами этого холла отключена администратором. Доступен просмотр.</div>`:''}<div class="actions">${free&&working?`<button class="button primary" data-task-action="claim" data-id="${task.id}">${icon('check')}Взять в работу</button>${canManage()?`<button class="button secondary" data-action="assign" data-id="${task.id}">${icon('users')}Назначить волонтёров</button>`:''}`:''}${canFinish?`<button class="button primary" data-task-action="complete" data-id="${task.id}">${icon('check')}Завершить задачу</button>`:''}${(task.canReset ?? (!isTerminal(task)&&isParticipant(task)&&working))?`<button class="button secondary" data-action="reset-task" data-id="${task.id}">${icon('refresh')}Вернуть в очередь</button><button class="button danger" data-action="cancel-task" data-id="${task.id}">Отменить</button>`:''}</div>${siblings.length>1?`<div class="section-label">Выполнение по холлам</div><div class="siblings">${siblings.map(sibling=>`<button class="sibling ${Number(sibling.id)===Number(task.id)?'current':''}" data-open-task="${sibling.id}"><span>${esc(sibling.hallId?tagName(sibling.hallId):'Общая')}</span>${statusBadge(sibling)}${sibling.blocked?icon('alert'):''}</button>`).join('')}</div>`:''}<div class="section-label">Назначенные волонтёры · ${participants.length}</div>${participants.length?participants.map(assignment=>`<div class="select-person" style="cursor:default">${userAvatar(assignment.volunteerId)}<div class="person-info"><strong>${esc(userName(assignment.volunteerId))}</strong><p>${assignment.acceptedAt?'Начал выполнение · '+esc(dateText(assignment.acceptedAt)):isTerminal(task)?'Задача завершена':'Задание назначено, ожидается принятие'}</p></div>${assignment.acceptedAt?'<span class="status in_progress">В работе</span>':''}</div>`).join(''):'<p class="muted" style="font-size:12px">Волонтёры не назначены.</p>'}<div class="section-label">Вопросы по задаче · ${questions.length}</div>${questions.length?questions.map(renderDiscussion).join(''):'<p class="muted" style="font-size:12px">Вопросов пока нет.</p>'}${canQuestion&&!isTerminal(task)?`<details class="question-form"><summary>+ Задать вопрос по задаче</summary><form id="new-question-form" class="form-stack" data-task-id="${task.id}"><label class="field">Вопрос<textarea name="body" required maxlength="10000" placeholder="Что нужно уточнить?"></textarea></label><div class="field"><span>Получатели</span><div class="check-grid">${checkTags('tagIds')}</div><small>Рекомендуем выбрать направления. Без тегов вопрос попадёт в общую очередь вопросов.</small></div><div class="form-row"><label class="check-line"><input type="checkbox" name="blocking">Блокирует выполнение</label><label class="field">Срочность<select name="urgency"><option value="normal">Обычная</option><option value="urgent">Срочная</option></select></label></div><div class="modal-footer"><button class="button primary" type="submit">${icon('send')}Отправить вопрос</button></div></form></details>`:''}<div class="section-label">История изменений</div>${history.length?`<ol class="history">${history.slice().reverse().map(entry=>`<li>${esc(eventNames[entry.event || entry.action] || entry.event || entry.action || 'Изменение задачи')}${entry.actorId?` · ${esc(userName(entry.actorId))}`:''}${historyDetail(entry)}<small>${esc(dateText(entry.createdAt))}</small></li>`).join('')}</ol>`:'<p class="muted" style="font-size:12px">История пока пуста.</p>'}</div>`);
}
function questionCanReply(question){return question.state!=='closed';}
function renderDiscussion(question) {
 const messages=question.messages || [];
 const controller=Number(question.controllerId)===Number(me().id)||hasRole('admin');
 const canForward=question.source==='volunteer'&&controller&&!question.forwarded&&question.state!=='closed';
 const expected=question.state==='closed'?'Вопрос решён':question.state==='answered'?`Ожидает подтверждения решения · ${userName(question.controllerId)}`:question.source==='volunteer'&&!question.forwarded?`Ожидает ответа менеджера · ${userName(question.controllerId)}`:question.tagIds?.length?'Ожидает ответа получателей':'Ожидает ответа в общей очереди';
 return `<article class="discussion" data-question="${question.id}"><div class="discussion-head"><div><h3>Вопрос #${question.id} · ${esc(userName(question.askedBy))}${question.taskId&&state.view==='questions'?` <button class="muted-link" data-open-task="${question.taskId}">к задаче #${question.taskId}</button>`:''}</h3><div class="discussion-tags">${question.blocking?'<span class="status blocked">Блокирует работу</span>':'<span class="tag">Не блокирует</span>'}${question.urgency==='urgent'?'<span class="tag" style="background:#fff0f1;color:#ba4c5a">Срочно</span>':''}${tagList(question.tagIds) || `<span class="tag">${question.source==='volunteer'&&!question.forwarded?'Менеджеру':'Без тегов'}</span>`}</div></div><span class="status ${esc(question.state)}">${{open:'Ожидает ответа',answered:'Есть ответ',closed:'Решён'}[question.state] || esc(question.state)}</span></div><div class="discussion-body">${messages.length?messages.map(message=>`<div class="thread-message"><div class="message-meta"><strong>${esc(userName(message.authorId))}</strong><span>${esc(dateText(message.createdAt))}</span></div><div class="message-body">${esc(message.body)}</div></div>`).join(''):`<div class="message-body">${esc(question.body || '')}</div>`}</div><div class="discussion-expectation">${esc(expected)}${question.recipientIds?.length?`<br>Получатели: ${question.recipientIds.map(userName).map(esc).join(', ')}`:''}</div>${questionCanReply(question)?`<form class="reply-form" data-reply-id="${question.id}"><textarea name="body" placeholder="Ответить в обсуждении…" aria-label="Ответ на вопрос #${question.id}" maxlength="10000"></textarea><div class="reply-buttons"><button class="button primary small" type="submit">${icon('send')}Ответить</button>${controller?`<button class="button secondary small" type="button" data-action="close-question" data-id="${question.id}">${icon('check')}Подтвердить решение</button>`:''}${canForward?`<button class="button secondary small" type="button" data-action="forward-question" data-id="${question.id}">${icon('arrow')}Передать направлениям</button>`:''}</div>${question.source==='volunteer'&&controller?'<small style="display:block;margin-top:8px">Ответ будет доставлен волонтёру через Telegram.</small>':''}</form>`:''}</article>`;
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
  return `<article class="volunteer-card"><div class="volunteer-heading"><span class="avatar">${esc(initials(volunteer.name))}</span><div><h3>${esc(volunteer.name)}</h3><div class="availability ${!volunteer.available?'unavailable':''}">${!volunteer.available?'Недоступен':free?'Свободен':'Доступен · занят'}</div></div></div><div class="tag-list">${personalNames(volunteer).map(name=>`<span class="tag">${esc(name)}</span>`).join('') || '<small>Нет личных тегов</small>'}</div><div class="volunteer-tasks">${tasks.length?tasks.map(task=>`<button data-open-task="${task.id}">#${task.id} ${esc(taskDescription(task))}${task.status==='queued'?' · ожидает принятия':''}</button>`).join(''):'Нет незавершённых задач'}</div><div><small>${volunteer.telegramId?'Telegram подключён':'Telegram ещё не подключён'}</small></div><div class="volunteer-actions">${Number(volunteer.managerId)===Number(me().id)?`<button class="button ghost small" data-action="personal-tags" data-id="${volunteer.id}">${icon('tag')}Личные теги</button>`:''}<button class="button secondary small" data-action="connect-volunteer" data-id="${volunteer.id}" ${volunteer.telegramId?'disabled':''}>${icon('send')}${volunteer.telegramId?'Telegram подключён':'Подключить Telegram'}</button></div></article>`;
 }).join(''):empty('Пул пока не настроен','Администратор добавляет волонтёров и закрепляет их за менеджерами. После этого они появятся здесь.');
}
function renderDeliveries() {
 const target=$('#deliveries-results');if(!target)return;
 target.innerHTML=state.deliveries.length?state.deliveries.map(delivery=>`<div class="delivery"><span class="status ${delivery.status==='sent'?'done':delivery.status==='failed'?'blocked':'waiting'}">${{sent:'Отправлено',pending:'В очереди',failed:'Ошибка',processing:'Отправляется'}[delivery.status] || esc(delivery.status)}</span><div class="delivery-text"><strong>${esc(userName(delivery.userId ?? delivery.user_id))}</strong>${delivery.taskId||delivery.task_id?` · <button class="muted-link" data-open-task="${Number(delivery.taskId??delivery.task_id)}">Задача #${Number(delivery.taskId??delivery.task_id)}</button>`:''}<p>${esc(delivery.error || delivery.lastError || delivery.last_error || (delivery.kind==='task'?'Обновление карточки задания':'Сообщение волонтёру'))}</p><small>Попыток: ${Number(delivery.attempts || 0)} · ${esc(dateText(delivery.createdAt || delivery.created_at))}</small></div>${['failed','pending'].includes(delivery.status)?`<button class="button secondary small" data-action="retry-delivery" data-id="${delivery.id}">${icon('refresh')}Повторить</button>`:''}</div>`).join(''):empty('Отправок пока нет','После назначения волонтёров здесь появятся задания и обновления Telegram. Ошибки доставки не отменяют назначение.');
}
function renderAdmin() {
 const users=state.boot.users || [];
 $('#page-content').innerHTML=`<div class="admin-layout"><section class="panel admin-panel"><div class="section-toolbar"><h2>Участники мероприятия</h2><button class="button primary small" data-action="edit-user">${icon('plus')}Добавить</button></div>${users.map(user=>`<div class="admin-user"><span class="avatar">${esc(initials(user.name))}</span><div class="admin-user-info"><strong>${esc(user.name)}${user.active===false?' · отключён':''}</strong><small>${esc((user.roles || []).map(role=>roleNames[role]).join(' · '))}${user.managerId?' · менеджер: '+esc(userName(user.managerId)):''}</small><div class="tag-list" style="margin-top:6px">${tagList(user.tagIds)}</div></div><button class="button secondary small" data-action="edit-user" data-id="${user.id}">Изменить</button></div>`).join('')}</section><div><section class="panel admin-panel"><h2>Работа с другими холлами</h2><form id="cross-hall-form" class="form-stack"><label class="check-line"><input type="checkbox" name="crossHall" ${state.boot.settings.crossHall?'checked':''}>Разрешить работу с задачами других холлов</label><p class="field-hint">При выключенном флаге задачи других холлов доступны для просмотра. При включённом менеджеры могут брать их в работу и назначать свой пул.</p><div><button class="button primary small" type="submit">Сохранить настройку</button></div></form></section><section class="panel admin-panel" style="margin-top:20px"><div class="section-toolbar"><h2>Общие теги</h2><button class="button secondary small" data-action="edit-tag">${icon('plus')}Добавить</button></div><p class="field-hint">Общие теги направлений и холлов. Личные теги менеджеров хранятся отдельно.</p><div style="margin-top:14px">${state.boot.tags.map(tag=>`<div class="admin-user"><div class="admin-user-info"><strong>${esc(tag.name)}</strong><small>${tag.kind==='hall'?'Холл · отдельный статус выполнения':'Направление'}</small></div><button class="button ghost small" data-action="edit-tag" data-id="${tag.id}">Изменить</button></div>`).join('')}</div></section></div></div>`;
}
function showUserForm(id) {
 const user=id?getUser(id):{roles:['volunteer'],tagIds:[],active:true};
 if(!user)return;
 showModal('edit-user',`${modalHead(id?'Изменить участника':'Новый участник','Роли могут совмещаться. Волонтёр работает через Telegram.')}<form id="user-form" class="modal-body form-stack" data-user-id="${id||''}"><div class="form-row"><label class="field">Имя<input name="name" required maxlength="160" value="${esc(user.name)}"></label><label class="field">Логин для веба<input name="login" maxlength="100" value="${esc(user.login)}" autocomplete="off"><small>Нужен организаторам, менеджерам и администраторам.</small></label></div><label class="field">${id?'Новый пароль':'Пароль для веба'}<input name="password" type="password" minlength="12" autocomplete="new-password" placeholder="${id?'Оставьте пустым, чтобы сохранить пароль':'Не менее 12 символов'}"></label><div class="field"><span>Возможности</span><div class="check-grid">${Object.entries(roleNames).map(([role,name])=>`<label class="check-pill"><input type="checkbox" name="roles" value="${role}" ${(user.roles||[]).includes(role)?'checked':''}>${esc(name)}</label>`).join('')}</div></div><div class="field"><span>Общие теги</span><div class="check-grid">${checkTags('tagIds',user.tagIds)}</div></div><div class="form-row"><label class="field">Основной холл<select name="homeHallId"><option value="">Не назначен</option>${hallTags().map(tag=>`<option value="${tag.id}" ${Number(user.homeHallId)===Number(tag.id)?'selected':''}>${esc(tag.name)}</option>`).join('')}</select></label><label class="field">Менеджер волонтёра<select name="managerId"><option value="">Не закреплён</option>${state.boot.users.filter(candidate=>(candidate.roles||[]).includes('manager')&&Number(candidate.id)!==Number(id)).map(candidate=>`<option value="${candidate.id}" ${Number(user.managerId)===Number(candidate.id)?'selected':''}>${esc(candidate.name)}</option>`).join('')}</select></label></div><label class="check-line"><input type="checkbox" name="active" ${user.active!==false&&user.active!==0?'checked':''}>Доступ активен</label><div class="modal-footer"><button type="button" class="button secondary" data-action="close-modal">Отмена</button><button type="submit" class="button primary">Сохранить участника</button></div></form>`);
}
function showTagForm(id) {
 const tag=id?getTag(id):{name:'',kind:'direction'};
 showModal('edit-tag',`${modalHead(id?'Изменить общий тег':'Новый общий тег')}<form id="tag-form" data-tag-id="${id||''}" class="modal-body form-stack"><label class="field">Название<input name="name" value="${esc(tag.name)}" required maxlength="80"></label><label class="field">Тип<select name="kind" ${id?'disabled':''}><option value="direction" ${tag.kind==='direction'?'selected':''}>Направление</option><option value="hall" ${tag.kind==='hall'?'selected':''}>Холл</option></select><small>Холл создаёт отдельное выполнение задачи при публикации на несколько холлов.</small></label><div class="modal-footer"><button type="button" class="button secondary" data-action="close-modal">Отмена</button><button class="button primary" type="submit">Сохранить тег</button></div></form>`);
}
function renderAccount() {
 $('#page-content').innerHTML=`<section class="panel account-panel"><h2>Изменить пароль</h2><form id="password-form" class="form-stack" style="margin-top:22px"><label class="field">Текущий пароль<input type="password" name="currentPassword" required autocomplete="current-password"></label><label class="field">Новый пароль<input type="password" name="password" required minlength="12" autocomplete="new-password"><small>Не менее 12 символов.</small></label><button class="button primary" type="submit">Сохранить новый пароль</button></form><div class="admin-block"><button class="button secondary" data-action="logout">${icon('logout')}Выйти</button></div></section>`;
}
function renderNotifications() {
 const notifications=state.boot.notifications || [];
 $('#page-content').innerHTML=`<section class="panel admin-panel">${notifications.length?`<ul class="notification-list">${notifications.slice().reverse().map(notification=>`<li><p>${esc(notification.text || notification.body || notification.message || 'Обновление обсуждения')}</p><small>${esc(dateText(notification.createdAt || notification.created_at))}</small>${notification.taskId?` <button class="muted-link" data-open-task="${notification.taskId}">${notification.questionId?'Открыть вопрос #'+notification.questionId:'Открыть задачу #'+notification.taskId}</button>`:notification.questionId?` <button class="muted-link" data-action="open-question" data-id="${notification.questionId}">Открыть вопрос #${notification.questionId}</button>`:''}</li>`).join('')}</ul>`:empty('Новых уведомлений нет','Вопросы и обновления, адресованные вам, появятся здесь.')}</section>`;
}
async function showAssignment(taskId) {
 const result=await api('/api/volunteers');state.volunteers=listFrom(result,'volunteers');
 const pool=state.volunteers.filter(volunteer=>Number(volunteer.managerId)===Number(me().id));
 state.assignmentTaskId=Number(taskId);state.assignmentPreview=[];state.previewRevision=0;
 showModal('assignment',`${modalHead('Назначить волонтёров',`Задача #${taskId} · выберите людей из своего пула`)}<form id="assignment-form" class="modal-body form-stack" data-task-id="${taskId}">${pool.length?'':`<div class="notice warning">Ваш пул пока пуст. Администратор может закрепить за вами волонтёров. Для назначения используется только ваш собственный пул.</div>`}<div class="form-row"><label class="field">Способ выбора<select name="mode"><option value="manual">Выбрать людей вручную</option><option value="free">Все свободные</option><option value="all">Весь мой пул</option></select></label><div class="field"><span>Личные теги</span><div class="check-grid">${(state.boot.personalTags||[]).map(tag=>`<label class="check-pill"><input type="checkbox" name="personalTagIds" value="${tag.id}">${esc(tag.name)}</label>`).join('') || '<small>Теги можно добавить в разделе волонтёров</small>'}</div></div></div><div><div class="section-label" style="margin-top:0">Люди в вашем пуле · ${pool.length}</div><div id="assignment-candidates">${pool.map(volunteer=>renderVolunteerChoice(volunteer)).join('')}</div></div><div><div class="preview-summary"><strong>Получат задание: <span id="preview-count">0</span></strong><small>Список перед отправкой</small></div><div id="assignment-preview"><p class="field-hint">Выберите людей, личные теги или способ массового назначения.</p></div></div><div class="notice" style="margin:0">Назначенная задача делает волонтёра занятым сразу. Можно назначить несколько задач одному человеку; недоступность и текущие задачи показаны выше.</div><div class="modal-footer"><button type="button" class="button secondary" data-action="close-modal">Отмена</button><button class="button primary" type="submit" id="assign-submit" disabled>${icon('send')}Отправить задание</button></div></form>`);
}
function renderVolunteerChoice(volunteer,preview=false) {
 const tasks=volunteerTaskList(volunteer);const free=volunteer.free ?? (volunteer.available&&!tasks.length);
 return `<label class="select-person">${preview?`<span class="avatar">${esc(initials(volunteer.name))}</span>`:`<input name="volunteerIds" type="checkbox" value="${volunteer.id}">`}<span class="person-info"><strong>${esc(volunteer.name)}</strong><p class="${!volunteer.available?'warning':''}">${!volunteer.available?'Недоступен':free?'Доступен · свободен':`Доступен · задач: ${tasks.length}`}${!volunteer.telegramId?' · Telegram не подключён':''}</p>${tasks.length?`<p>${tasks.map(task=>`#${task.id} ${esc(taskDescription(task))}${task.status==='queued'?' (ожидает принятия)':''}`).join('<br>')}</p>`:''}${personalNames(volunteer).length?`<p>${personalNames(volunteer).map(esc).join(' · ')}</p>`:''}</span></label>`;
}
async function refreshAssignmentPreview() {
 const form=$('#assignment-form');if(!form)return;
 const revision=++state.previewRevision;$('#assign-submit').disabled=true;
 const result=await post('/api/volunteers/preview',{mode:form.elements.mode.value,volunteerIds:selectedValues(form,'volunteerIds'),personalTagIds:selectedValues(form,'personalTagIds')});
 if(state.modalType!=='assignment'||!form.isConnected||revision!==state.previewRevision)return;
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
 const boxes=['incoming','outgoing','unaddressed',...(canManage()?['volunteer']:[])];
 const results=await Promise.all(boxes.map(box=>api(`/api/questions?box=${box}`)));
 const question=results.flatMap(result=>listFrom(result,'questions')).find(question=>Number(question.id)===Number(id));
 if(!question)throw new Error('Обсуждение закрыто или больше недоступно в вашей очереди.');
 await openTask(question.taskId);
 $(`[data-question="${id}"]`,$('#modal'))?.scrollIntoView({behavior:'smooth',block:'center'});
}
function showForwardQuestion(id) {
 const question=findQuestion(id);if(!question)return;
 state.returnTaskId=state.detailId;
 showModal('forward-question',`${modalHead('Передать вопрос направлениям',`Вопрос #${id} · задача #${question.taskId}`)}<form id="forward-question-form" class="modal-body form-stack" data-question-id="${id}"><div class="field"><span>Получатели</span><div class="check-grid">${checkTags('tagIds',question.tagIds)}</div><small>Совпадение хотя бы одного тега. Без тегов вопрос попадёт в общую очередь вопросов.</small></div><label class="field">Пояснение менеджера<textarea name="body" placeholder="Добавьте контекст для получателей" maxlength="10000"></textarea></label><div class="form-row"><label class="check-line"><input type="checkbox" name="blocking" ${question.blocking?'checked':''}>Блокирует выполнение</label><label class="field">Срочность<select name="urgency"><option value="normal" ${question.urgency==='normal'?'selected':''}>Обычная</option><option value="urgent" ${question.urgency==='urgent'?'selected':''}>Срочная</option></select></label></div><div class="modal-footer"><button type="button" class="button secondary" data-action="close-modal">Отмена</button><button type="submit" class="button primary">${icon('send')}Передать вопрос</button></div></form>`);
}
function showCloseQuestion(id) {
 state.returnTaskId=state.detailId;
 showModal('close-question',`${modalHead('Подтвердить решение вопроса',`Вопрос #${id}`)}<form id="close-question-form" class="modal-body form-stack" data-question-id="${id}"><div class="notice">Закрытие вопроса снимает только его блокировку. Другие открытые блокирующие вопросы продолжат блокировать задачу.</div><label class="field">Итоговое пояснение<textarea name="body" maxlength="10000" placeholder="Что решили? Для вопроса волонтёра пояснение уйдёт в Telegram."></textarea></label><div class="modal-footer"><button type="button" class="button secondary" data-action="close-modal">Отмена</button><button type="submit" class="button primary">${icon('check')}Вопрос решён</button></div></form>`);
}
function showPersonalTags(id) {
 const volunteer=state.volunteers.find(person=>Number(person.id)===Number(id));if(!volunteer)return;
 showModal('personal-tags',`${modalHead('Личные теги волонтёра',volunteer.name)}<form id="personal-tags-form" class="modal-body form-stack" data-volunteer-id="${id}"><label class="field">Теги через запятую<input name="names" value="${esc(personalNames(volunteer).join(', '))}" placeholder="Например: сцена, переноска, английский"><small>Эти теги видите только вы. Они помогают массово выбирать людей внутри вашего пула.</small></label>${state.boot.personalTags?.length?`<div class="field-hint">Ваши существующие теги: ${state.boot.personalTags.map(tag=>esc(tag.name)).join(', ')}</div>`:''}<div class="modal-footer"><button type="button" class="button secondary" data-action="close-modal">Отмена</button><button type="submit" class="button primary">Сохранить теги</button></div></form>`);
}
async function connectVolunteer(id) {
 const result=await post(`/api/volunteers/${Number(id)}/link`);
 const url=result.url;
 if(!/^https:\/\/t\.me\//.test(url || ''))throw new Error('Ссылка подключения пока недоступна. Проверьте настройку имени Telegram-бота.');
 showModal('volunteer-link',`${modalHead('Подключение Telegram',userName(id))}<div class="modal-body form-stack"><div class="link-result">Передайте эту личную ссылку волонтёру. Он должен открыть её в своём Telegram и нажать «Старт».<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a><small>Ссылка одноразовая. Действует до ${esc(dateText(result.expiresAt))}.</small></div><p class="field-hint">До первого сообщения волонтёра бот не сможет отправлять ему личные задания. Ссылка привязывает именно его учётную запись к выбранному участнику.</p><div class="modal-footer"><button class="button secondary" data-action="copy-link" data-url="${esc(url)}">Скопировать ссылку</button><button class="button primary" data-action="close-modal">Готово</button></div></div>`);
}
async function refreshBootstrap() {
 const csrf=state.boot?.csrf;
 const result=await api('/api/bootstrap');
 if(!csrf||state.boot?.csrf===csrf)state.boot=result;
}
async function refreshAfterAction(detailId=state.detailId) {
 await refreshBootstrap();await loadCurrent();
 if(detailId && state.modalType==='task'){const result=await api(`/api/tasks/${Number(detailId)}`);state.detail=result.task || result;renderTaskDetail();}
 if(state.view==='admin'&&!$('#modal').open)renderAdmin();
}
async function submitForm(form) {
 const data=new FormData(form);
 if(form.id==='login-form'){
  await post('/api/login',{login:data.get('login'),password:data.get('password')});await refreshBootstrap();
  state.view='tasks';state.scope=me().homeHallId?'home':'all';state.hallId='';state.tagId='';state.filters=initialFilters();renderShell();return;
 }
 if(form.id==='task-filters')return;
 if(form.id==='create-task-form'){
  const result=await post('/api/tasks',{description:data.get('description'),tagIds:selectedValues(form,'tagIds'),hallIds:selectedValues(form,'hallIds'),allHalls:data.has('allHalls')});
  const tasks=listFrom(result,'tasks');closeModal();await refreshAfterAction();toast(tasks.length>1?`Опубликовано выполнений по холлам: ${tasks.length}`:'Задача опубликована');if(tasks[0])await openTask(tasks[0].id);return;
 }
 if(form.id==='assignment-form'){
  const recipients=state.assignmentPreview || [];if(!recipients.length)throw new Error('Сначала выберите получателей задания.');
  await post(`/api/tasks/${Number(form.dataset.taskId)}/assign`,{mode:'manual',volunteerIds:ids(recipients.map(person=>person.id)),personalTagIds:[]});
  const taskId=Number(form.dataset.taskId);closeModal();await refreshAfterAction();await openTask(taskId);toast('Волонтёры назначены. Задания добавлены в очередь доставки.');return;
 }
 if(form.id==='new-question-form'){
  await post(`/api/tasks/${Number(form.dataset.taskId)}/questions`,{body:data.get('body'),tagIds:selectedValues(form,'tagIds'),blocking:data.has('blocking'),urgency:data.get('urgency')});
  form.reset();delete form.dataset.dirty;await refreshAfterAction();toast('Вопрос отправлен');return;
 }
 if(form.dataset.replyId){
  const body=String(data.get('body') || '').trim();if(!body)throw new Error('Напишите ответ.');await post(`/api/questions/${Number(form.dataset.replyId)}/reply`,{body});form.reset();delete form.dataset.dirty;await refreshAfterAction();toast('Ответ сохранён и отправлен участникам');return;
 }
 if(form.id==='forward-question-form'){
  await post(`/api/questions/${Number(form.dataset.questionId)}/forward`,{body:data.get('body'),tagIds:selectedValues(form,'tagIds'),blocking:data.has('blocking'),urgency:data.get('urgency')});
  const taskId=state.returnTaskId;closeModal();await refreshAfterAction();if(taskId)await openTask(taskId);toast('Вопрос передан выбранным направлениям');return;
 }
 if(form.id==='close-question-form'){
  await post(`/api/questions/${Number(form.dataset.questionId)}/close`,{body:data.get('body')});const taskId=state.returnTaskId;closeModal();await refreshAfterAction();if(taskId)await openTask(taskId);toast('Решение подтверждено. Вопрос закрыт.');return;
 }
 if(form.id==='task-reason-form'){
  const taskId=Number(form.dataset.taskId);await post(`/api/tasks/${taskId}/${form.dataset.taskAction}`,{reason:data.get('reason')});closeModal();await refreshAfterAction();await openTask(taskId);toast(form.dataset.taskAction==='reset'?'Задача возвращена в очередь':'Задача отменена');return;
 }
 if(form.id==='personal-tags-form'){
  await post(`/api/volunteers/${Number(form.dataset.volunteerId)}/tags`,{names:String(data.get('names')||'').split(',').map(name=>name.trim()).filter(Boolean)});closeModal();await refreshAfterAction();toast('Личные теги сохранены');return;
 }
 if(form.id==='cross-hall-form'){
  await post('/api/admin/settings',{crossHall:data.has('crossHall')});await refreshBootstrap();renderAdmin();toast('Настройка доступа сохранена');return;
 }
 if(form.id==='user-form'){
  const roles=$$('[name="roles"]:checked',form).map(input=>input.value);if(!roles.length)throw new Error('Выберите хотя бы одну возможность участника.');
  const input={name:data.get('name'),login:String(data.get('login')||'').trim()||null,roles,tagIds:selectedValues(form,'tagIds'),homeHallId:Number(data.get('homeHallId'))||null,managerId:Number(data.get('managerId'))||null,active:data.has('active')};
  if(form.dataset.userId)input.id=Number(form.dataset.userId);if(data.get('password'))input.password=data.get('password');
  await post('/api/admin/users',input);closeModal();await refreshBootstrap();renderAdmin();toast('Участник сохранён');return;
 }
 if(form.id==='tag-form'){
  const input={name:data.get('name'),kind:form.elements.kind.value};if(form.dataset.tagId)input.id=Number(form.dataset.tagId);await post('/api/admin/tags',input);closeModal();await refreshBootstrap();renderShell();toast('Общий тег сохранён');return;
 }
 if(form.id==='password-form'){
  await post('/api/change-password',{currentPassword:data.get('currentPassword'),password:data.get('password')});form.reset();toast('Пароль изменён');return;
 }
}
document.addEventListener('submit',async event=>{
 const form=event.target;if(!(form instanceof HTMLFormElement))return;event.preventDefault();
 const button=form.querySelector('button[type="submit"]');if(button?.disabled)return;if(button)button.disabled=true;
 try{await submitForm(form);}catch(error){if(form.id==='login-form'){let node=$('.inline-error',form);if(!node){node=document.createElement('div');node.className='inline-error';node.setAttribute('role','alert');form.append(node);}node.textContent=error.message;}else toast(error.message,true);}finally{if(button?.isConnected)button.disabled=false;}
});
document.addEventListener('click',async event=>{
 const button=event.target.closest('button,a,[data-action="dismiss-menu"]');if(!button)return;
 if(button.dataset.nav){event.preventDefault();const options={};for(const key of ['scope','hallId','tagId','box']){const value=button.dataset[key.toLowerCase()];if(value!==undefined)options[key]=value;}navigate(button.dataset.nav,options);return;}
 if(button.dataset.openTask){event.preventDefault();openTask(Number(button.dataset.openTask)).catch(error=>toast(error.message,true));return;}
 if(button.dataset.taskAction){button.disabled=true;try{await post(`/api/tasks/${Number(button.dataset.id)}/${button.dataset.taskAction}`);await refreshAfterAction();toast(button.dataset.taskAction==='claim'?'Задача взята в работу':'Задача выполнена');}catch(error){toast(error.message,true);}finally{if(button.isConnected)button.disabled=false;}return;}
 const action=button.dataset.action;if(!action)return;
 try{
  if(action==='menu')setMenu(!$('#sidebar').classList.contains('open'),true);
  else if(action==='dismiss-menu')setMenu(false,true);
  else if(action==='reload-view')renderPage();
  else if(action==='clear-filters'){state.filters=initialFilters();renderTasksPage();$('#task-filters input[name="q"]').focus();await loadCurrent();}
  else if(action==='close-modal')closeModal();
  else if(action==='create-task')showCreateTask();
  else if(action==='logout'){await post('/api/logout');state.boot=null;closeModal();renderLogin();}
  else if(action==='assign')await showAssignment(Number(button.dataset.id));
  else if(action==='reset-task')showReasonDialog(Number(button.dataset.id),'reset');
  else if(action==='cancel-task')showReasonDialog(Number(button.dataset.id),'cancel');
  else if(action==='close-question')showCloseQuestion(Number(button.dataset.id));
  else if(action==='forward-question')showForwardQuestion(Number(button.dataset.id));
  else if(action==='open-question')await openQuestion(Number(button.dataset.id));
  else if(action==='personal-tags')showPersonalTags(Number(button.dataset.id));
  else if(action==='connect-volunteer')await connectVolunteer(Number(button.dataset.id));
  else if(action==='edit-user')showUserForm(Number(button.dataset.id)||null);
  else if(action==='edit-tag')showTagForm(Number(button.dataset.id)||null);
  else if(action==='retry-delivery'){button.disabled=true;await post(`/api/deliveries/${Number(button.dataset.id)}/retry`);await loadCurrent();toast('Повторная отправка добавлена в очередь');}
  else if(action==='copy-link'){try{await navigator.clipboard.writeText(button.dataset.url);toast('Ссылка скопирована');}catch{toast('Выделите ссылку и скопируйте её вручную.',true);}}
 }catch(error){toast(error.message,true);if(button.isConnected)button.disabled=false;}
});
let searchTimer;
function hasQuestionDraft(root) { return !!root?.querySelector('form[data-dirty="1"]'); }
function markQuestionDraft(event) {
 const form=event.target.closest('#new-question-form,.reply-form');
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
  const form=$('#task-filters');state.filters={q:form.elements.q.value,status:form.elements.status.value,assignment:form.elements.assignment.value,blocked:form.elements.blocked.checked,openQuestions:form.elements.openQuestions.checked};loadCurrent().catch(error=>toast(error.message,true));
 }
 if(event.target.closest('#assignment-form'))refreshAssignmentPreview().catch(error=>toast(error.message,true));
 if(event.target.name==='allHalls'&&event.target.closest('#create-task-form'))$$('[name="hallIds"]',$('#create-task-form')).forEach(input=>{input.disabled=event.target.checked;});
});
$('#modal').addEventListener('close',()=>{state.modalType=null;state.detailId=null;state.detail=null;});
mobileViewport.addEventListener('change',()=>setMenu(false));
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&$('#sidebar')?.classList.contains('open'))setMenu(false,true);});
async function poll() {
 if(!state.boot||state.polling||document.hidden)return;state.polling=true;
 try{
  await refreshBootstrap();await loadCurrent();
  const focused=document.activeElement?.matches('input,textarea,select');
  if(state.detailId&&state.modalType==='task'&&!focused&&!hasQuestionDraft($('#modal'))){const id=state.detailId;const result=await api(`/api/tasks/${id}`);const detail=result.task||result;if(state.detailId===id&&state.modalType==='task'&&JSON.stringify(detail)!==JSON.stringify(state.detail)&&!document.activeElement?.closest('#modal form')){state.detail=detail;renderTaskDetail();}}
  state.offline=false;
  } catch {
   state.offline = true;
 } finally {
   state.polling = false;
   const connection = $("#connection");
   const syncLabel = $("#sync-label");
   for (const indicator of [connection, syncLabel]) {
     indicator?.classList.toggle("offline", state.offline);
   }
   if (connection) connection.textContent = state.offline ? "Нет связи · повторяем подключение" : "Синхронизация работает";
   if (syncLabel) syncLabel.textContent = state.offline ? "Нет связи" : "Синхронизация";
 }
}
async function init(){
 try{await refreshBootstrap();state.scope=me().homeHallId?'home':'all';renderShell();}
 catch(error){renderLogin(error.status===401?'':'Сервер недоступен. Проверьте подключение и попробуйте войти.');}
 setInterval(poll,4000);
}
init();
