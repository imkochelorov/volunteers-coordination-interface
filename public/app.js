import { $, $$, esc, icon, brand } from "./ui.js";
import { renderLoginScreen as renderLogin } from "./login-screen.js";

const initialFilters = () => ({status:"", assignment:"", q:"", blocked:false, openQuestions:false,
  tagIds:[], tagSet:"", sort:"priority"});
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
const tagColor = tag => /^#[0-9a-f]{6}$/i.test(tag?.color || "") ? tag.color : "";
function tagBadge(tag) {
  const color = tagColor(tag);
  const classes = ["tag", tag.kind === "hall" ? "hall" : "", color ? "tag-colored" : ""].filter(Boolean).join(" ");
  return `<span class="${classes}"${color ? ` style="--tag-color:${color}"` : ""}>${esc(tag.name)}</span>`;
}
const tagList = tagIds => (tagIds || []).map(id => tagBadge(getTag(id) || {name: tagName(id)})).join("");
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
  if (state.view === "tasks") {
    if (state.scope === "created") return "Созданные мной";
    if (state.scope === "assigned") return "Назначенные мне";
    if (state.scope === "home") return "Мой холл";
    if (state.scope === "hall") return tagName(state.hallId);
    return state.tagId ? tagName(state.tagId) : "Все задачи";
  }
  return {questions:{incoming:'Входящие вопросы',outgoing:'Исходящие вопросы',volunteer:'Вопросы волонтёров',unaddressed:'Вопросы без тегов'}[state.box],volunteers:'Мои волонтёры',admin:'Администрирование',deliveries:'Доставка в Telegram',account:'Мой профиль',notifications:'Уведомления'}[state.view] || 'связь?';
}
function navButton(view,label,iconName,extra={}) {
 const active=state.view===view && Object.entries(extra).every(([key,val])=>String(state[key])===String(val));
 return `<button type="button" class="nav-button ${active?'active':''}" data-nav="${view}" ${active?'aria-current="page"':''} ${Object.entries(extra).map(([key,val])=>`data-${key.toLowerCase()}="${esc(val)}"`).join(' ')}>${icon(iconName)}<span>${esc(label)}</span></button>`;
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
 if(open)$('.drawer-close').focus({preventScroll:true});
 else if(restoreFocus)trigger.focus({preventScroll:true});
}
function renderNavigation(user) {
  const all = { scope: "all", hallId: "", tagId: "" };
  return `<nav aria-label="Разделы приложения">
    <div class="nav-label">Задачи</div>
    ${user.homeHallId ? navButton("tasks", "Мой холл", "hall", {...all, scope: "home"}) : ""}
    ${navButton("tasks", "Все задачи", "grid", all)}
    ${navButton("tasks", "Созданные мной", "plus", {...all, scope: "created"})}
    ${navButton("tasks", "Назначенные мне", "check", {...all, scope: "assigned"})}
    ${canManage() ? navButton("volunteers", "Мои волонтёры", "users") : ""}
    <div class="nav-label">Вопросы и ответы</div>
    ${navButton("questions", "Входящие", "inbox", {box: "incoming"})}
    ${navButton("questions", "Исходящие", "send", {box: "outgoing"})}
    ${canManage() ? navButton("questions", "От волонтёров", "message", {box: "volunteer"}) : ""}
    ${navButton("questions", "Без тегов", "message", {box: "unaddressed"})}
    <div class="nav-label">Холлы</div>
    ${hallTags().map(tag => navButton("tasks", tag.name, "hall", {...all, scope: "hall", hallId: tag.id})).join("")}
    <details class="sidebar-directions" ${!mobileViewport.matches || state.tagId ? "open" : ""}>
      <summary class="nav-label">Направления</summary>
      ${directionTags().map(tag => navButton("tasks", tag.name, "tag", {...all, tagId: tag.id})).join("")}
    </details>
    ${canManage() ? `<div class="nav-label">Управление</div>${navButton("deliveries", "Доставка в Telegram", "send")}` : ""}
    ${hasRole("admin") ? navButton("admin", "Администрирование", "settings") : ""}
  </nav>`;
}

function renderShell() {
  const sidebarScroll = $("#sidebar")?.scrollTop ?? 0;
  const user = me();
  const roles = (user.roles || []).map(role => roleNames[role]).join(" · ");
  $("#app").innerHTML = `<div class="app-shell">
    <div class="menu-scrim" data-action="dismiss-menu" hidden></div>
    <aside class="sidebar" id="sidebar">
      <button class="icon-button drawer-close" type="button" data-action="dismiss-menu"
        aria-label="Закрыть навигацию">${icon("close")}</button>
      ${brand}
      ${renderNavigation(user)}
      <div class="sidebar-account">
        ${navButton("notifications", "Уведомления", "bell")}
        ${navButton("account", "Мой профиль", "users")}
        <button type="button" class="nav-button" data-action="logout">${icon("logout")}<span>Выйти</span></button>
      </div>
      <div class="sidebar-footer"><div class="connection" id="connection">Синхронизация работает</div></div>
    </aside>
    <main class="main">
      <header class="topbar ${state.view === "tasks" ? "topbar--board" : ""}">
        <button class="icon-button mobile-menu" data-action="menu" aria-label="Открыть навигацию"
          aria-controls="sidebar" aria-expanded="false">${icon("menu")}</button>
        ${state.view === "tasks"
          ? `<h1 class="board-title" tabindex="-1">${esc(titleForView())}</h1>`
          : `<div class="breadcrumb">NEERC / ICPC <span aria-hidden="true">·</span> <strong id="breadcrumb-title"></strong></div>`}
        ${state.view === "tasks" ? `<button type="button" class="icon-button board-create-mobile" data-action="create-task" aria-label="Создать задачу">${icon("plus")}</button>` : ""}
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
  $("#sidebar").scrollTop = sidebarScroll;
  return renderPage();
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
 return loadCurrent().catch(error=>{
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

const boardSortLabels = {priority: "По приоритету", newest: "Сначала новые", oldest: "Сначала старые", updated: "По обновлению"};
const boardTagSets = {assign: "Назначать", watch: "Наблюдать"};

function boardTagIds() {
  const {tagIds, tagSet} = state.filters;
  return tagSet ? state.boot.boardTagSets?.[tagSet] || [] : tagIds;
}

function boardFilterCount() {
  const {assignment, blocked, openQuestions, sort} = state.filters;
  return [assignment, blocked, openQuestions, boardTagIds().length, sort !== "priority"].filter(Boolean).length;
}

const assignmentLabels = {"": "Все назначения", free: "Без назначений", assigned: "С назначениями", waiting: "Ожидают принятия"};

function assignmentFilter(selected) {
  return `<details class="assignment-filter">
    <summary><span id="assignment-filter-value" data-assignment-state="${selected}">${assignmentLabels[selected]}</span></summary>
    <div class="assignment-filter-options" role="group" aria-label="Назначения">
      ${Object.entries(assignmentLabels).map(([value, label]) => `<label data-assignment-state="${value}">
        <input type="radio" name="assignment" value="${value}" ${selected === value ? "checked" : ""}><span>${label}</span>
      </label>`).join("")}
    </div>
  </details>`;
}

function renderTasksPage() {
  const otherHall = state.scope === "hall" && me().homeHallId && Number(state.hallId) !== Number(me().homeHallId);
  const readOnly = otherHall && !state.boot.settings.crossHall && !hasRole("admin");
  const filters = state.filters;
  $("#page-content").innerHTML = `
    <div class="board-tools">
      <form id="task-filters" class="filters">
        <label class="search">${icon("search")}
          <input type="search" name="q" value="${esc(filters.q)}" placeholder="Поиск задач" aria-label="Поиск по описанию или номеру">
        </label>
        <details class="board-filter-panel">
          <summary>${icon("filters")}<span>Фильтры</span><span id="board-filter-count" class="board-count" hidden></span></summary>
          <div class="board-filter-content">
            <div class="board-filter-row">
              ${assignmentFilter(filters.assignment)}
              <label class="field">Сортировка<select name="sort">
                ${Object.entries(boardSortLabels).map(([value, label]) => `<option value="${value}" ${value === filters.sort ? "selected" : ""}>${label}</option>`).join("")}
              </select></label>
            </div>
            <div class="filter-advanced">
              <label class="toggle-filter"><input type="checkbox" name="blocked" ${filters.blocked ? "checked" : ""}>Заблокированы</label>
              <label class="toggle-filter"><input type="checkbox" name="openQuestions" ${filters.openQuestions ? "checked" : ""}>Есть вопросы</label>
            </div>
            <div class="board-tag-sets" aria-label="Личные списки тегов" role="group">
              ${Object.entries(boardTagSets).map(([key, label]) => `<button class="button secondary small" type="button" data-board-tag-set="${key}" aria-pressed="${filters.tagSet === key}">${label}</button>`).join("")}
              <button class="muted-link" type="button" data-action="edit-board-tags">Настроить списки</button>
            </div>
            <fieldset class="board-tag-filter"><legend>Теги задач</legend>
              <div class="check-grid">${checkTags("tagIds", boardTagIds())}</div>
            </fieldset>
          </div>
        </details>
      </form>
      <div class="board-status-bar" role="group" aria-label="Фильтр по статусу">
        ${boardColumns.map(({status, label}) => `
          <button type="button" data-board-status="${status}" aria-pressed="${status === filters.status}">${label}</button>
        `).join("")}
      </div>
      <button class="button primary board-create-desktop" data-action="create-task">${icon("plus")} Создать задачу</button>
    </div>
    ${readOnly ? `<div class="notice warning">Задачи этого холла доступны для просмотра.</div>` : ""}
    <div class="board-summary">
      <span id="task-count"></span>
      ${state.boot.telegram?.configured === false ? '<small>Telegram не настроен</small>' : ""}
      <button class="muted-link" type="button" data-action="clear-filters" id="clear-task-filters" hidden>Сбросить фильтры</button>
      <small id="sync-label" class="sync-label" title="Синхронизация"><span>Синхронизация</span></small>
    </div>
    <div id="tasks-results"><div class="loading-line" role="status">Загружаем задачи…</div></div>`;
  syncTaskFilters();
}

function syncTaskFilters() {
  const assignment = $("#assignment-filter-value");
  assignment.textContent = assignmentLabels[state.filters.assignment];
  assignment.dataset.assignmentState = state.filters.assignment;
  for (const button of $$("[data-board-status]")) {
    button.setAttribute("aria-pressed", String(button.dataset.boardStatus === state.filters.status));
  }
  for (const button of $$("[data-board-tag-set]")) {
    button.setAttribute("aria-pressed", String(button.dataset.boardTagSet === state.filters.tagSet));
  }
  const selected = new Set(boardTagIds());
  for (const input of $$("#task-filters [name=tagIds]")) input.checked = selected.has(Number(input.value));
  const count = $("#board-filter-count");
  const active = boardFilterCount();
  count.textContent = active;
  count.hidden = active === 0;
}

const priorityLabels = {low: "Низкий", normal: "Обычный", high: "Высокий"};

function taskOptionBadges(task) {
  const priority = Object.hasOwn(priorityLabels, task.priority) ? task.priority : "normal";
  const priorityBadge = priority !== "normal"
    ? `<span class="tag task-priority" data-priority="${priority}">Приоритет: ${priorityLabels[priority].toLowerCase()}</span>` : "";
  const strong = task.needsStrongVolunteers ? '<span class="tag strong-volunteers">Нужны сильные волонтёры</span>' : "";
  const count = task.volunteerTarget ? `<span class="tag volunteer-target">${icon("users")} Нужно: ${esc(task.volunteerTarget)}</span>` : "";
  return priorityBadge + strong + count;
}

function taskAssignmentBadge(task) {
  const assignment = task.awaitingAcceptance ? "waiting"
    : task.claimedBy || task.assignments?.length ? "assigned" : "free";
  return `<span class="tag assignment-badge" data-assignment-state="${assignment}">${assignmentLabels[assignment]}</span>`;
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

const priorityRank = {low: 0, normal: 1, high: 2};
const taskTags = task => task.tagIds?.length ? task.tagIds : task.hallId ? [task.hallId] : [];

function sortBoardTasks(a, b) {
  const newest = Number(b.id) - Number(a.id);
  switch (state.filters.sort) {
    case "newest": return newest;
    case "oldest": return -newest;
    case "updated": return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || newest;
    default: return Number(Boolean(b.blocked)) - Number(Boolean(a.blocked)) ||
      (priorityRank[b.priority] ?? 1) - (priorityRank[a.priority] ?? 1) || newest;
  }
}

function combineHallTasks(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const key = task.groupId ? `group:${task.groupId}` : `task:${task.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  return [...groups.values()].map(members => {
    if (members.length === 1) return members[0];
    const representative = members.reduce((latest, task) => Number(task.id) > Number(latest.id) ? task : latest);
    const statuses = new Set(members.map(task => task.status));
    const partiallyFinished = statuses.has("queued") && (statuses.has("done") || statuses.has("cancelled"));
    const status = statuses.has("in_progress") || partiallyFinished ? "in_progress"
      : statuses.has("queued") ? "queued" : statuses.has("done") ? "done" : "cancelled";
    const highest = members.reduce((best, task) => (priorityRank[task.priority] ?? 1) > (priorityRank[best.priority] ?? 1) ? task : best);
    const updated = members.reduce((latest, task) => Date.parse(task.updatedAt) > Date.parse(latest.updatedAt) ? task : latest);
    return {...representative, status, priority:highest.priority, updatedAt:updated.updatedAt,
      blocked:members.some(task => task.blocked), openQuestions:members.reduce((count, task) => count + (Number(task.openQuestions) || 0), 0),
      needsStrongVolunteers:members.some(task => task.needsStrongVolunteers),
      tagIds:ids(members.flatMap(taskTags)).filter(id => getTag(id)?.kind !== "hall"), hallMembers:members};
  });
}

function renderHallGroupCard(task) {
  const members = task.hallMembers;
  const finished = members.filter(isTerminal).length;
  const stateClass = task.blocked ? " board-card--blocked" : task.openQuestions ? " board-card--questions" : "";
  return `<li><button class="board-card${stateClass}" data-open-task-group="${Number(task.id)}" type="button">
    <span class="board-card-heading">
      <span class="board-card-description">${esc(taskDescription(task))}</span>
      <span class="task-code">Холлов: ${members.length}</span>
    </span>
    <span class="board-card-meta"><span class="tag-list">
      ${task.blocked ? '<span class="status blocked">Заблокирована</span>' : ""}
      ${task.openQuestions ? `<span class="tag board-card-questions">${icon("message")} Вопросы · ${task.openQuestions}</span>` : ""}
      ${taskOptionBadges({...task, volunteerTarget:""})}${tagList(task.tagIds)}
      ${finished ? `<span class="tag">Закрыто ${finished} из ${members.length}</span>` : ""}
    </span>${icon("arrow")}</span>
  </button></li>`;
}

function renderTaskCard(task) {
  if (task.hallMembers) return renderHallGroupCard(task);
  const code = `#${String(task.id).padStart(3, "0")}`;
  const stateClass = task.blocked ? " board-card--blocked" : task.openQuestions ? " board-card--questions" : "";
  const badges = [
    task.blocked ? '<span class="status blocked">Заблокирована</span>' : "",
    task.openQuestions ? `<span class="tag board-card-questions" aria-label="Открытых вопросов: ${Number(task.openQuestions)}">${icon("message")} Вопросы · ${Number(task.openQuestions)}</span>` : "",
    taskOptionBadges(task),
    tagList(taskTags(task)),
    task.awaitingAcceptance ? taskAssignmentBadge(task) : "",
  ].join("");
  const assignees = taskAssignees(task);
  return `<li>
    <button class="board-card${stateClass}" data-open-task="${Number(task.id)}" type="button">
      <span class="board-card-heading">
        <span class="board-card-description">${esc(taskDescription(task))}</span>
        <span class="task-code">${code}</span>
      </span>
      ${badges || assignees ? `<span class="board-card-meta"><span class="tag-list">${badges}</span>${assignees}</span>` : ""}
    </button>
  </li>`;
}

function renderTaskResults() {
  const results = $("#tasks-results");
  if (!results) return;
  const statusFilter = mobileViewport.matches ? state.filters.status : "";
  const selectedTags = new Set(boardTagIds());
  const matching = state.tasks.filter(task => !selectedTags.size || taskTags(task).some(id => selectedTags.has(Number(id))));
  const boardTasks = state.scope === "all" && !state.hallId && !state.tagId ? combineHallTasks(matching) : matching;
  const tasks = boardTasks.filter(task => !statusFilter || task.status === statusFilter).sort(sortBoardTasks);
  $("#task-count").textContent = `Задач: ${tasks.length}`;
  $("#clear-task-filters").hidden = !boardFilterCount() && !statusFilter && !state.filters.q;
  const columns = boardColumns.filter(column => !statusFilter || column.status === statusFilter);
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
  const {q, assignment, blocked, openQuestions} = state.filters;
  const filters = {q, assignment, blocked, openQuestions};
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, typeof value === "boolean" ? "1" : value);
  const viewKey=`${state.view}:${state.scope}:${state.hallId}:${state.tagId}`;
  const revision=state.taskLoadRevision=(state.taskLoadRevision||0)+1;
  const result=await api(`/api/tasks?${params}`);
  if(revision!==state.taskLoadRevision || viewKey!==`${state.view}:${state.scope}:${state.hallId}:${state.tagId}`)return;
  const tasks=listFrom(result,'tasks');
  const signature = JSON.stringify([filters, tasks, state.boot.tags, boardTagIds()]);
  if (signature === state.taskRenderSignature && $("#tasks-results .task-board")) return;
  state.taskRenderSignature = signature;
  const focusedCard = document.activeElement?.closest(".board-card");
  const openAttribute = focusedCard?.hasAttribute("data-open-task-group") ? "data-open-task-group" : "data-open-task";
  const focus = focusedCard?.getAttribute(openAttribute);
  const scrollTop = window.scrollY;
  state.tasks=tasks;
  syncTaskFilters();
  renderTaskResults();
  if (window.scrollY !== scrollTop) window.scrollTo({top: scrollTop, behavior: "instant"});
  if (focus) $(`.board-card[${openAttribute}="${CSS.escape(focus)}"]`)?.focus({preventScroll:true});
 } else if(state.view==='questions'){
  const box=state.box;const result=await api(`/api/questions?box=${encodeURIComponent(box)}`);if(state.view!=='questions'||state.box!==box)return;
  state.questions=listFrom(result,'questions');if(!hasQuestionDraft($('#page-content')) && (!$('#page-content')?.contains(document.activeElement) || !document.activeElement.matches('input,textarea,select')))renderQuestionResults();
 } else if(state.view==='volunteers'){
  const result=await api('/api/volunteers');if(state.view!=='volunteers')return;state.volunteers=listFrom(result,'volunteers');renderVolunteers();
 } else if(state.view==='deliveries'){
  const result=await api('/api/deliveries');if(state.view!=='deliveries')return;state.deliveries=listFrom(result,'deliveries');renderDeliveries();
 }
}
const pageScroll = new Map();

function pageKey({view, scope, hallId, tagId, box}) {
  if (view === "tasks") return `${view}:${scope}:${hallId}:${tagId}`;
  return view === "questions" ? `${view}:${box}` : view;
}

function navigate(view, options = {}) {
  const from = pageKey(state);
  const to = pageKey({...state, ...options, view});
  if (from === to) {
    setMenu(false, mobileViewport.matches);
    return;
  }
  pageScroll.set(from, window.scrollY);
  Object.assign(state, options, {view});
  const ready = renderShell();
  const page = $("#page");
  const scrollTop = pageScroll.get(to) ?? 0;
  window.scrollTo({top: 0, behavior: "instant"});
  $(".main h1")?.focus({preventScroll: true});
  if (scrollTop) ready.then(() => {
    if ($("#page") === page && window.scrollY === 0) {
      window.scrollTo({top: scrollTop, behavior: "instant"});
    }
  });
}
function showModal(type,html) {
 const modal = $("#modal");
 const scrollTop = modal.open && state.modalType === type ? modal.scrollTop : 0;
 state.modalType = type;
 const layout = currentTaskLayout();
 if (layout) state.taskLayout = layout;
 modal.className = "modal";
 modal.dataset.kind = type;
 modal.innerHTML = html;
 if (!modal.open) modal.showModal();
 modal.scrollTop = scrollTop;
}
function closeModal(){const modal=$('#modal');if(modal.open)modal.close();state.modalType=null;state.detailId=null;state.detail=null;state.taskGroupEntry=null;}
const modalHead=(title,subtitle='')=>`<div class="modal-head"><div><h2>${esc(title)}</h2>${subtitle?`<small>${esc(subtitle)}</small>`:''}</div><button type="button" class="icon-button" data-action="close-modal" aria-label="Закрыть">${icon('close')}</button></div>`;
function checkTags(name,selected=[],tags=state.boot.tags){return tags.map(tag=>`<label class="check-pill"><input type="checkbox" name="${name}" value="${Number(tag.id)}" ${ids(selected).includes(Number(tag.id))?'checked':''}>${tagBadge(tag)}</label>`).join('');}
function selectedValues(form,name){return $$(`[name="${name}"]:checked`,form).map(input=>Number(input.value));}
function taskOptionsFields(task = {}) {
  return `<label class="field">Приоритет<select name="priority">
    ${Object.entries(priorityLabels).map(([key, label]) => `<option value="${key}" ${(task.priority || "normal") === key ? "selected" : ""}>${label}</option>`).join("")}
  </select></label>
  <label class="field">Сколько волонтёров<input name="volunteerTarget" maxlength="20" value="${esc(task.volunteerTarget || "")}" placeholder="2 или 2–3"></label>
  <label class="check-line"><input type="checkbox" name="needsStrongVolunteers" ${task.needsStrongVolunteers ? "checked" : ""}>Нужны сильные волонтёры</label>`;
}

function taskOptionsFrom(formData) {
  return {priority: formData.get("priority"), needsStrongVolunteers: formData.has("needsStrongVolunteers"),
    volunteerTarget: formData.get("volunteerTarget").trim()};
}

function showTaskOptions() {
  const task = state.detail;
  if (!task?.canEditOptions) return;
  showModal("task-options", `${modalHead("Приоритет и требования", `Задача #${task.id}`)}
    <form id="task-options-form" class="modal-body form-stack" data-task-id="${task.id}">
      ${taskOptionsFields(task)}
      <div class="modal-footer"><button type="button" class="button secondary" data-action="back-to-task">Отмена</button>
        <button type="submit" class="button primary">Сохранить</button></div>
    </form>`);
}

function showBoardTagSettings() {
  const tagSets = state.boot.boardTagSets || {};
  showModal("board-tags", `${modalHead("Личные списки тегов")}
    <form id="board-tags-form" class="modal-body form-stack">
      ${Object.entries(boardTagSets).map(([key, label]) => `<fieldset class="board-tag-filter">
        <legend>${label}</legend><div class="check-grid">${checkTags(key, tagSets[key])}</div>
      </fieldset>`).join("")}
      <div class="modal-footer"><button type="button" class="button secondary" data-action="close-modal">Отмена</button>
        <button class="button primary" type="submit">Сохранить</button></div>
    </form>`);
}

function showCreateTask() {
  showModal("create-task", `${modalHead("Новая задача")}
    <form id="create-task-form" class="modal-body form-stack">
      <label class="field">Описание<textarea name="description" rows="2" required maxlength="15000" placeholder="Что и где нужно сделать?"></textarea></label>
      <details class="create-task-destination" name="create-task-section">
        <summary>Холлы <span data-create-count="hallIds">Общая очередь</span></summary>
        <label class="check-line"><input type="checkbox" name="allHalls">Все холлы</label>
        <div class="check-grid">${checkTags("hallIds", [], hallTags())}</div>
      </details>
      <details class="create-task-destination" name="create-task-section">
        <summary>Теги <span data-create-count="tagIds">Не выбраны</span></summary>
        <div class="check-grid">${checkTags("tagIds", [], directionTags())}</div>
      </details>
      <details class="create-task-destination" name="create-task-section">
        <summary>Приоритет и волонтёры <span data-create-count="options"></span></summary>
        <div class="task-create-options">${taskOptionsFields()}</div>
      </details>
      <div class="modal-footer task-modal-footer"><button type="button" class="button secondary" data-action="close-modal">Отмена</button>
        <button class="button primary" type="submit">${icon("plus")} Опубликовать</button></div>
    </form>`);
}
async function openTaskGroup(id) {
  state.detailId = null;
  state.detail = null;
  state.taskGroupEntry = id;
  showModal("task-group", `${modalHead("Задача по холлам")}<div id="task-group-loading" class="loading-line" role="status">Загружаем холлы…</div>`);
  const loading = $("#task-group-loading");
  let result;
  try {
    result = await api(`/api/tasks/${id}`);
  } catch (error) {
    if (loading.isConnected && $("#modal").open) closeModal();
    throw error;
  }
  if (!loading.isConnected || !$("#modal").open) return;
  const task = result.task || result;
  const halls = task.siblings || [task];
  showModal("task-group", `${modalHead("Задача по холлам")}
    <div class="modal-body task-detail">
      <div class="detail-description">${esc(taskDescription(task))}</div>
      <div class="task-group-halls">${halls.map(hall => `<button type="button" class="task-group-hall" data-open-task="${Number(hall.id)}">
        ${icon("hall")}<strong>${esc(hall.hallId ? tagName(hall.hallId) : "Общая очередь")}</strong>
        <span class="tag-list">${hall.blocked ? '<span class="status blocked">Заблокирована</span>' : ""}${statusBadge(hall)}</span>
        ${icon("arrow")}</button>`).join("")}</div>
    </div>`);
}

async function openTask(id) {
 state.detailId=Number(id);showModal('task',`${modalHead('Загружаем задачу…')}<div class="loading-line">Получаем актуальные данные</div>`);
 $("#modal").scrollTop = 0;
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
function currentTaskLayout() {
  const root = $("#task-detail");
  if (!root || Number(root.dataset.taskId) !== state.detailId) return null;
  return {
    taskId: state.detailId,
    open: new Set($$("details[data-task-section][open]", root).map(section => section.dataset.taskSection)),
    scrollTop: $("#modal").scrollTop,
    drafts: $$("form[data-dirty='1']", root).map(form => [form.id || form.dataset.replyId, new FormData(form)]),
  };
}

function restoreTaskDrafts(layout) {
  for (const [key, values] of layout?.drafts || []) {
    const form = key === "new-question-form" ? $("#new-question-form") : $(`form[data-reply-id="${CSS.escape(key)}"]`);
    if (!form) continue;
    for (const input of form.elements) {
      if (!input.name) continue;
      if (input.type === "checkbox") input.checked = values.getAll(input.name).includes(input.value);
      else if (values.has(input.name)) input.value = values.get(input.name);
    }
    form.dataset.dirty = "1";
  }
}

function taskFold(key, label, body, openSections, className = "") {
  return `<details class="task-fold ${className}" data-task-section="${key}" ${openSections?.has(key) ? "open" : ""}>
    <summary>${label}</summary>${body}</details>`;
}

function questionStateLabel(question) {
  return {open: "Ждёт ответа", answered: "Есть ответ", closed: "Решён"}[question.state] || question.state;
}

function taskThread(question, openSections) {
  const blocked = question.blocking && question.state !== "closed";
  const excerpt = question.messages?.[0]?.body || question.body || `Вопрос #${question.id}`;
  return taskFold(`question-${question.id}`, `<span class="task-thread-summary"><strong>${esc(excerpt)}</strong>
    <span class="status ${blocked ? "blocked" : esc(question.state)}">${blocked ? "Блокирует" : esc(questionStateLabel(question))}</span></span>`,
    renderDiscussion(question, true), openSections, `task-thread${blocked ? " task-thread--blocking" : ""}`);
}

function taskQuestions(task, active, resolved, openSections) {
  const canAsk = isParticipant(task) && !isTerminal(task);
  const newQuestion = canAsk ? taskFold("new-question", `${icon("plus")} Задать вопрос`, `
    <form id="new-question-form" class="form-stack" data-task-id="${task.id}">
      <label class="field">Вопрос<textarea name="body" rows="2" required maxlength="10000"></textarea></label>
      <label class="check-line"><input type="checkbox" name="blocking">Блокирует работу</label>
      <details class="question-thread-options"><summary>Получатели и срочность</summary>
        <div class="check-grid">${checkTags("tagIds")}</div>
        <label class="field">Срочность<select name="urgency"><option value="normal">Обычная</option><option value="urgent">Срочная</option></select></label>
      </details>
      <button class="button primary small" type="submit">${icon("send")} Отправить</button>
    </form>`, openSections, "task-add-question") : "";
  if (!active.length && !resolved.length && !canAsk) return "";
  return `<section id="task-questions" class="task-detail-section" ${active.length || resolved.length ? 'aria-labelledby="task-questions-title"' : 'aria-label="Вопросы"'}>
    ${active.length || resolved.length ? `<h3 id="task-questions-title" tabindex="-1">Вопросы <span class="board-count">${active.length}</span></h3>` : ""}
    ${active.map(question => taskThread(question, openSections)).join("")}
    ${newQuestion}
    ${resolved.length ? taskFold("resolved", `Решённые · ${resolved.length}`,
      resolved.map(question => taskThread(question, openSections)).join(""), openSections) : ""}
  </section>`;
}

function renderTaskDetail() {
  const task = state.detail;
  if (!task || !$("#modal").open) return;
  const currentLayout = currentTaskLayout();
  const layout = currentLayout || (state.taskLayout?.taskId === Number(task.id) ? state.taskLayout : null);
  const openSections = layout?.open;
  const working = canWork(task);
  const participants = task.assignments || [];
  const free = working && task.status === "queued" && !task.claimedBy && !participants.length;
  const canAssign = free && canManage();
  const canFinish = task.status === "in_progress" && Number(task.claimedBy) === Number(me().id);
  const canReset = task.canReset ?? (!isTerminal(task) && isParticipant(task) && working);
  const siblings = task.siblings || [];
  const questions = task.questions || [];
  const active = questions.filter(question => question.state !== "closed").sort((a, b) => Number(b.blocking) - Number(a.blocking) || b.id - a.id);
  const resolved = questions.filter(question => question.state === "closed");
  const blockers = active.filter(question => question.blocking);
  const history = task.history || [];
  const staffList = participants.map(assignment => `<div class="task-person">${userAvatar(assignment.volunteerId)}
    <span>${esc(userName(assignment.volunteerId))}</span>
    <small>${assignment.acceptedAt ? "Принял задачу" : isTerminal(task) ? "Назначен" : "Ждёт принятия"}</small></div>`).join("");
  const metadata = `<p class="task-metadata">Автор: ${esc(userName(task.authorId))} · ${esc(dateText(task.createdAt))}</p>`;
  const actions = [
    canAssign ? `<button class="button primary" data-action="assign" data-id="${task.id}">${icon("users")} Назначить</button>` : "",
    free ? `<button class="button ${canAssign ? "secondary" : "primary"}" data-task-action="claim" data-id="${task.id}">${canAssign ? "Взять самому" : "Взять в работу"}</button>` : "",
    canFinish ? `<button class="button primary" data-task-action="complete" data-id="${task.id}">${icon("check")} Завершить</button>` : "",
    active.length && !blockers.length ? `<button class="button secondary" data-action="task-questions">${icon("message")} К вопросам</button>` : "",
  ].join("");
  const settings = [
    task.canEditOptions ? '<button class="button secondary small" data-action="edit-task-options">Приоритет и волонтёры</button>' : "",
    canReset ? `<button class="button secondary small" data-action="reset-task" data-id="${task.id}">Вернуть в очередь</button>
      <button class="button danger small" data-action="cancel-task" data-id="${task.id}">Отменить задачу</button>` : "",
  ].join("");
  const historyFold = history.length ? taskFold("history", `История · ${history.length}`, `<ol class="history">${history.slice().reverse().map(entry =>
    `<li>${esc(eventNames[entry.event || entry.action] || entry.event || entry.action || "Изменение задачи")}${entry.actorId ? ` · ${esc(userName(entry.actorId))}` : ""}${historyDetail(entry)}<small>${esc(dateText(entry.createdAt || entry.created_at))}</small></li>`).join("")}</ol>`, openSections) : "";
  const tags = ids([...(task.tagIds || []), task.hallId].filter(Boolean));
  showModal("task", `${modalHead(`Задача #${task.id}`)}
    <div class="modal-body task-detail" id="task-detail" data-task-id="${task.id}">
      ${state.taskGroupEntry ? `<button type="button" class="muted-link task-group-back" data-action="back-to-task-group">${icon("back")} К списку холлов</button>` : ""}
      <div class="tag-list">${statusBadge(task)}${taskOptionBadges(task)}${tagList(tags)}</div>
      <div class="detail-description">${esc(taskDescription(task))}</div>
      ${task.blocked ? `<div class="task-blocker-banner">${icon("alert")}<strong>Задача заблокирована</strong>
        ${blockers.length ? `<button type="button" class="muted-link" data-action="task-blockers">К блокерам · ${blockers.length}</button>` : ""}</div>` : ""}
      ${actions ? `<div class="actions task-primary-actions">${actions}</div>` : ""}
      ${!working && !isTerminal(task) ? '<div class="notice warning">Этот холл доступен для просмотра.</div>' : ""}
      ${taskQuestions(task, active, resolved, openSections)}
      ${participants.length || task.claimedBy || task.volunteerTarget ? `<section class="task-detail-section">
        <h3>Исполнители <span class="board-count">${participants.length || Number(Boolean(task.claimedBy))}</span></h3>
        ${staffList || (task.claimedBy ? `<div class="task-person">${userAvatar(task.claimedBy)}<span>${esc(userName(task.claimedBy))}</span></div>` : '<p class="muted">Пока нет</p>')}
      </section>` : ""}
      ${siblings.length > 1 ? taskFold("halls", `Выполнение по холлам · ${siblings.length}`, `<div class="siblings">${siblings.map(sibling =>
        `<button class="sibling ${Number(sibling.id) === Number(task.id) ? "current" : ""}" data-open-task="${sibling.id}"><span>${esc(sibling.hallId ? tagName(sibling.hallId) : "Общая")}</span>${statusBadge(sibling)}${sibling.blocked ? icon("alert") : ""}</button>`).join("")}</div>`, openSections) : ""}
      ${taskFold("settings", "Детали задачи", `${metadata}${settings ? `<div class="actions">${settings}</div>` : ""}${historyFold}`, openSections)}
    </div>`);
  restoreTaskDrafts(layout);
  if (!currentLayout && layout) $("#modal").scrollTop = layout.scrollTop;
}

function renderDiscussion(question, compact = false) {
  const messages = question.messages || [];
  const controls = Number(question.controllerId) === Number(me().id) || hasRole("admin");
  const canForward = question.source === "volunteer" && Number(question.controllerId) === Number(me().id) && !question.forwarded;
  const running = question.state !== "closed";
  return `<article class="discussion${compact ? " discussion--compact" : ""}" data-question="${question.id}">
    ${compact ? "" : `<div class="discussion-head"><div><h3>Вопрос #${question.id} · ${esc(userName(question.askedBy))}</h3>
      ${question.taskId && state.view === "questions" ? `<button class="muted-link" type="button" data-open-task="${question.taskId}">К задаче #${question.taskId}</button>` : ""}
      <div class="discussion-tags">${question.blocking && running ? '<span class="status blocked">Блокирует работу</span>' : ""}
      ${question.urgency === "urgent" ? '<span class="status waiting">Срочно</span>' : ""}${tagList(question.tagIds)}</div></div>
      <span class="status ${esc(question.state)}">${esc(questionStateLabel(question))}</span></div>`}
    <div class="discussion-body">${messages.length ? messages.map(message => `<div class="thread-message">
      <div class="message-meta"><strong>${esc(userName(message.authorId))}</strong><span>${esc(dateText(message.createdAt))}</span></div>
      <div class="message-body">${esc(message.body)}</div></div>`).join("") : `<div class="message-body">${esc(question.body || "")}</div>`}</div>
    ${compact && running && !controls && (question.blocking || question.state === "answered") ? `<small class="task-thread-controller">Подтверждает: ${esc(userName(question.controllerId))}</small>` : ""}
    ${running ? `<form class="reply-form" data-reply-id="${question.id}">
      <textarea name="body" rows="${compact ? 1 : 2}" required placeholder="Ответить…" aria-label="Ответ на вопрос #${question.id}" maxlength="10000"></textarea>
      <div class="reply-buttons"><button class="button primary small" type="submit">${icon("send")} Ответить</button>
      ${controls ? `<button class="button secondary small" type="button" data-action="close-question" data-id="${question.id}">${question.blocking ? "Разблокировать" : "Решено"}</button>` : ""}
      ${canForward ? `<button class="button ghost small" type="button" data-action="forward-question" data-id="${question.id}">Передать</button>` : ""}</div>
    </form>` : ""}
  </article>`;
}
function renderQuestionResults() {
 const target=$('#questions-results');if(!target)return;
 target.innerHTML=state.questions.length?state.questions.map(question => renderDiscussion(question)).join(''):empty('Новых вопросов нет',{incoming:'Здесь появятся вопросы, адресованные вашим общим тегам.',outgoing:'Вопросы, которые вы задали или передали направлениям, появятся здесь.',volunteer:'Вопросы волонтёров вашего пула поступают сюда из Telegram.',unaddressed:'Вопросы без выбранных тегов получателей появятся в этой общей очереди.'}[state.box]);
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
 $('#page-content').innerHTML=`<div class="admin-layout"><section class="panel admin-panel"><div class="section-toolbar"><h2>Участники мероприятия</h2><button class="button primary small" data-action="edit-user">${icon('plus')}Добавить</button></div>${users.map(user=>`<div class="admin-user"><span class="avatar">${esc(initials(user.name))}</span><div class="admin-user-info"><strong>${esc(user.name)}${user.active===false?' · отключён':''}</strong><small>${esc((user.roles || []).map(role=>roleNames[role]).join(' · '))}${user.managerId?' · менеджер: '+esc(userName(user.managerId)):''}</small><div class="tag-list" style="margin-top:6px">${tagList(user.tagIds)}</div></div><button class="button secondary small" data-action="edit-user" data-id="${user.id}">Изменить</button></div>`).join('')}</section><div><section class="panel admin-panel"><h2>Работа с другими холлами</h2><form id="cross-hall-form" class="form-stack"><label class="check-line"><input type="checkbox" name="crossHall" ${state.boot.settings.crossHall?'checked':''}>Разрешить работу с задачами других холлов</label><p class="field-hint">При выключенном флаге задачи других холлов доступны для просмотра. При включённом менеджеры могут брать их в работу и назначать свой пул.</p><div><button class="button primary small" type="submit">Сохранить настройку</button></div></form></section><section class="panel admin-panel" style="margin-top:20px"><div class="section-toolbar"><h2>Общие теги</h2><button class="button secondary small" data-action="edit-tag">${icon('plus')}Добавить</button></div><p class="field-hint">Общие теги направлений и холлов. Личные теги менеджеров хранятся отдельно.</p><div style="margin-top:14px">${state.boot.tags.map(tag=>`<div class="admin-user"><div class="admin-user-info">${tagBadge(tag)}<small>${tag.kind==='hall'?'Холл · отдельный статус выполнения':'Направление'}</small></div><button class="button ghost small" data-action="edit-tag" data-id="${tag.id}">Изменить</button></div>`).join('')}</div></section></div></div>`;
}
function showUserForm(id) {
 const user=id?getUser(id):{roles:['volunteer'],tagIds:[],active:true};
 if(!user)return;
 showModal('edit-user',`${modalHead(id?'Изменить участника':'Новый участник','Роли могут совмещаться. Волонтёр работает через Telegram.')}<form id="user-form" class="modal-body form-stack" data-user-id="${id||''}"><div class="form-row"><label class="field">Имя<input name="name" required maxlength="160" value="${esc(user.name)}"></label><label class="field">Логин для веба<input name="login" maxlength="100" value="${esc(user.login)}" autocomplete="off"><small>Нужен организаторам, менеджерам и администраторам.</small></label></div><label class="field">${id?'Новый пароль':'Пароль для веба'}<input name="password" type="password" minlength="12" autocomplete="new-password" placeholder="${id?'Оставьте пустым, чтобы сохранить пароль':'Не менее 12 символов'}"></label><div class="field"><span>Возможности</span><div class="check-grid">${Object.entries(roleNames).map(([role,name])=>`<label class="check-pill"><input type="checkbox" name="roles" value="${role}" ${(user.roles||[]).includes(role)?'checked':''}>${esc(name)}</label>`).join('')}</div></div><div class="field"><span>Общие теги</span><div class="check-grid">${checkTags('tagIds',user.tagIds)}</div></div><div class="form-row"><label class="field">Основной холл<select name="homeHallId"><option value="">Не назначен</option>${hallTags().map(tag=>`<option value="${tag.id}" ${Number(user.homeHallId)===Number(tag.id)?'selected':''}>${esc(tag.name)}</option>`).join('')}</select></label><label class="field">Менеджер волонтёра<select name="managerId"><option value="">Не закреплён</option>${state.boot.users.filter(candidate=>(candidate.roles||[]).includes('manager')&&Number(candidate.id)!==Number(id)).map(candidate=>`<option value="${candidate.id}" ${Number(user.managerId)===Number(candidate.id)?'selected':''}>${esc(candidate.name)}</option>`).join('')}</select></label></div><label class="check-line"><input type="checkbox" name="active" ${user.active!==false&&user.active!==0?'checked':''}>Доступ активен</label><div class="modal-footer"><button type="button" class="button secondary" data-action="close-modal">Отмена</button><button type="submit" class="button primary">Сохранить участника</button></div></form>`);
}
function showTagForm(id) {
 const tag=id?getTag(id):{name:'',kind:'direction'};
 showModal('edit-tag',`${modalHead(id?'Изменить общий тег':'Новый общий тег')}<form id="tag-form" data-tag-id="${id||''}" class="modal-body form-stack"><label class="field">Название<input name="name" value="${esc(tag.name)}" required maxlength="80"></label><label class="field">Тип<select name="kind" ${id?'disabled':''}><option value="direction" ${tag.kind==='direction'?'selected':''}>Направление</option><option value="hall" ${tag.kind==='hall'?'selected':''}>Холл</option></select><small>Холл создаёт отдельное выполнение задачи при публикации на несколько холлов.</small></label><label class="field">Цвет тега<input type="color" name="color" value="${tagColor(tag) || '#293dd4'}"></label><label class="check-line"><input type="checkbox" name="useColor" ${tagColor(tag) ? 'checked' : ''}>Использовать выбранный цвет</label><div class="modal-footer"><button type="button" class="button secondary" data-action="close-modal">Отмена</button><button class="button primary" type="submit">Сохранить тег</button></div></form>`);
}
function renderAccount() {
 $('#page-content').innerHTML=`<section class="panel account-panel"><h2>Изменить пароль</h2><form id="password-form" class="form-stack" style="margin-top:22px"><label class="field">Текущий пароль<input type="password" name="currentPassword" required autocomplete="current-password"></label><label class="field">Новый пароль<input type="password" name="password" required minlength="12" autocomplete="new-password"><small>Не менее 12 символов.</small></label><button class="button primary" type="submit">Сохранить новый пароль</button></form><div class="admin-block"><button class="button secondary" data-action="logout">${icon('logout')}Выйти</button></div></section>`;
}
function renderNotifications() {
 const notifications=state.boot.notifications || [];
 $('#page-content').innerHTML=`<section class="panel admin-panel">${notifications.length?`<ul class="notification-list">${notifications.slice().reverse().map(notification=>`<li><p>${esc(notification.text || notification.body || notification.message || 'Обновление обсуждения')}</p><small>${esc(dateText(notification.createdAt || notification.created_at))}</small>${notification.taskId?` <button class="muted-link" data-open-task="${notification.taskId}">${notification.questionId?'Открыть вопрос #'+notification.questionId:'Открыть задачу #'+notification.taskId}</button>`:notification.questionId?` <button class="muted-link" data-action="open-question" data-id="${notification.questionId}">Открыть вопрос #${notification.questionId}</button>`:''}</li>`).join('')}</ul>`:empty('Новых уведомлений нет','Вопросы и обновления, адресованные вам, появятся здесь.')}</section>`;
}
async function showAssignment(taskId) {
  const task = state.detail;
  if (!task || Number(task.id) !== Number(taskId)) return;
  const result = await api("/api/volunteers");
  if (state.modalType !== "task" || state.detail !== task && state.detailId !== Number(taskId)) return;
  state.volunteers = listFrom(result, "volunteers");
  const pool = state.volunteers.filter(volunteer => Number(volunteer.managerId) === Number(me().id))
    .sort((a, b) => Number(Boolean(b.free)) - Number(Boolean(a.free)));
  state.assignmentPreview = [];
  state.previewRevision = 0;
  const tags = state.boot.personalTags || [];
  showModal("assignment", `${modalHead("Назначить волонтёров", `Задача #${taskId}`)}
    <form id="assignment-form" class="modal-body form-stack" data-task-id="${taskId}" data-volunteer-target="${esc(task.volunteerTarget || "")}">
      ${pool.length ? `<label class="field">Поиск по имени или тегу<input type="search" name="volunteerQuery" placeholder="Найти в своём пуле"></label>
        <details class="task-fold assignment-bulk"><summary>Массовый выбор</summary>
          <label class="field">Добавить к выбору<select name="mode"><option value="manual">Только выбранные вручную</option>
            <option value="free">Всех свободных</option><option value="all">Весь пул</option></select></label>
          ${tags.length ? `<div class="check-grid">${tags.map(tag => `<label class="check-pill"><input type="checkbox" name="personalTagIds" value="${tag.id}">${esc(tag.name)}</label>`).join("")}</div>` : ""}
        </details>
        <div id="assignment-candidates" class="assignment-candidates">${pool.map(renderVolunteerChoice).join("")}</div>
        <p id="assignment-no-result" class="muted" hidden>Никого не нашли</p>`
        : '<input type="hidden" name="mode" value="manual"><p class="muted">В вашем пуле пока нет волонтёров.</p>'}
      <details id="assignment-recipients" class="task-fold" hidden><summary>Получатели</summary><ul id="assignment-preview"></ul></details>
      <div class="modal-footer task-modal-footer">
        <span id="assignment-progress" aria-live="polite">Выбрано: 0${task.volunteerTarget ? ` / нужно ${esc(task.volunteerTarget)}` : ""}</span>
        <button type="button" class="button secondary" data-action="back-to-task">${icon("back")} Назад</button>
        <button class="button primary" type="submit" id="assign-submit" disabled>${icon("send")} Назначить</button>
      </div>
    </form>`);
}

function renderVolunteerChoice(volunteer) {
  const tasks = volunteerTaskList(volunteer);
  const tags = personalNames(volunteer);
  const free = volunteer.free ?? (volunteer.available && !tasks.length);
  const status = !volunteer.available ? "Недоступен" : free ? "Свободен" : `Задач: ${tasks.length}`;
  const search = [volunteer.name, ...tags].join(" ").toLowerCase();
  return `<label class="select-person assignment-person" data-volunteer-search="${esc(search)}">
    <input name="volunteerIds" type="checkbox" value="${volunteer.id}">
    <span class="person-info"><strong>${esc(volunteer.name)}</strong><small>${esc(status)}${!volunteer.telegramId ? " · Без Telegram" : ""}</small></span>
    ${tags.length ? `<small class="assignment-person-tags">${tags.map(esc).join(" · ")}</small>` : ""}</label>`;
}

async function refreshAssignmentPreview(form) {
  const revision = ++state.previewRevision;
  $("#assign-submit", form).disabled = true;
  const result = await post("/api/volunteers/preview", {mode:form.elements.mode.value,
    volunteerIds:selectedValues(form,"volunteerIds"), personalTagIds:selectedValues(form,"personalTagIds")});
  if (state.modalType !== "assignment" || !form.isConnected || revision !== state.previewRevision) return;
  state.assignmentPreview = listFrom(result, "volunteers");
  const count = state.assignmentPreview.length;
  const target = form.dataset.volunteerTarget;
  const progress = $("#assignment-progress", form);
  progress.textContent = `Выбрано: ${count}${target ? ` / нужно ${target}` : ""}`;
  const [min, max = min] = target.split("–").map(Number);
  progress.classList.toggle("assignment-count-mismatch", Boolean(target) && (count < min || count > max));
  $("#assignment-recipients", form).hidden = count === 0;
  $("#assignment-preview", form).innerHTML = state.assignmentPreview.map(volunteer => `<li>${esc(volunteer.name)}</li>`).join("");
  $("#assign-submit", form).disabled = count === 0;
}
function showReasonDialog(taskId,action) {
 state.returnTaskId=Number(taskId);
 const reset=action==='reset';
 showModal('task-reason',`${modalHead(reset?'Вернуть задачу в очередь':'Отменить задачу',`Задача #${taskId}`)}<form id="task-reason-form" data-task-id="${taskId}" data-task-action="${action}" class="modal-body form-stack"><div class="notice ${reset?'warning':''}">${reset?'Текущие назначения будут сняты, кнопки старых заданий перестанут действовать. После возврата задачу можно взять в работу или назначить заново.':'Выполнение больше не требуется. Назначенные волонтёры увидят отмену в Telegram.'}</div><label class="field">Причина<textarea name="reason" required maxlength="2000" placeholder="Коротко объясните изменение"></textarea></label><div class="modal-footer"><button type="button" class="button secondary" data-action="close-modal">Не менять</button><button type="submit" class="button ${reset?'primary':'danger'}">${reset?'Вернуть в очередь':'Отменить задачу'}</button></div></form>`);
}
function findQuestion(id){return [...(state.detail?.questions||[]),...state.questions].find(question=>Number(question.id)===Number(id));}
async function openQuestion(id) {
 const boxes=['incoming','outgoing','unaddressed',...(canManage()?['volunteer']:[])];
 const results=await Promise.all(boxes.map(box=>api(`/api/questions?box=${box}`)));
 const question=results.flatMap(result=>listFrom(result,'questions')).find(question=>Number(question.id)===Number(id));
 if(!question)throw new Error('Обсуждение закрыто или больше недоступно в вашей очереди.');
 await openTask(question.taskId);
 const thread = $(`[data-question="${CSS.escape(String(id))}"]`, $("#modal"));
 if (!thread) return;
 const parent = thread.closest(".task-thread");
 const resolved = parent?.closest('[data-task-section="resolved"]');
 if (resolved) resolved.open = true;
 if (parent) parent.open = true;
 parent?.scrollIntoView({block:"start"});
}
function showForwardQuestion(id) {
 const question=findQuestion(id);if(!question)return;
 state.returnTaskId=state.detailId;
 showModal('forward-question',`${modalHead('Передать вопрос направлениям',`Вопрос #${id} · задача #${question.taskId}`)}<form id="forward-question-form" class="modal-body form-stack" data-question-id="${id}"><div class="field"><span>Получатели</span><div class="check-grid">${checkTags('tagIds',question.tagIds)}</div><small>Совпадение хотя бы одного тега. Без тегов вопрос попадёт в общую очередь вопросов.</small></div><label class="field">Пояснение менеджера<textarea name="body" placeholder="Добавьте контекст для получателей" maxlength="10000"></textarea></label><div class="form-row"><label class="check-line"><input type="checkbox" name="blocking" ${question.blocking?'checked':''}>Блокирует выполнение</label><label class="field">Срочность<select name="urgency"><option value="normal" ${question.urgency==='normal'?'selected':''}>Обычная</option><option value="urgent" ${question.urgency==='urgent'?'selected':''}>Срочная</option></select></label></div><div class="modal-footer"><button type="button" class="button secondary" data-action="close-modal">Отмена</button><button type="submit" class="button primary">${icon('send')}Передать вопрос</button></div></form>`);
}
function showCloseQuestion(id) {
  const question = findQuestion(id);
  if (!question || question.state === "closed") return;
  state.returnTaskId = state.detailId;
  const title = question.blocking ? "Снять блокировку" : "Отметить вопрос решённым";
  const others = state.detail?.questions?.filter(item => item.id !== question.id && item.blocking && item.state !== "closed").length;
  showModal("close-question", `${modalHead(title, `Вопрос #${id}`)}
    <form id="close-question-form" class="modal-body form-stack" data-question-id="${id}">
      ${question.blocking && others ? `<p class="muted">Другие блокеры останутся: ${others}</p>` : ""}
      <label class="field">Решение <small>Необязательно</small><textarea name="body" rows="2" maxlength="10000" placeholder="Что решили?"></textarea></label>
      <div class="modal-footer task-modal-footer"><button type="button" class="button secondary" data-action="${state.detailId ? "back-to-task" : "close-modal"}">${icon("back")} Назад</button>
        <button type="submit" class="button primary">${icon("check")} ${question.blocking ? "Снять блокировку" : "Закрыть вопрос"}</button></div>
    </form>`);
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
 if (detailId && state.modalType === "task" && state.detailId === detailId) {
   const result = await api(`/api/tasks/${Number(detailId)}`);
   if (state.detailId === detailId && state.modalType === "task") {
     state.detail = result.task || result;
     renderTaskDetail();
   }
 }
 if(state.view==='admin'&&!$('#modal').open)renderAdmin();
}
async function submitForm(form) {
 const data=new FormData(form);
 if(form.id==='login-form'){
  await post('/api/login',{login:data.get('login'),password:data.get('password')});await refreshBootstrap();
  pageScroll.clear();state.view='tasks';state.scope='all';state.hallId='';state.tagId='';state.filters=initialFilters();renderShell();return;
 }
 if(form.id==='task-filters')return;
 if (form.id === "board-tags-form") {
  const tagSets = Object.fromEntries(Object.keys(boardTagSets).map(key => [key, selectedValues(form, key)]));
  const saved = await post("/api/board/tag-sets", tagSets);
  state.boot.boardTagSets = saved;
  if (state.filters.tagSet && !saved[state.filters.tagSet]?.length) state.filters.tagSet = "";
  closeModal();
  if ($("#task-filters")) {
    syncTaskFilters();
    if ($("#tasks-results .task-board")) renderTaskResults();
  }
  toast("Списки тегов сохранены");
  return;
 }
 if(form.id==='create-task-form'){
  const result=await post('/api/tasks',{description:data.get('description'),tagIds:selectedValues(form,'tagIds'),hallIds:selectedValues(form,'hallIds'),allHalls:data.has('allHalls'),...taskOptionsFrom(data)});
  const tasks=listFrom(result,'tasks');closeModal();await refreshAfterAction();toast(tasks.length>1?`Опубликовано выполнений по холлам: ${tasks.length}`:'Задача опубликована');if(tasks[0])await openTask(tasks[0].id);return;
 }
 if (form.id === "task-options-form") {
  const taskId = Number(form.dataset.taskId);
  const result = await post(`/api/tasks/${taskId}/options`, taskOptionsFrom(data));
  if (state.modalType === "task-options" && state.detailId === taskId) {
    state.detail = result.task || result;
    renderTaskDetail();
  }
  await loadCurrent();
  toast("Приоритет и требования сохранены");
  return;
 }
 if(form.id==='assignment-form'){
  const recipients=state.assignmentPreview || [];if(!recipients.length)throw new Error('Сначала выберите получателей задания.');
  const taskId = Number(form.dataset.taskId);
  const result = await post(`/api/tasks/${taskId}/assign`, {mode:"manual", volunteerIds:ids(recipients.map(person => person.id))});
  if (form.isConnected && state.detailId === taskId) {
    state.detail = result.task || result;
    renderTaskDetail();
  }
  await loadCurrent();
  toast("Волонтёры назначены");
  return;
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
  const taskId = state.returnTaskId;
  await post(`/api/questions/${Number(form.dataset.questionId)}/close`, {body:data.get("body")});
  if (form.isConnected) {
    if (taskId) await openTask(taskId);
    else closeModal();
  }
  await loadCurrent();
  toast("Вопрос решён");
  return;
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
  const input={name:data.get('name'),kind:form.elements.kind.value,color:data.has('useColor') ? data.get('color') : ''};if(form.dataset.tagId)input.id=Number(form.dataset.tagId);await post('/api/admin/tags',input);closeModal();await refreshBootstrap();renderShell();toast('Общий тег сохранён');return;
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
 const assignmentMenu = $(".assignment-filter[open]");
 if (assignmentMenu && !assignmentMenu.contains(event.target)) assignmentMenu.open = false;
 const boardFilters = $(".board-filter-panel[open]");
 if (boardFilters && !boardFilters.contains(event.target) && !$("#modal").open &&
     !event.target.closest('[data-action="clear-filters"]')) boardFilters.open = false;
 const button=event.target.closest('button,a,[data-action="dismiss-menu"]');if(!button)return;
 if(button.dataset.nav){event.preventDefault();const options={};for(const key of ['scope','hallId','tagId','box']){const value=button.dataset[key.toLowerCase()];if(value!==undefined)options[key]=value;}navigate(button.dataset.nav,options);return;}
 if (button.dataset.openTaskGroup) {
   openTaskGroup(Number(button.dataset.openTaskGroup)).catch(error => toast(error.message,true));
   return;
 }
 if(button.dataset.openTask){event.preventDefault();openTask(Number(button.dataset.openTask)).catch(error=>toast(error.message,true));return;}
 if(button.dataset.taskAction){button.disabled=true;try{await post(`/api/tasks/${Number(button.dataset.id)}/${button.dataset.taskAction}`);await refreshAfterAction();toast(button.dataset.taskAction==='claim'?'Задача взята в работу':'Задача выполнена');}catch(error){toast(error.message,true);}finally{if(button.isConnected)button.disabled=false;}return;}
 if (button.hasAttribute("data-board-tag-set")) {
   const key = button.dataset.boardTagSet;
   if (!state.boot.boardTagSets?.[key]?.length) {
     showBoardTagSettings();
     return;
   }
   state.filters.tagSet = state.filters.tagSet === key ? "" : key;
   state.filters.tagIds = [];
   syncTaskFilters();
   if ($("#tasks-results .task-board")) renderTaskResults();
   return;
 }
 if (button.hasAttribute("data-board-status")) {
   const status = button.dataset.boardStatus;
   state.filters.status = state.filters.status === status ? "" : status;
   syncTaskFilters();
   if ($("#tasks-results .task-board")) renderTaskResults();
   return;
 }
 const action=button.dataset.action;if(!action)return;
 try{
  if(action==='menu')setMenu(!$('#sidebar').classList.contains('open'),true);
  else if(action==='dismiss-menu')setMenu(false,true);
  else if(action==='reload-view')renderPage();
  else if(action==='clear-filters'){
    state.filters = initialFilters();
    const form = $("#task-filters");
    for (const name of ["q", "assignment", "blocked", "openQuestions", "sort"]) {
      const value = state.filters[name];
      const control = form.elements[name];
      if (!control) continue;
      if (typeof value === "boolean") control.checked = value;
      else control.value = value;
    }
    syncTaskFilters();
    if ($("#tasks-results .task-board")) renderTaskResults();
    form.elements.q.focus({preventScroll: true});
    await loadCurrent();
  }
  else if(action==='close-modal')closeModal();
  else if(action==='create-task')showCreateTask();
  else if(action==='edit-board-tags')showBoardTagSettings();
  else if(action==='edit-task-options')showTaskOptions();
  else if(action==='back-to-task')renderTaskDetail();
  else if(action==='back-to-task-group' && state.taskGroupEntry)await openTaskGroup(state.taskGroupEntry);
  else if(action==='task-questions'||action==='task-blockers'){
    const target = action === "task-blockers" ? $(".task-thread--blocking > summary") : $("#task-questions-title");
    if (action === "task-blockers" && target) target.parentElement.open = true;
    target?.scrollIntoView({block:"start"});
    target?.focus({preventScroll:true});
  }
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
 if (event.target.matches('#assignment-form [name="volunteerQuery"]')) {
   const query = event.target.value.trim().toLowerCase();
   let found = false;
   for (const candidate of $$("[data-volunteer-search]", event.target.form)) {
     candidate.hidden = !candidate.dataset.volunteerSearch.includes(query);
     found ||= !candidate.hidden;
   }
   $("#assignment-no-result", event.target.form).hidden = found;
 }
 if(event.target.matches('#task-filters [name="q"]')){
  state.filters.q=event.target.value;
  clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadCurrent().catch(error=>toast(error.message,true)),250);
 }
});
document.addEventListener('change',event=>{
 markQuestionDraft(event);
 if(event.target.closest('#task-filters')){
  const form = $("#task-filters");
  if (event.target.name === "tagIds" || event.target.name === "sort") {
    if (event.target.name === "tagIds") {
      state.filters.tagSet = "";
      state.filters.tagIds = selectedValues(form, "tagIds");
    } else state.filters.sort = form.elements.sort.value;
    syncTaskFilters();
    if ($("#tasks-results .task-board")) renderTaskResults();
    return;
  }
  Object.assign(state.filters, {
    q: form.elements.q.value, assignment: form.elements.assignment.value,
    blocked: form.elements.blocked.checked, openQuestions: form.elements.openQuestions.checked,
  });
  syncTaskFilters();
  const menu = event.target.closest(".assignment-filter");
  if (menu) {
    menu.open = false;
    $("summary", menu).focus({preventScroll: true});
  }
  clearTimeout(searchTimer);
  loadCurrent().catch(error => toast(error.message, true));
 }
 if (event.target.matches('#tag-form [name="color"]')) event.target.form.elements.useColor.checked = true;
 if (event.target.matches('#assignment-form :is([name="mode"], [name="volunteerIds"], [name="personalTagIds"])')) {
   refreshAssignmentPreview(event.target.form).catch(error => toast(error.message, true));
 }
 const createForm = event.target.closest("#create-task-form");
 if (createForm) {
   const options = [createForm.elements.volunteerTarget.value.trim(),
     createForm.elements.priority.value === "normal" ? "" : priorityLabels[createForm.elements.priority.value],
     createForm.elements.needsStrongVolunteers.checked ? "Сильные" : ""].filter(Boolean);
   $("[data-create-count=options]", createForm).textContent = options.join(" · ");
   const all = createForm.elements.allHalls.checked;
   for (const input of $$('[name="hallIds"]', createForm)) input.disabled = all;
   const halls = selectedValues(createForm, "hallIds").length;
   const tags = selectedValues(createForm, "tagIds").length;
   $("[data-create-count=hallIds]", createForm).textContent = all ? "Все холлы" : halls || "Общая очередь";
   $("[data-create-count=tagIds]", createForm).textContent = tags || "Не выбраны";
 }
});
$("#modal").addEventListener("close", event => {
  if (event.target.open) return;
  state.modalType = null;
  state.detailId = null;
  state.detail = null;
  state.taskLayout = null;
  state.taskGroupEntry = null;
});
mobileViewport.addEventListener("change", () => {
  setMenu(false);
  if ($("#tasks-results .task-board")) renderTaskResults();
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  const menu = event.target.closest(".assignment-filter[open]") || event.target.closest(".board-filter-panel[open]");
  if (menu) {
    menu.open = false;
    $("summary", menu).focus({preventScroll: true});
    event.preventDefault();
  } else if ($("#sidebar")?.classList.contains("open")) setMenu(false, true);
});
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
   if (syncLabel) {
     const label = state.offline ? "Нет связи" : "Синхронизация";
     $("span", syncLabel).textContent = label;
     syncLabel.title = label;
   }
 }
}
async function init(){
 try{await refreshBootstrap();renderShell();}
 catch(error){renderLogin(error.status===401?'':'Сервер недоступен. Проверьте подключение и попробуйте войти.');}
 setInterval(poll,4000);
}
init();
