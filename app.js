import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  deleteField,
  writeBatch,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
import {
  getStorage,
  ref as storageRef,
  uploadBytes,
  getDownloadURL,
  deleteObject,
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyD3X0A-r34omGmCmm2v1eXIm_bATY6G_Yw",
  authDomain: "content-planner-aef9e.firebaseapp.com",
  projectId: "content-planner-aef9e",
  storageBucket: "content-planner-aef9e.firebasestorage.app",
  messagingSenderId: "879380511083",
  appId: "1:879380511083:web:a1e8f9a5f0d5cdb372b42e",
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
auth.languageCode = "ru";
const db = getFirestore(firebaseApp);
const storage = getStorage(firebaseApp);
const app = document.querySelector("#app");

const ROLE_LABELS = {
  owner: "Владелец",
  editor: "Редактор",
  viewer: "Читатель",
};
const POST_STATUSES = ["Идея", "В работе", "На согласовании", "Готово", "Опубликовано"];
const STATUS_CLASSES = {
  "Идея": "idea",
  "В работе": "in-progress",
  "На согласовании": "review",
  "Готово": "ready",
  "Опубликовано": "published",
};

let user = null;
let projects = [];
let planZoom = 1;
let planOffset = 0;

const esc = (value = "") =>
  String(value).replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[char]);

const initials = () => {
  const source = user?.displayName || user?.email || "А";
  return source
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
};

const normalizeRole = (role) => role === "commenter" ? "viewer" : role;
const roleLabel = (role) => ROLE_LABELS[normalizeRole(role)] || role;
const canEdit = (role) => ["owner", "editor"].includes(role);
const canComment = (role) => ["owner", "editor"].includes(role);
const statusClass = (status) => STATUS_CLASSES[status] || STATUS_CLASSES.Идея;
const todayIso = () => new Date().toISOString().slice(0, 10);

function addDays(iso, amount) {
  const date = new Date(`${iso}T12:00:00`);
  date.setDate(date.getDate() + amount);
  return date.toISOString().slice(0, 10);
}

function monthDates(iso, offset = 0) {
  const source = new Date(`${iso}T12:00:00`);
  const firstDay = new Date(source.getFullYear(), source.getMonth() + offset, 1, 12);
  const daysInMonth = new Date(firstDay.getFullYear(), firstDay.getMonth() + 1, 0).getDate();
  return Array.from({ length: daysInMonth }, (_, index) => {
    const date = new Date(firstDay.getFullYear(), firstDay.getMonth(), index + 1, 12);
    return date.toISOString().slice(0, 10);
  });
}

function formatDate(iso) {
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit" }).format(
    new Date(`${iso}T12:00:00`),
  );
}

function formatActivityDate(timestamp) {
  const date = timestamp?.toDate?.();
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "Только что";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function readError(error) {
  return ({
    "auth/email-already-in-use": "Этот email уже зарегистрирован. Войдите в аккаунт.",
    "auth/invalid-email": "Проверьте формат email.",
    "auth/invalid-credential": "Неверный email или пароль.",
    "auth/network-request-failed": "Не удалось подключиться к серверу. Проверьте интернет и повторите попытку.",
    "auth/too-many-requests": "Слишком много попыток. Подождите немного и повторите действие.",
    "auth/user-disabled": "Этот аккаунт отключён.",
    "auth/weak-password": "Пароль должен содержать минимум 6 символов.",
    "permission-denied": "Нет доступа к этому действию.",
  })[error?.code] || error?.message || "Что-то пошло не так. Попробуйте ещё раз.";
}

function showMessage(message, type = "error", root = document) {
  const spot = root.querySelector("[data-message]");
  if (spot) spot.innerHTML = `<p class="${type}">${esc(message)}</p>`;
}

function loader(label = "Загружаю…") {
  const current = app.querySelector("[data-page-loader]");
  if (current) {
    current.querySelector("[data-loader-label]").textContent = label;
    return;
  }
  app.setAttribute("aria-busy", "true");
  app.insertAdjacentHTML(
    "afterbegin",
    `<div class="page-loader" data-page-loader role="status" aria-live="polite">
      <span class="page-loader-spinner" aria-hidden="true"></span>
      <span data-loader-label>${esc(label)}</span>
      <span class="page-loader-track" aria-hidden="true"><i></i></span>
    </div>`,
  );
}

new MutationObserver(() => {
  if (!app.querySelector("[data-page-loader]")) app.removeAttribute("aria-busy");
}).observe(app, { childList: true, subtree: false });

function beginFormProgress(form, label, totalSteps = 1) {
  if (form.dataset.submitting === "true") return null;
  const button = form.querySelector('button:not([type="button"])');
  if (!button) return null;
  form.dataset.submitting = "true";
  form.setAttribute("aria-busy", "true");
  button.disabled = true;
  const originalLabel = button.textContent;
  button.innerHTML = `<span class="button-spinner" aria-hidden="true"></span>${esc(label)}`;
  const progress = document.createElement("div");
  progress.className = "save-progress";
  progress.dataset.saveProgress = "";
  progress.setAttribute("role", "status");
  progress.setAttribute("aria-live", "polite");
  progress.innerHTML = `<span class="save-progress-track" aria-hidden="true"><i></i></span><small data-progress-label>${esc(label)}</small>`;
  const message = form.querySelector("[data-message]");
  if (message) message.before(progress);
  else form.append(progress);
  const total = Math.max(1, totalSteps);
  let completed = 0;

  return {
    advance(nextLabel = label) {
      completed += 1;
      progress.querySelector("i").style.width = `${Math.min(100, Math.round((completed / total) * 100))}%`;
      progress.querySelector("[data-progress-label]").textContent = nextLabel;
    },
    finish() {
      delete form.dataset.submitting;
      form.removeAttribute("aria-busy");
      button.disabled = false;
      button.textContent = originalLabel;
      progress.remove();
    },
  };
}

function rubricNetworkIds(rubric, networks) {
  const available = new Set(networks.map((network) => network.id));
  if (!Array.isArray(rubric.networkIds)) return networks.map((network) => network.id);
  return rubric.networkIds.filter((networkId) => available.has(networkId));
}

function rubricAppliesToNetwork(rubric, networkId) {
  return !Array.isArray(rubric.networkIds) || rubric.networkIds.includes(networkId);
}

function refreshRubricValidation(rowSelector, revealAll = false) {
  const elements = [...document.querySelectorAll(rowSelector)];
  const nameCounts = new Map();
  elements.forEach((element) => {
    const key = element.querySelector("[data-rubric-name]").value.trim().toLocaleLowerCase("ru-RU");
    if (key) nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  });

  let firstInvalid = null;
  elements.forEach((element) => {
    const nameInput = element.querySelector("[data-rubric-name]");
    const checkboxList = element.querySelector(".checkbox-list");
    const hint = element.querySelector("[data-rubric-hint]");
    const name = nameInput.value.trim();
    const missingName = !name;
    const missingNetwork = !checkboxList.querySelector('input[type="checkbox"]:checked');
    const duplicateName = Boolean(name) && nameCounts.get(name.toLocaleLowerCase("ru-RU")) > 1;
    const errors = [];
    if (missingName && revealAll) errors.push("Введите название рубрики.");
    if (missingNetwork) errors.push("Выберите хотя бы одну соцсеть.");
    if (duplicateName) errors.push("Название рубрики повторяется.");
    const invalid = missingName || missingNetwork || duplicateName;
    const visibleInvalid = errors.length > 0;
    element.classList.toggle("rubric-editor-row-invalid", visibleInvalid);
    nameInput.setAttribute("aria-invalid", String(missingName || duplicateName));
    checkboxList.setAttribute("aria-invalid", String(missingNetwork));
    hint.hidden = !visibleInvalid;
    hint.textContent = errors.join(" ");
    if (invalid && !firstInvalid) firstInvalid = missingName ? nameInput : (checkboxList.querySelector('input[type="checkbox"]') || checkboxList);
  });
  return { valid: !firstInvalid, firstInvalid };
}

function bindRubricValidation(rowSelector) {
  document.querySelectorAll(rowSelector).forEach((element) => {
    element.addEventListener("input", () => refreshRubricValidation(rowSelector));
    element.addEventListener("change", () => refreshRubricValidation(rowSelector));
  });
  refreshRubricValidation(rowSelector);
}

function focusFirstRubricError(validation) {
  validation.firstInvalid?.scrollIntoView({ behavior: "smooth", block: "center" });
  validation.firstInvalid?.focus?.({ preventScroll: true });
}

function accountMarkup({ showHome = true } = {}) {
  return `
    <div class="account-wrap">
      <button class="account-button" data-account aria-label="Открыть меню аккаунта">${esc(initials())}</button>
      <div class="account-menu hidden" data-account-menu>
        <div class="account-name"><strong>${esc(user?.displayName || "Аккаунт")}</strong><br><small>${esc(user?.email || "")}</small></div>
        ${showHome ? "<button data-go-home>Выйти на главный экран</button>" : ""}
        <button data-signout>Выйти из аккаунта</button>
      </div>
    </div>`;
}

function bindAccountMenu() {
  const button = document.querySelector("[data-account]");
  const menu = document.querySelector("[data-account-menu]");
  if (!button || !menu) return;

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    menu.classList.toggle("hidden");
  });
  document.onclick = (event) => {
    if (!event.target.closest(".account-wrap")) menu.classList.add("hidden");
    if (!event.target.closest(".project-row")) {
      document.querySelectorAll("[data-project-menu]").forEach((item) => item.classList.add("hidden"));
    }
  };
  menu.addEventListener("click", (event) => event.stopPropagation());
  const homeButton = menu.querySelector("[data-go-home]");
  if (homeButton) homeButton.onclick = () => {
    const url = new URL(window.location.href);
    url.search = "";
    window.location.href = url.toString();
  };
  menu.querySelector("[data-signout]").onclick = () => signOut(auth);
}

function pageTopbar(backLabel = "", onBack = null) {
  return `
    <div class="page-topbar">
      ${backLabel ? `<button class="back-button" data-back>← ${esc(backLabel)}</button>` : "<span></span>"}
      ${accountMarkup()}
    </div>`;
}

function bindTopbar(onBack = null) {
  if (onBack) document.querySelector("[data-back]")?.addEventListener("click", onBack);
  bindAccountMenu();
}

function openModal(title, content, size = "") {
  app.insertAdjacentHTML(
    "beforeend",
    `<div class="modal-backdrop" data-modal tabindex="-1">
      <section class="modal card ${size}">
        <button class="close" data-close aria-label="Закрыть">×</button>
        <h2>${esc(title)}</h2>
        ${content}
      </section>
    </div>`,
  );
  const modals = document.querySelectorAll("[data-modal]");
  const modal = modals[modals.length - 1];
  modal.querySelector("[data-close]").onclick = () => modal.remove();
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.remove();
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") modal.remove();
  });
  modal.focus();
  return modal;
}

/* ---------------- Авторизация ---------------- */

function dashboardOliveMarkup() {
  return `
    <div class="dashboard-olive-scene" aria-hidden="true">
      <span class="olive-confetti olive-confetti-one"></span>
      <span class="olive-confetti olive-confetti-two"></span>
      <span class="olive-confetti olive-confetti-three"></span>
      <span class="olive-confetti olive-confetti-four"></span>
      <svg class="dashboard-olive" viewBox="0 0 220 230">
        <ellipse class="dashboard-olive-shadow" cx="110" cy="211" rx="48" ry="9" />
        <g class="dashboard-olive-character">
          <g class="dashboard-olive-leg dashboard-olive-leg-left">
            <path d="M90 174c-2 17-9 27-23 34" />
            <path d="M68 208H51" />
          </g>
          <g class="dashboard-olive-leg dashboard-olive-leg-right">
            <path d="M130 174c2 17 9 27 23 34" />
            <path d="M152 208h17" />
          </g>
          <g class="dashboard-olive-arm dashboard-olive-arm-left">
            <path d="M65 91C43 87 33 74 29 56" />
            <path d="m29 56-12 9m12-9 10 8" />
          </g>
          <g class="dashboard-olive-arm dashboard-olive-arm-right">
            <path d="M155 91c22-4 32-17 36-35" />
            <path d="m191 56-12 9m12-9 10 8" />
          </g>
          <path class="dashboard-olive-body" d="M110 27c39 0 61 38 61 81 0 49-23 78-61 78s-61-29-61-78c0-43 22-81 61-81Z" />
          <path class="dashboard-olive-shine" d="M75 65c9-18 21-28 36-33-15 22-22 43-23 65-14-6-20-18-13-32Z" />
          <ellipse class="dashboard-olive-opening" cx="110" cy="31" rx="22" ry="9" />
          <ellipse class="dashboard-olive-pimento" cx="110" cy="31" rx="13" ry="5.5" />
          <circle class="dashboard-olive-cheek" cx="79" cy="120" r="8" />
          <circle class="dashboard-olive-cheek" cx="141" cy="120" r="8" />
          <ellipse class="dashboard-olive-eye" cx="88" cy="101" rx="6" ry="8" />
          <ellipse class="dashboard-olive-eye" cx="132" cy="101" rx="6" ry="8" />
          <circle class="dashboard-olive-eye-glint" cx="90" cy="98" r="2" />
          <circle class="dashboard-olive-eye-glint" cx="134" cy="98" r="2" />
          <path class="dashboard-olive-mouth" d="M86 128q24 27 48 0" />
        </g>
      </svg>
    </div>`;
}

function renderAuth(mode = "welcome") {
  if (mode === "welcome") {
    renderLanding();
    return;
  }

  const isRegister = mode === "register";
  const form = `
    <p class="subtitle">${isRegister ? "Создайте аккаунт, чтобы хранить проекты и приглашать участников." : "Введите email и пароль, указанные при регистрации."}</p>
    <form class="form" id="auth-form">
      ${isRegister ? '<label>Имя<input name="name" required maxlength="60" autocomplete="name"></label>' : ""}
      <label>Email<input name="email" type="email" required autocomplete="email"></label>
      <label>Пароль<input name="password" type="password" required minlength="6" autocomplete="${isRegister ? "new-password" : "current-password"}"></label>
      <button class="button primary">${isRegister ? "Создать аккаунт" : "Войти"}</button>
      <button type="button" class="link-button" data-auth-back>Назад</button>
    </form>
    <div data-message></div>`;

  app.innerHTML = `
    <section class="screen auth-screen auth-form-screen">
      <button class="landing-brand auth-brand" type="button" data-auth-back aria-label="Вернуться на главную">
        <span class="landing-brand-mark" aria-hidden="true">К</span>
        <span>Контент-план</span>
      </button>
      <div class="card auth-card">
        <p class="landing-kicker">${isRegister ? "Новый аккаунт" : "С возвращением"}</p>
        <h1>${isRegister ? "Начните с одного проекта" : "Войдите в контент-план"}</h1>
        ${form}
      </div>
    </section>`;
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.onclick = () => renderAuth(button.dataset.authMode);
  });
  document.querySelectorAll("[data-auth-back]").forEach((button) => {
    button.addEventListener("click", () => renderAuth());
  });

  const authForm = document.querySelector("#auth-form");
  if (!authForm) return;
  authForm.onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(authForm);
    const progress = beginFormProgress(authForm, isRegister ? "Создаю аккаунт…" : "Вхожу…", isRegister ? 2 : 1);
    if (!progress) return;
    try {
      if (isRegister) {
        const credential = await createUserWithEmailAndPassword(auth, data.get("email"), data.get("password"));
        progress.advance("Аккаунт создан");
        const name = data.get("name").trim();
        await updateProfile(credential.user, { displayName: name });
        await setDoc(doc(db, "profiles", credential.user.uid), {
          name,
          email: data.get("email"),
          createdAt: serverTimestamp(),
        });
        progress.advance("Профиль сохранён");
      } else {
        await signInWithEmailAndPassword(auth, data.get("email"), data.get("password"));
        progress.advance("Вход выполнен");
      }
    } catch (error) {
      showMessage(readError(error));
    } finally {
      progress.finish();
    }
  };
}

function landingOllieMarkup(variant) {
  const runnerProps = variant === "runner" ? `
    <g class="landing-ollie-notebook">
      <rect x="73" y="110" width="76" height="64" rx="9" />
      <path d="M88 128h46M88 142h39M88 156h32" />
      <path class="landing-ollie-pen" d="m143 103 17-29 6 4-17 29Z" />
    </g>` : "";
  return `
    <div class="landing-ollie landing-ollie-${variant}" aria-hidden="true">
      <svg viewBox="0 0 220 250">
        <defs>
          <linearGradient id="landing-ollie-body-${variant}" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#a5b27d" />
            <stop offset=".55" stop-color="#7f8f5b" />
            <stop offset="1" stop-color="#657247" />
          </linearGradient>
        </defs>
        <ellipse class="landing-ollie-shadow" cx="110" cy="226" rx="48" ry="9" />
        <g class="landing-ollie-character">
          <g class="landing-ollie-leg landing-ollie-leg-left"><path d="M88 184c-4 17-12 27-25 37" /><path d="M63 221 45 219" /></g>
          <g class="landing-ollie-leg landing-ollie-leg-right"><path d="M132 184c4 17 12 27 25 37" /><path d="m157 221 18-2" /></g>
          <g class="landing-ollie-arm landing-ollie-arm-left"><path d="M63 105C43 98 34 85 31 69" /><path d="m31 69-8 9m8-9 8 6" /></g>
          <g class="landing-ollie-arm landing-ollie-arm-right"><path d="M157 105c20-7 29-20 32-36" /><path d="m189 69-8 9m8-9 8 6" /></g>
          <path class="landing-ollie-body" fill="url(#landing-ollie-body-${variant})" d="M110 24c38 0 61 38 61 83 0 49-23 80-61 80s-61-31-61-80c0-45 23-83 61-83Z" />
          <path class="landing-ollie-shine" d="M75 57c10-17 23-26 38-29-15 20-23 42-25 64-14-5-20-20-13-35Z" />
          <ellipse class="landing-ollie-opening" cx="110" cy="29" rx="22" ry="9" />
          <ellipse class="landing-ollie-pimento" cx="110" cy="29" rx="13" ry="5.5" />
          <circle class="landing-ollie-cheek" cx="78" cy="121" r="8" />
          <circle class="landing-ollie-cheek" cx="142" cy="121" r="8" />
          <ellipse class="landing-ollie-eye" cx="87" cy="100" rx="6" ry="8" />
          <ellipse class="landing-ollie-eye" cx="133" cy="100" rx="6" ry="8" />
          <circle class="landing-ollie-eye-glint" cx="89" cy="97" r="2" />
          <circle class="landing-ollie-eye-glint" cx="135" cy="97" r="2" />
          <path class="landing-ollie-mouth" d="M86 130q24 25 48 0" />
          ${runnerProps}
        </g>
      </svg>
    </div>`;
}

function renderLanding() {
  app.innerHTML = `
    <div class="landing-page">
      <header class="landing-header" data-landing-header>
        <a class="landing-brand" href="#top" aria-label="Контент-план — на главную">
          <span class="landing-brand-mark" aria-hidden="true">К</span>
          <span>Контент-план</span>
        </a>
        <nav class="landing-nav" aria-label="Основная навигация">
          <a href="#features">Возможности</a>
          <a href="#workflow">Как работает</a>
          <a href="#team">Для команды</a>
        </nav>
        <div class="landing-header-actions">
          <button class="landing-text-button" type="button" data-auth-mode="login">Войти</button>
          <button class="button primary landing-small-cta" type="button" data-auth-mode="register">Начать бесплатно</button>
        </div>
      </header>

      <main id="top">
        <section class="landing-hero" aria-labelledby="landing-title">
          <div class="landing-hero-copy" data-reveal>
            <p class="landing-kicker">Планирование контента для команды</p>
            <h1 id="landing-title">Публикации — по плану. Материалы — под рукой.</h1>
            <p class="landing-lead">Соберите проекты, площадки, рубрики и публикации в одном месте. Команда сразу видит, что готовить, кто отвечает и когда выпускать.</p>
            <div class="landing-hero-actions">
              <button class="button primary landing-main-cta" type="button" data-auth-mode="register">Создать первый проект</button>
              <a class="landing-secondary-link" href="#workflow">Посмотреть, как работает <span aria-hidden="true">↓</span></a>
            </div>
            <p class="landing-note">Бесплатный старт</p>
          </div>
          <div class="landing-hero-visual" data-reveal>
            <div class="landing-speech">Привет! Я Олли.<br>Покажу, как навести порядок.</div>
            ${landingOllieMarkup("hero")}
            <div class="landing-preview-window landing-preview-window-hero">
              <div class="landing-window-bar"><span></span><span></span><span></span><small>Мои проекты</small></div>
              <img src="assets/screen-projects.png?v=4" alt="Главный экран Контент-плана со списком проектов и Олли" width="1258" height="631">
            </div>
          </div>
        </section>

        <section class="landing-proof" aria-label="Главные преимущества">
          <p>Один план вместо таблиц, заметок и сообщений</p>
          <ul>
            <li><strong>5 минут</strong><span>на создание проекта</span></li>
            <li><strong>3 роли</strong><span>для работы в команде</span></li>
            <li><strong>4 изображения</strong><span>в каждой публикации</span></li>
          </ul>
        </section>

        <section class="landing-section" id="features">
          <div class="landing-section-heading" data-reveal>
            <p class="landing-kicker">Всё нужное, ничего лишнего</p>
            <h2>Сначала настройте проект. Дальше работайте по плану.</h2>
          </div>
          <div class="landing-feature-grid">
            <article class="landing-feature-card landing-feature-card-wide" data-reveal>
              <div class="landing-feature-copy">
                <span class="landing-feature-number">01</span>
                <h3>Разделите работу по проектам</h3>
                <p>Создайте отдельный план для бренда, клиента или направления. Пригласите коллег по восьмизначному коду.</p>
              </div>
              <div class="landing-preview-window">
                <div class="landing-window-bar"><span></span><span></span><span></span><small>Проекты</small></div>
                <div class="landing-feature-screen">
                  <img src="assets/screen-projects.png?v=4" alt="Реальный главный экран Контент-плана" loading="lazy" width="1258" height="631">
                  ${landingOllieMarkup("peek")}
                </div>
              </div>
            </article>
            <article class="landing-feature-card" data-reveal>
              <span class="landing-feature-number">02</span>
              <h3>Добавьте свои площадки</h3>
              <p>Telegram, VK, Дзен или корпоративный блог — укажите только те каналы, с которыми работаете.</p>
              <div class="landing-channel-pills" aria-label="Примеры площадок">
                <span>Telegram</span><span>VK</span><span>Дзен</span>
              </div>
            </article>
            <article class="landing-feature-card" data-reveal>
              <span class="landing-feature-number">03</span>
              <h3>Закрепите рубрики</h3>
              <p>Свяжите каждую рубрику с одной или несколькими площадками. В плане останутся только подходящие темы.</p>
              <div class="landing-rubric-sample">
                <span>Кейсы</span><i>Telegram</i><i>VK</i>
                <span>Новости</span><i>Дзен</i>
              </div>
            </article>
          </div>
        </section>

        <section class="landing-workflow" id="workflow">
          <div class="landing-section-heading" data-reveal>
            <p class="landing-kicker">Рабочий процесс</p>
            <h2>От идеи до публикации — в одном окне</h2>
            <p>Выберите дату и рубрику, добавьте текст, материалы и статус. Контент сразу появится в общем календаре.</p>
          </div>
          <div class="landing-product-stage" data-reveal>
            <div class="landing-stage-tabs" role="tablist" aria-label="Экраны продукта">
              <button type="button" role="tab" aria-selected="true" data-screen="assets/screen-settings.png" data-screen-alt="Настройки площадок и рубрик" data-screen-caption="Настройте площадки и рубрики один раз — они появятся во всех планах проекта.">1. Настройка</button>
              <button type="button" role="tab" aria-selected="false" data-screen="assets/screen-editor.png?v=3" data-screen-alt="Редактор публикации с задачей, готовым материалом и визуалом" data-screen-caption="Соберите задачу, готовый текст, визуал и статус публикации в одной карточке.">2. Публикация</button>
              <button type="button" role="tab" aria-selected="false" data-screen="assets/screen-plan.png" data-screen-alt="Календарный контент-план проекта" data-screen-caption="Смотрите месяц целиком и открывайте любую публикацию прямо из календаря.">3. План</button>
            </div>
            <div class="landing-preview-window landing-stage-window">
              <div class="landing-window-bar"><span></span><span></span><span></span><small data-screen-title>Настройка проекта</small></div>
              <img data-product-screen src="assets/screen-settings.png" alt="Настройки площадок и рубрик" loading="lazy" width="1440" height="900">
            </div>
            <p class="landing-stage-caption" data-screen-caption-target>Настройте площадки и рубрики один раз — они появятся во всех планах проекта.</p>
          </div>
        </section>

        <section class="landing-team landing-section" id="team">
          <div class="landing-team-copy" data-reveal>
            <p class="landing-kicker">Три роли в одном проекте</p>
            <h2>Каждому — свой уровень доступа</h2>
            <p>Владелец настраивает проект и приглашает участников. Редактор меняет публикации. Читатель просматривает план и комментарии.</p>
            <ul class="landing-check-list">
              <li>Вход по восьмизначному коду</li>
              <li>Доступы для каждой роли</li>
              <li>Обсуждение в карточке публикации</li>
            </ul>
          </div>
          <div class="landing-team-scene" data-reveal aria-label="Три роли в команде">
            <div class="landing-role-card"><span>В</span><div><strong>Владелец</strong><small>Настройки и доступы</small></div></div>
            <div class="landing-role-card"><span>Р</span><div><strong>Редактор</strong><small>План и публикации</small></div></div>
            <div class="landing-role-card"><span>Ч</span><div><strong>Читатель</strong><small>Просмотр проекта</small></div></div>
            ${landingOllieMarkup("runner")}
          </div>
        </section>

        <section class="landing-faq landing-section">
          <div class="landing-section-heading" data-reveal>
            <p class="landing-kicker">Коротко о главном</p>
            <h2>Перед стартом</h2>
          </div>
          <div class="landing-faq-list" data-reveal>
            <details><summary>Нужно переносить план из таблицы?</summary><p>Нет. Создайте проект, добавьте площадки и начните с ближайших публикаций. Старый план можно оставить как архив.</p></details>
            <details><summary>Можно работать с телефона?</summary><p>Да. Интерфейс адаптирован для мобильного экрана: можно открыть план, публикацию и материалы.</p></details>
            <details><summary>Где хранятся изображения?</summary><p>Сервис сжимает изображения в браузере и сохраняет их вместе с публикацией. Поддерживается до четырёх файлов в каждом поле.</p></details>
          </div>
        </section>

        <section class="landing-final-cta" data-reveal>
          <div>
            <p class="landing-kicker">Начните с ближайшего месяца</p>
            <h2>Создайте проект. Первый план займёт несколько минут.</h2>
          </div>
          <button class="button primary landing-main-cta" type="button" data-auth-mode="register">Начать бесплатно</button>
        </section>
      </main>

      <footer class="landing-footer">
        <a class="landing-brand" href="#top"><span class="landing-brand-mark" aria-hidden="true">К</span><span>Контент-план</span></a>
        <p>Планируйте. Согласовывайте. Публикуйте.</p>
        <button class="landing-text-button" type="button" data-auth-mode="login">Войти</button>
      </footer>
    </div>`;

  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.onclick = () => renderAuth(button.dataset.authMode);
  });

  document.querySelectorAll('.landing-page a[href^="#"]').forEach((link) => {
    link.addEventListener("click", (event) => {
      const target = document.querySelector(link.getAttribute("href"));
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  const screen = document.querySelector("[data-product-screen]");
  const caption = document.querySelector("[data-screen-caption-target]");
  const title = document.querySelector("[data-screen-title]");
  document.querySelectorAll("[data-screen]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-screen]").forEach((item) => item.setAttribute("aria-selected", String(item === button)));
      screen.classList.add("is-changing");
      window.setTimeout(() => {
        screen.src = button.dataset.screen;
        screen.alt = button.dataset.screenAlt;
        caption.textContent = button.dataset.screenCaption;
        title.textContent = button.textContent.replace(/^\d\.\s*/, "");
        screen.classList.remove("is-changing");
      }, 160);
    });
  });

  const revealItems = document.querySelectorAll("[data-reveal]");
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.12 });
    revealItems.forEach((item) => observer.observe(item));
  } else {
    revealItems.forEach((item) => item.classList.add("is-visible"));
  }

  const header = document.querySelector("[data-landing-header]");
  const updateHeader = () => header.classList.toggle("is-scrolled", window.scrollY > 18);
  updateHeader();
  window.onscroll = updateHeader;
}

/* ---------------- Данные и главный экран ---------------- */

async function loadProjects() {
  const membershipSnapshot = await getDocs(query(collection(db, "memberships"), where("userId", "==", user.uid)));
  const loaded = [];
  for (const membershipDoc of membershipSnapshot.docs) {
    const membership = membershipDoc.data();
    const projectDoc = await getDoc(doc(db, "projects", membership.projectId));
    if (projectDoc.exists()) loaded.push({ id: projectDoc.id, ...projectDoc.data(), role: normalizeRole(membership.role) });
  }
  projects = loaded.sort((a, b) => (a.name || "").localeCompare(b.name || "", "ru"));
  return projects;
}

function projectById(id) {
  return projects.find((project) => project.id === id);
}

async function renderDashboard() {
  if (!projects.length) await loadProjects();
  app.innerHTML = `
    <section class="screen">
      <div class="dashboard">
        <aside class="sidebar card">
          <button class="button primary sidebar-create" data-create-project>+ Создать проект</button>
          <p class="sidebar-title">Мои проекты</p>
          <nav class="project-list">
            ${projects.length ? projects.map((project) => `
              <div class="project-row">
                <button class="project-open" data-open-project="${project.id}">${esc(project.name)}</button>
                ${project.role === "owner" ? `<button class="project-more" data-project-more="${project.id}" aria-label="Настройки проекта">•••</button>
                  <div class="project-context hidden" data-project-menu="${project.id}">
                    <button data-project-settings="${project.id}">Настройки</button>
                    <button data-project-access="${project.id}">Доступ</button>
                  </div>` : ""}
              </div>`).join("") : '<p class="muted">Проектов пока нет</p>'}
          </nav>
          <div class="sidebar-footer"><button class="link-button" data-join-project>Ввести код проекта</button></div>
        </aside>
        <main class="dashboard-main">
          <div class="page-topbar"><span></span>${accountMarkup({ showHome: false })}</div>
          <div class="welcome-hero">
            <div class="welcome-copy">
              <h1>Здравствуйте, ${esc(user.displayName || "друг")}!</h1>
              <p class="subtitle">С чего начнём?</p>
            </div>
            ${dashboardOliveMarkup()}
          </div>
        </main>
      </div>
    </section>`;

  bindAccountMenu();
  document.querySelector("[data-create-project]").onclick = renderCreateProject;
  document.querySelector("[data-join-project]").onclick = openJoinModal;
  document.querySelectorAll("[data-open-project]").forEach((button) => {
    button.onclick = () => renderProjectWorkspace(projectById(button.dataset.openProject));
  });
  document.querySelectorAll("[data-project-more]").forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      const menu = document.querySelector(`[data-project-menu="${button.dataset.projectMore}"]`);
      document.querySelectorAll("[data-project-menu]").forEach((item) => {
        if (item !== menu) item.classList.add("hidden");
      });
      menu.classList.toggle("hidden");
    };
  });
  document.querySelectorAll("[data-project-settings]").forEach((button) => {
    button.onclick = () => renderProjectSettings(projectById(button.dataset.projectSettings));
  });
  document.querySelectorAll("[data-project-access]").forEach((button) => {
    button.onclick = () => renderAccess(projectById(button.dataset.projectAccess));
  });
}

function openJoinModal() {
  const modal = openModal(
    "Присоединиться к проекту",
    `<p class="subtitle">Введите восьмизначный код, который прислал владелец проекта.</p>
     <form class="form" id="join-form">
       <label>Код проекта<input name="code" inputmode="numeric" pattern="[0-9]{8}" maxlength="8" placeholder="12345678" required></label>
       <button class="button primary">Присоединиться</button>
       <div data-message></div>
     </form>`,
    "medium",
  );
  modal.querySelector("#join-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const code = String(new FormData(form).get("code")).replace(/\D/g, "");
    try {
      if (code.length !== 8) throw new Error("Введите восемь цифр кода.");
      const invitationDoc = await getDoc(doc(db, "invitations", code));
      if (!invitationDoc.exists() || !invitationDoc.data().active) throw new Error("Код не найден или больше не действует.");
      const invitation = invitationDoc.data();
      await setDoc(doc(db, "memberships", `${invitation.projectId}_${user.uid}`), {
        projectId: invitation.projectId,
        userId: user.uid,
        role: "viewer",
        inviteCode: code,
        userName: user.displayName || "Участник",
        userEmail: user.email || "",
        joinedAt: serverTimestamp(),
      });
      modal.remove();
      await loadProjects();
      renderProjectWorkspace(projectById(invitation.projectId));
    } catch (error) {
      showMessage(readError(error), "error", modal);
    }
  };
}

/* ---------------- Создание проекта ---------------- */

function renderCreateProject() {
  const draft = {
    name: "",
    description: "",
    networks: [],
    rubrics: [{ name: "", networkKeys: [] }],
  };
  let nextNetworkKey = 1;

  const syncRubrics = () => {
    document.querySelectorAll("[data-create-rubric-row]").forEach((element) => {
      const index = Number(element.dataset.createRubricRow);
      if (!draft.rubrics[index]) return;
      draft.rubrics[index].name = element.querySelector("[data-rubric-name]").value;
      draft.rubrics[index].networkKeys = [...element.querySelectorAll('input[type="checkbox"]:checked')]
        .map((input) => input.value);
    });
  };

  const renderDetailsStep = () => {
    app.innerHTML = `
      <section class="screen flow-screen">
        ${pageTopbar("На главный экран")}
        <div class="flow-card card narrow">
          <div class="step-indicator">Шаг 1 из 2</div>
          <h1>Новый проект</h1>
          <p class="subtitle">Сначала добавьте основную информацию о проекте.</p>
          <form class="form" id="project-details-form">
            <label>Название <input name="name" required maxlength="80" value="${esc(draft.name)}" placeholder="Название бренда, клиента или направления"></label>
            <label>О проекте <textarea name="description" maxlength="600" placeholder="Кратко опишите продукт, аудиторию и задачи контента">${esc(draft.description)}</textarea></label>
            <div class="flow-actions"><span></span><button class="button primary">Далее</button></div>
          </form>
        </div>
      </section>`;
    bindTopbar(renderDashboard);
    document.querySelector("#project-details-form").onsubmit = (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      draft.name = data.get("name").trim();
      draft.description = data.get("description").trim();
      if (!draft.name) {
        event.currentTarget.elements.name.setCustomValidity("Введите название проекта.");
        event.currentTarget.reportValidity();
        event.currentTarget.elements.name.setCustomValidity("");
        return;
      }
      renderSetupStep();
    };
  };

  const drawSetup = () => {
    const networkList = document.querySelector("[data-create-network-list]");
    networkList.innerHTML = draft.networks.length
      ? draft.networks.map((network) => `
          <span class="tag">${esc(network.name)}
            <button type="button" class="icon-button" data-remove-create-network="${network.key}" aria-label="Удалить соцсеть ${esc(network.name)}">×</button>
          </span>`).join("")
      : '<span class="muted">Добавьте хотя бы одну соцсеть.</span>';

    const rubricList = document.querySelector("[data-create-rubric-list]");
    rubricList.innerHTML = draft.rubrics.map((rubric, index) => `
      <div class="rubric-editor-row" data-create-rubric-row="${index}">
        <input data-rubric-name value="${esc(rubric.name)}" maxlength="70" placeholder="Название рубрики">
        <div class="checkbox-list">
          ${draft.networks.length ? draft.networks.map((network) => `
            <label class="check-pill"><input type="checkbox" value="${network.key}" ${rubric.networkKeys.includes(network.key) ? "checked" : ""}>${esc(network.name)}</label>`).join("") : '<span class="muted">Сначала добавьте соцсеть.</span>'}
        </div>
        <button type="button" class="icon-button" data-remove-create-rubric="${index}" aria-label="Удалить рубрику">×</button>
        <p class="rubric-row-hint" data-rubric-hint hidden></p>
      </div>`).join("");

    networkList.querySelectorAll("[data-remove-create-network]").forEach((button) => {
      button.onclick = () => {
        syncRubrics();
        const key = button.dataset.removeCreateNetwork;
        draft.networks = draft.networks.filter((network) => network.key !== key);
        draft.rubrics.forEach((rubric) => {
          rubric.networkKeys = rubric.networkKeys.filter((networkKey) => networkKey !== key);
        });
        drawSetup();
      };
    });
    rubricList.querySelectorAll("[data-remove-create-rubric]").forEach((button) => {
      button.onclick = () => {
        syncRubrics();
        draft.rubrics.splice(Number(button.dataset.removeCreateRubric), 1);
        if (!draft.rubrics.length) draft.rubrics.push({ name: "", networkKeys: [] });
        drawSetup();
      };
    });
    bindRubricValidation("[data-create-rubric-row]");
  };

  const renderSetupStep = () => {
    app.innerHTML = `
      <section class="screen flow-screen">
        ${pageTopbar("Назад")}
        <div class="flow-card card project-setup-card">
          <div class="step-indicator">Шаг 2 из 2</div>
          <h1>Настройка проекта</h1>
          <section class="settings-section">
            <h2>Соцсети</h2>
            <p class="subtitle">Добавьте площадки, для которых будете составлять контент-план.</p>
            <div class="tag-list" data-create-network-list></div>
            <form class="custom-network" id="create-network-form">
              <input name="name" required maxlength="40" placeholder="Например, Telegram">
              <button class="button ghost">Добавить соцсеть</button>
            </form>
          </section>
          <section class="settings-section">
            <h2>Рубрики</h2>
            <p class="subtitle">Создайте рубрики и отметьте соцсети, в которых используется каждая из них.</p>
            <form class="form" id="create-project-form">
              <div class="rubric-editor-list" data-create-rubric-list></div>
              <button type="button" class="button ghost" data-add-create-rubric>+ Добавить рубрику</button>
              <div data-message></div>
              <div class="flow-actions"><span></span><button class="button primary" data-finish-create>Создать проект</button></div>
            </form>
          </section>
        </div>
      </section>`;
    bindTopbar(() => {
      syncRubrics();
      renderDetailsStep();
    });
    drawSetup();

    document.querySelector("#create-network-form").onsubmit = (event) => {
      event.preventDefault();
      syncRubrics();
      const input = event.currentTarget.elements.name;
      const name = input.value.trim();
      if (!name) {
        input.setCustomValidity("Введите название соцсети.");
        event.currentTarget.reportValidity();
        input.setCustomValidity("");
        return;
      }
      if (draft.networks.some((network) => network.name.toLocaleLowerCase("ru") === name.toLocaleLowerCase("ru"))) {
        showMessage("Такая соцсеть уже добавлена.");
        return;
      }
      draft.networks.push({ key: `network-${nextNetworkKey}`, name });
      nextNetworkKey += 1;
      input.value = "";
      drawSetup();
    };
    document.querySelector("[data-add-create-rubric]").onclick = () => {
      syncRubrics();
      draft.rubrics.push({ name: "", networkKeys: [] });
      drawSetup();
    };
    document.querySelector("#create-project-form").onsubmit = async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      syncRubrics();
      const validRubrics = draft.rubrics.map((rubric) => ({ name: rubric.name.trim(), networkKeys: rubric.networkKeys }));
      const validation = refreshRubricValidation("[data-create-rubric-row]", true);
      if (!draft.networks.length) {
        showMessage("Сначала добавьте хотя бы одну соцсеть.", "error", form);
        return;
      }
      if (!validation.valid) {
        showMessage("Исправьте отмеченные рубрики и повторите сохранение.", "error", form);
        focusFirstRubricError(validation);
        return;
      }
      const progress = beginFormProgress(form, "Создаю проект…", 5 + draft.networks.length + validRubrics.length);
      if (!progress) return;
      try {
        const shareCode = await uniqueCode();
        progress.advance("Подготавливаю проект");
        const projectDoc = await addDoc(collection(db, "projects"), {
          ownerId: user.uid,
          name: draft.name,
          description: draft.description,
          shareCode,
          planStartDate: todayIso(),
          createdAt: serverTimestamp(),
        });
        progress.advance("Проект создан");
        await setDoc(doc(db, "memberships", `${projectDoc.id}_${user.uid}`), {
          projectId: projectDoc.id,
          userId: user.uid,
          role: "owner",
          userName: user.displayName || "Владелец",
          userEmail: user.email || "",
          joinedAt: serverTimestamp(),
        });
        progress.advance("Доступ владельца настроен");
        await setDoc(doc(db, "invitations", shareCode), {
          projectId: projectDoc.id,
          role: "viewer",
          active: true,
          createdAt: serverTimestamp(),
        });
        progress.advance("Код приглашения создан");
        const networkIds = new Map();
        for (const network of draft.networks) {
          const networkDoc = await addDoc(collection(db, "projects", projectDoc.id, "networks"), {
            name: network.name,
            createdAt: serverTimestamp(),
          });
          networkIds.set(network.key, networkDoc.id);
          progress.advance(`Добавлена соцсеть «${network.name}»`);
        }
        for (const rubric of validRubrics) {
          await addDoc(collection(db, "projects", projectDoc.id, "rubrics"), {
            name: rubric.name,
            networkIds: rubric.networkKeys.map((key) => networkIds.get(key)),
            createdAt: serverTimestamp(),
          });
          progress.advance(`Добавлена рубрика «${rubric.name}»`);
        }
        await loadProjects();
        progress.advance("Проект готов");
        renderProjectWorkspace(projectById(projectDoc.id));
      } catch (error) {
        showMessage(readError(error), "error", form);
      } finally {
        progress.finish();
      }
    };
  };

  renderDetailsStep();
}

async function uniqueCode() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = String(Math.floor(10000000 + Math.random() * 90000000));
    if (!(await getDoc(doc(db, "invitations", code))).exists()) return code;
  }
  throw new Error("Не удалось создать код проекта. Попробуйте ещё раз.");
}

/* ---------------- Соцсети и рубрики ---------------- */

function renderProjectWorkspace(project) {
  const workAreas = [
    {
      key: "networks",
      number: "01",
      title: "Соцсети",
      description: "Контент-планы, рубрики и публикации",
      available: true,
    },
    {
      key: "audience",
      number: "02",
      title: "Целевая аудитория",
      description: "Сегменты, потребности и портреты",
      available: true,
    },
    {
      key: "competitors",
      number: "03",
      title: "Конкуренты",
      description: "Сравнение позиционирования и контента",
      available: true,
    },
    {
      key: "audit",
      number: "04",
      title: "Аудит",
      description: "Проверка текущих площадок и материалов",
      available: true,
    },
    {
      key: "references",
      number: "05",
      title: "Референсы",
      description: "Примеры, идеи и визуальные ориентиры",
      available: true,
    },
    {
      key: "notebook",
      number: "06",
      title: "Блокнот",
      description: "Идеи, заметки и рабочие черновики",
      available: true,
    },
  ];

  app.innerHTML = `
    <section class="screen flow-screen workspace-screen">
      ${pageTopbar("Все проекты")}
      <div class="workspace-project-label">Проект</div>
      <h1 class="workspace-project-title">${esc(project.name)}</h1>
      <div class="project-workspace card">
        <div class="workspace-heading">
          <p class="step-indicator">Рабочее пространство</p>
          <h2>Над чем поработаем?</h2>
          <p>Выберите направление. Здесь можно вести контент-планы и исследования проекта.</p>
        </div>
        <div class="workspace-layout">
          <div class="workspace-actions">
            ${workAreas.map((area) => `
              <button
                type="button"
                class="workspace-action${area.available ? " workspace-action-active" : ""}"
                ${area.available ? `data-open-work-area="${area.key}"` : "disabled"}
              >
                <span class="workspace-action-number">${area.number}</span>
                <span class="workspace-action-copy">
                  <strong>${area.title}</strong>
                  <small>${area.description}</small>
                </span>
                <span class="workspace-action-state">${area.available ? "Открыть →" : "Скоро"}</span>
              </button>`).join("")}
          </div>
          <aside class="workspace-ollie">
            ${dashboardOliveMarkup()}
            <div class="workspace-ollie-note">
              <strong>Олли уже здесь</strong>
              <span>Поможет собрать всё по проекту в одном месте.</span>
            </div>
          </aside>
        </div>
      </div>
    </section>`;

  bindTopbar(renderDashboard);
  document.querySelector('[data-open-work-area="networks"]').onclick = () => renderNetworkSelection(project);
  document.querySelector('[data-open-work-area="audience"]').onclick = () => renderAudienceAnalysis(project);
  document.querySelector('[data-open-work-area="competitors"]').onclick = () => renderCompetitorAnalysis(project);
  document.querySelector('[data-open-work-area="audit"]').onclick = () => renderProjectDocument(project, "audit");
  document.querySelector('[data-open-work-area="references"]').onclick = () => renderReferencesBoard(project);
  document.querySelector('[data-open-work-area="notebook"]').onclick = () => renderProjectDocument(project, "notebook");
}

/* ---------------- Референсы ---------------- */

const REFERENCE_MEDIA_LIMIT = 4;
const REFERENCE_MEDIA_MAX_BYTES = 50 * 1024 * 1024;
const REFERENCE_COLUMN_COLORS = ["pink", "orange", "green", "violet", "blue", "peach"];

function normalizeReferenceMedia(media, projectId, referenceId) {
  if (!Array.isArray(media)) return [];
  const pathPrefix = `projects/${projectId}/references/${referenceId}/`;
  return media.slice(0, REFERENCE_MEDIA_LIMIT).filter((item) => (
    item && typeof item === "object"
    && typeof item.path === "string" && item.path.startsWith(pathPrefix)
    && typeof item.url === "string" && /^https:\/\//i.test(item.url)
    && typeof item.name === "string"
    && typeof item.type === "string" && /^(image|video)\//i.test(item.type)
  )).map((item) => ({
    path: item.path,
    url: item.url,
    name: item.name.slice(0, 180),
    type: item.type,
    size: Number.isFinite(item.size) ? item.size : 0,
  }));
}

function referenceMediaMarkup(media, compact = false, removable = true) {
  if (!media.length) return compact ? '<span class="reference-card-empty">Без медиа</span>' : '<p class="muted">Медиафайлы пока не добавлены.</p>';
  return media.map((item, index) => {
    const label = esc(item.name || `Медиафайл ${index + 1}`);
    const preview = item.type.startsWith("video/")
      ? `<video src="${esc(item.url)}" muted preload="metadata" aria-label="${label}"></video><span class="reference-video-badge">Видео</span>`
      : `<img src="${esc(item.url)}" alt="${label}">`;
    return compact
      ? `<span class="reference-card-media">${preview}</span>`
      : `<span class="reference-editor-media-item">
          <button type="button" class="reference-media-preview" data-view-reference-media="${index}" aria-label="Открыть ${label}">${preview}</button>
          ${removable ? `<button type="button" class="image-remove" data-remove-reference-media="${index}" aria-label="Убрать ${label}">×</button>` : ""}
        </span>`;
  }).join("");
}

function openReferenceMediaViewer(item) {
  const content = item.type.startsWith("video/")
    ? `<div class="image-viewer"><video src="${esc(item.url)}" controls autoplay playsinline></video></div>`
    : `<div class="image-viewer"><img src="${esc(item.url)}" alt="${esc(item.name || "Референс")}"></div>`;
  openModal(item.name || "Медиафайл", content, "image-viewer-modal");
}

async function getReferenceEntries(projectId) {
  const snapshot = await getDocs(collection(db, "projects", projectId, "references"));
  return snapshot.docs.map((item) => ({
    id: item.id,
    ...item.data(),
    media: normalizeReferenceMedia(item.data().media, projectId, item.id),
  })).sort((a, b) => {
    const aTime = a.createdAt?.toMillis?.() || 0;
    const bTime = b.createdAt?.toMillis?.() || 0;
    return aTime - bTime || a.id.localeCompare(b.id);
  });
}

async function renderReferencesBoard(project) {
  loader("Загружаю референсы…");
  try {
    const [networks, references] = await Promise.all([getNetworks(project.id), getReferenceEntries(project.id)]);
    const editable = canEdit(project.role);
    app.innerHTML = `
      <section class="screen flow-screen references-screen">
        ${pageTopbar("Рабочее пространство")}
        <header class="references-heading">
          <div>
            <p class="step-indicator">Канбан-доска</p>
            <h1>Референсы</h1>
            <p class="subtitle">Собирайте примеры по соцсетям и фиксируйте, что именно хочется взять в работу.</p>
          </div>
          <span class="references-total">${references.length} ${references.length === 1 ? "референс" : "референсов"}</span>
        </header>
        <div data-message></div>
        ${networks.length ? `
          <div class="references-board" style="--reference-columns:${networks.length}">
            ${networks.map((network, columnIndex) => {
              const columnReferences = references.filter((item) => item.networkId === network.id);
              const color = REFERENCE_COLUMN_COLORS[columnIndex % REFERENCE_COLUMN_COLORS.length];
              return `<section class="reference-column reference-column-${color}">
                <header class="reference-column-heading">
                  <div><span>${String(columnIndex + 1).padStart(2, "0")}</span><h2>${esc(network.name)}</h2></div>
                  <small>${columnReferences.length}</small>
                </header>
                <div class="reference-column-cards">
                  ${columnReferences.map((entry, entryIndex) => `
                    <button type="button" class="reference-card" data-open-reference="${entry.id}">
                      <span class="reference-card-number">Референс ${entryIndex + 1}</span>
                      <span class="reference-card-gallery reference-card-gallery-${Math.min(entry.media.length, 4)}">${referenceMediaMarkup(entry.media, true)}</span>
                      <span class="reference-card-note">${esc(entry.note || "Добавьте описание: что понравилось")}</span>
                      <span class="reference-card-open">Открыть →</span>
                    </button>`).join("")}
                  ${editable ? `<button type="button" class="reference-add-card" data-add-reference="${network.id}"><span>＋</span>Добавить референс</button>` : ""}
                  ${!columnReferences.length && !editable ? '<p class="reference-column-empty">Референсов пока нет</p>' : ""}
                </div>
              </section>`;
            }).join("")}
          </div>` : `
          <div class="card references-empty-state">
            <h2>Сначала добавьте соцсеть</h2>
            <p>Столбцы доски создаются автоматически из соцсетей проекта.</p>
            ${project.role === "owner" ? '<button class="button primary" data-reference-network-settings>Настроить соцсети</button>' : ""}
          </div>`}
      </section>`;
    bindTopbar(() => renderProjectWorkspace(project));
    document.querySelector("[data-reference-network-settings]")?.addEventListener("click", () => renderNetworkSettings(project));
    document.querySelectorAll("[data-add-reference]").forEach((button) => {
      button.onclick = () => openReferenceEditor({
        project,
        network: networks.find((item) => item.id === button.dataset.addReference),
        entry: null,
      });
    });
    document.querySelectorAll("[data-open-reference]").forEach((button) => {
      button.onclick = () => {
        const entry = references.find((item) => item.id === button.dataset.openReference);
        openReferenceEditor({ project, network: networks.find((item) => item.id === entry.networkId), entry });
      };
    });
  } catch (error) {
    app.innerHTML = `<div class="loader"><div><h2>Не удалось открыть референсы</h2><p class="error">${esc(readError(error))}</p><button class="button" data-reference-back>Назад</button></div></div>`;
    document.querySelector("[data-reference-back]").onclick = () => renderProjectWorkspace(project);
  }
}

function validateReferenceFile(file) {
  if (!/^(image|video)\//i.test(file.type)) throw new Error(`Файл «${file.name}» не является изображением или видео.`);
  if (file.size > REFERENCE_MEDIA_MAX_BYTES) throw new Error(`Файл «${file.name}» больше 50 МБ.`);
}

async function deleteStoredReferenceMedia(items) {
  await Promise.allSettled(items.map((item) => deleteObject(storageRef(storage, item.path))));
}

async function openReferenceEditor({ project, network, entry }) {
  const editable = canEdit(project.role);
  const entryRef = entry
    ? doc(db, "projects", project.id, "references", entry.id)
    : doc(collection(db, "projects", project.id, "references"));
  const originalMedia = entry?.media || [];
  let keptMedia = [...originalMedia];
  const disabled = editable ? "" : "disabled";
  const modal = openModal(
    entry ? `Референс · ${network.name}` : `Новый референс · ${network.name}`,
    `<form class="form reference-editor-form" id="reference-form">
      <div class="reference-editor-meta"><span>Соцсеть</span><strong>${esc(network.name)}</strong></div>
      <label>Что понравилось
        <textarea name="note" maxlength="4000" placeholder="Опишите идею, приём, подачу, визуальный стиль или деталь, которую хотите сохранить" ${disabled}>${esc(entry?.note || "")}</textarea>
      </label>
      <div class="reference-editor-files">
        <div class="reference-editor-files-heading">
          <div><strong>Медиафайлы</strong><small>До 4 изображений или видео, каждый файл — до 50 МБ</small></div>
          <span data-reference-media-count>${keptMedia.length} / ${REFERENCE_MEDIA_LIMIT}</span>
        </div>
        <div class="reference-editor-media" data-reference-editor-media></div>
        ${editable ? '<label class="reference-file-picker">Добавить файлы<input type="file" name="mediaFiles" accept="image/*,video/*" multiple></label><div class="reference-pending-files" data-reference-pending-files></div>' : ""}
      </div>
      ${editable ? `<div class="reference-editor-actions">${entry ? '<button type="button" class="button danger" data-delete-reference>Удалить</button>' : '<span></span>'}<button class="button primary">Сохранить</button></div>` : ""}
      <div data-message></div>
    </form>`,
    "medium reference-editor-modal",
  );
  const form = modal.querySelector("#reference-form");
  const fileInput = form.elements.mediaFiles;

  const drawMedia = () => {
    const newFiles = fileInput ? [...fileInput.files] : [];
    modal.querySelector("[data-reference-editor-media]").innerHTML = referenceMediaMarkup(keptMedia, false, editable);
    modal.querySelector("[data-reference-media-count]").textContent = `${keptMedia.length + newFiles.length} / ${REFERENCE_MEDIA_LIMIT}`;
    const pending = modal.querySelector("[data-reference-pending-files]");
    if (pending) pending.innerHTML = newFiles.map((file) => `<span>${esc(file.name)} <small>${Math.max(1, Math.round(file.size / 1024))} КБ</small></span>`).join("");
    modal.querySelectorAll("[data-view-reference-media]").forEach((button) => {
      button.onclick = () => openReferenceMediaViewer(keptMedia[Number(button.dataset.viewReferenceMedia)]);
    });
    modal.querySelectorAll("[data-remove-reference-media]").forEach((button) => {
      button.onclick = () => {
        keptMedia.splice(Number(button.dataset.removeReferenceMedia), 1);
        drawMedia();
      };
    });
  };
  drawMedia();
  fileInput?.addEventListener("change", () => {
    const newFiles = [...fileInput.files];
    try {
      newFiles.forEach(validateReferenceFile);
      if (keptMedia.length + newFiles.length > REFERENCE_MEDIA_LIMIT) throw new Error("В одном референсе можно сохранить не более четырёх медиафайлов.");
      showMessage("", "success", form);
    } catch (error) {
      fileInput.value = "";
      showMessage(error.message, "error", form);
    }
    drawMedia();
  });

  if (!editable) return;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const files = data.getAll("mediaFiles").filter((file) => file instanceof File && file.size);
    try {
      files.forEach(validateReferenceFile);
      if (keptMedia.length + files.length > REFERENCE_MEDIA_LIMIT) throw new Error("В одном референсе можно сохранить не более четырёх медиафайлов.");
    } catch (error) {
      showMessage(error.message, "error", form);
      return;
    }
    const progress = beginFormProgress(form, "Сохраняю референс…", files.length + 1);
    if (!progress) return;
    const uploaded = [];
    try {
      for (const file of files) {
        const fileId = globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const path = `projects/${project.id}/references/${entryRef.id}/${fileId}`;
        const fileRef = storageRef(storage, path);
        await uploadBytes(fileRef, file, { contentType: file.type });
        uploaded.push({
          path,
          url: await getDownloadURL(fileRef),
          name: file.name.slice(0, 180),
          type: file.type,
          size: file.size,
        });
        progress.advance(`Загружен файл «${file.name}»`);
      }
      const payload = {
        networkId: network.id,
        networkName: network.name,
        note: data.get("note").trim(),
        media: [...keptMedia, ...uploaded],
        updatedBy: user.uid,
        updatedAt: serverTimestamp(),
      };
      if (entry) await updateDoc(entryRef, payload);
      else await setDoc(entryRef, { ...payload, authorId: user.uid, createdAt: serverTimestamp() });
      progress.advance("Референс сохранён");
      const removedMedia = originalMedia.filter((item) => !keptMedia.some((kept) => kept.path === item.path));
      await deleteStoredReferenceMedia(removedMedia);
      modal.remove();
      await renderReferencesBoard(project);
    } catch (error) {
      await deleteStoredReferenceMedia(uploaded);
      showMessage(readError(error), "error", form);
    } finally {
      progress.finish();
    }
  };
  modal.querySelector("[data-delete-reference]")?.addEventListener("click", async (event) => {
    if (!confirm("Удалить этот референс вместе с медиафайлами?")) return;
    event.currentTarget.disabled = true;
    try {
      await deleteDoc(entryRef);
      await deleteStoredReferenceMedia(originalMedia);
      modal.remove();
      await renderReferencesBoard(project);
    } catch (error) {
      event.currentTarget.disabled = false;
      showMessage(readError(error), "error", form);
    }
  });
}

/* ---------------- Анализ целевой аудитории ---------------- */

const AUDIENCE_LIMITS = { segments: 8, criteria: 40 };
const AUDIENCE_GROUPS = [
  { name: "Демографические", criteria: ["Возраст", "Пол", "Доход", "Образование", "Семейное положение"] },
  { name: "Географические", criteria: ["Район", "Город", "Регион", "Страна"] },
  { name: "Поведенческие", criteria: ["Степень лояльности", "Покупательские привычки", "Частота покупок", "Размер покупок", "Средний чек"] },
  { name: "Психографические", criteria: ["Мотивации", "Ценности", "Интересы", "Образ жизни"] },
  { name: "Технологические", criteria: ["Устройства", "Интернет-браузеры", "Операционные системы"] },
  { name: "Каналы покупок", criteria: ["Сайт", "Мессенджеры", "Соцсети", "Офлайн-магазины", "Телефонные звонки"] },
  { name: "Интересы", criteria: ["Здоровье", "Спорт", "Мода", "Технологии", "Путешествия"] },
];

function audienceItemId(prefix) {
  const randomPart = globalThis.crypto?.randomUUID?.().replaceAll("-", "")
    || `${Date.now()}${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${randomPart}`;
}

function blankAudienceAnalysis() {
  const segments = [
    { id: audienceItemId("segment"), name: "Основной сегмент", description: "" },
    { id: audienceItemId("segment"), name: "Дополнительный сегмент", description: "" },
  ];
  return {
    segments,
    criteria: AUDIENCE_GROUPS.flatMap((group) => group.criteria.map((name) => ({
      id: audienceItemId("criterion"),
      group: group.name,
      name,
      values: Object.fromEntries(segments.map((segment) => [segment.id, ""])),
    }))),
  };
}

function normalizeAudienceAnalysis(data) {
  if (!data || !Array.isArray(data.segments) || !Array.isArray(data.criteria)) return blankAudienceAnalysis();
  const seenSegmentIds = new Set();
  const segments = data.segments.slice(0, AUDIENCE_LIMITS.segments).map((segment) => {
    const storedId = typeof segment?.id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(segment.id)
      ? segment.id
      : audienceItemId("segment");
    const id = seenSegmentIds.has(storedId) ? audienceItemId("segment") : storedId;
    seenSegmentIds.add(id);
    return {
      id,
      name: String(segment?.name || "").slice(0, 80),
      description: String(segment?.description || "").slice(0, 300),
    };
  });
  if (!segments.length) segments.push({ id: audienceItemId("segment"), name: "Основной сегмент", description: "" });

  const seenCriterionIds = new Set();
  const criteria = data.criteria.slice(0, AUDIENCE_LIMITS.criteria).map((criterion) => {
    const storedId = typeof criterion?.id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(criterion.id)
      ? criterion.id
      : audienceItemId("criterion");
    const id = seenCriterionIds.has(storedId) ? audienceItemId("criterion") : storedId;
    seenCriterionIds.add(id);
    return {
      id,
      group: String(criterion?.group || "Другое").slice(0, 80),
      name: String(criterion?.name || "").slice(0, 100),
      values: Object.fromEntries(segments.map((segment) => [
        segment.id,
        String(criterion?.values?.[segment.id] || "").slice(0, 1200),
      ])),
    };
  });
  if (!criteria.length) {
    criteria.push({
      id: audienceItemId("criterion"),
      group: "Другое",
      name: "",
      values: Object.fromEntries(segments.map((segment) => [segment.id, ""])),
    });
  }
  return { segments, criteria };
}

function syncAudienceDraft(draft, root = document) {
  root.querySelectorAll("[data-audience-segment-name]").forEach((input) => {
    const segment = draft.segments.find((item) => item.id === input.dataset.audienceSegmentName);
    if (segment) segment.name = input.value;
  });
  root.querySelectorAll("[data-audience-segment-description]").forEach((input) => {
    const segment = draft.segments.find((item) => item.id === input.dataset.audienceSegmentDescription);
    if (segment) segment.description = input.value;
  });
  root.querySelectorAll("[data-audience-criterion-name]").forEach((input) => {
    const criterion = draft.criteria.find((item) => item.id === input.dataset.audienceCriterionName);
    if (criterion) criterion.name = input.value;
  });
  root.querySelectorAll("[data-audience-criterion-group]").forEach((input) => {
    const criterion = draft.criteria.find((item) => item.id === input.dataset.audienceCriterionGroup);
    if (criterion) criterion.group = input.value;
  });
  root.querySelectorAll("[data-audience-value]").forEach((input) => {
    const criterion = draft.criteria.find((item) => item.id === input.dataset.criterionId);
    if (criterion) criterion.values[input.dataset.segmentId] = input.value;
  });
}

function validateAudienceDraft(draft, root) {
  const segmentNames = draft.segments.map((segment) => segment.name.trim());
  const criterionNames = draft.criteria.map((criterion) => criterion.name.trim());
  const criterionGroups = draft.criteria.map((criterion) => criterion.group.trim());
  const duplicateIndex = (values) => {
    const normalized = values.map((value) => value.toLocaleLowerCase("ru-RU"));
    return normalized.findIndex((value, index) => value && normalized.indexOf(value) !== index);
  };
  const emptySegment = segmentNames.findIndex((name) => !name);
  const emptyCriterion = criterionNames.findIndex((name) => !name);
  const emptyGroup = criterionGroups.findIndex((name) => !name);
  const duplicateSegment = duplicateIndex(segmentNames);
  const criterionKeys = criterionNames.map((name, index) => `${criterionGroups[index]}\u0000${name}`);
  const duplicateCriterion = duplicateIndex(criterionKeys);
  let input = null;
  let message = "";
  if (emptySegment >= 0) {
    input = root.querySelector(`[data-audience-segment-name="${draft.segments[emptySegment].id}"]`);
    message = "Назовите каждый сегмент аудитории.";
  } else if (emptyGroup >= 0) {
    input = root.querySelector(`[data-audience-criterion-group="${draft.criteria[emptyGroup].id}"]`);
    message = "Укажите группу для каждого критерия.";
  } else if (emptyCriterion >= 0) {
    input = root.querySelector(`[data-audience-criterion-name="${draft.criteria[emptyCriterion].id}"]`);
    message = "Заполните название каждого критерия.";
  } else if (duplicateSegment >= 0) {
    input = root.querySelector(`[data-audience-segment-name="${draft.segments[duplicateSegment].id}"]`);
    message = "Названия сегментов не должны повторяться.";
  } else if (duplicateCriterion >= 0) {
    input = root.querySelector(`[data-audience-criterion-name="${draft.criteria[duplicateCriterion].id}"]`);
    message = "Критерии внутри одной группы не должны повторяться.";
  }
  if (input) {
    input.setAttribute("aria-invalid", "true");
    input.scrollIntoView({ behavior: "smooth", block: "center" });
    input.focus({ preventScroll: true });
    return message;
  }
  return "";
}

async function renderAudienceAnalysis(project) {
  loader("Загружаю анализ аудитории…");
  const analysisRef = doc(db, "projects", project.id, "audienceAnalyses", "main");
  let snapshot;
  try {
    snapshot = await getDoc(analysisRef);
  } catch (error) {
    app.innerHTML = `<section class="screen flow-screen">${pageTopbar("К проекту")}<div class="flow-card card"><h1>Целевая аудитория</h1><div data-message><p class="error">${esc(readError(error))}</p></div></div></section>`;
    bindTopbar(() => renderProjectWorkspace(project));
    return;
  }
  const editable = canEdit(project.role);
  let hasSavedAnalysis = snapshot.exists();
  const draft = hasSavedAnalysis ? normalizeAudienceAnalysis(snapshot.data()) : blankAudienceAnalysis();

  app.innerHTML = `
    <section class="screen flow-screen audience-screen">
      ${pageTopbar("К проекту")}
      <header class="audience-page-heading">
        <p class="step-indicator">Исследование аудитории</p>
        <h1>Целевая аудитория</h1>
        <p class="subtitle">Разделите аудиторию на сегменты и соберите для каждого демографические, поведенческие и другие характеристики.</p>
      </header>
      ${!hasSavedAnalysis && !editable ? `<div class="flow-card card activity-empty"><h2>Анализа пока нет</h2><p class="muted">Владелец или редактор проекта сможет создать сегменты аудитории.</p></div>` : `
        <form class="audience-analysis-form" data-audience-form>
          <section class="card audience-segment-card">
            <div class="audience-section-heading">
              <div><p class="step-indicator">01 · Сегменты</p><h2>Кого изучаем</h2><p class="muted">Один сегмент — одна однородная группа людей с общими признаками.</p></div>
              ${editable ? `<button class="button ghost small" type="button" data-add-audience-segment>+ Сегмент</button>` : ""}
            </div>
            <div class="audience-segment-list" data-audience-segments></div>
          </section>
          <section class="card audience-matrix-card">
            <div class="audience-section-heading">
              <div><p class="step-indicator">02 · Критерии</p><h2>Портреты сегментов</h2><p class="muted">Базовые параметры можно изменить или удалить, а свои — добавить вручную.</p></div>
              ${editable ? `<button class="button ghost small" type="button" data-add-audience-criterion>+ Критерий</button>` : ""}
            </div>
            <datalist id="audience-groups">${AUDIENCE_GROUPS.map((group) => `<option value="${esc(group.name)}"></option>`).join("")}<option value="Другое"></option></datalist>
            <div class="audience-matrix-scroll" data-audience-matrix></div>
            ${editable ? `<div class="audience-save-row"><span class="muted">До ${AUDIENCE_LIMITS.segments} сегментов и ${AUDIENCE_LIMITS.criteria} критериев</span><button class="button primary" type="submit">Сохранить анализ</button></div><div data-message></div>` : ""}
          </section>
        </form>`}
    </section>`;
  bindTopbar(() => renderProjectWorkspace(project));
  if (!hasSavedAnalysis && !editable) return;

  const form = document.querySelector("[data-audience-form]");
  const drawSegments = () => {
    const root = form.querySelector("[data-audience-segments]");
    root.innerHTML = draft.segments.map((segment, index) => `<article class="audience-segment-item">
      <span class="audience-segment-number">${String(index + 1).padStart(2, "0")}</span>
      ${editable
        ? `<label>Название сегмента<input data-audience-segment-name="${segment.id}" value="${esc(segment.name)}" maxlength="80" placeholder="Например, начинающие эксперты"></label>
          <label>Короткое описание<textarea data-audience-segment-description="${segment.id}" maxlength="300" placeholder="Кто эти люди и что их объединяет">${esc(segment.description)}</textarea></label>
          ${draft.segments.length > 1 ? `<button class="icon-button audience-remove" type="button" data-remove-audience-segment="${segment.id}" aria-label="Удалить сегмент ${esc(segment.name || index + 1)}">×</button>` : ""}`
        : `<div><strong>${esc(segment.name)}</strong><p>${esc(segment.description) || '<span class="muted">Без описания</span>'}</p></div>`}
    </article>`).join("");
    root.querySelectorAll("input, textarea").forEach((input) => {
      input.addEventListener("input", () => {
        input.removeAttribute("aria-invalid");
        syncAudienceDraft(draft, form);
        if (input.matches("[data-audience-segment-name]")) {
          form.querySelectorAll(`[data-audience-segment-label="${input.dataset.audienceSegmentName}"]`).forEach((label) => {
            label.textContent = input.value || "Без названия";
          });
        }
      });
    });
    root.querySelectorAll("[data-remove-audience-segment]").forEach((button) => {
      button.onclick = () => {
        syncAudienceDraft(draft, form);
        const segmentId = button.dataset.removeAudienceSegment;
        draft.segments = draft.segments.filter((segment) => segment.id !== segmentId);
        draft.criteria.forEach((criterion) => delete criterion.values[segmentId]);
        drawAll();
      };
    });
  };
  const drawMatrix = () => {
    const root = form.querySelector("[data-audience-matrix]");
    root.innerHTML = `<table class="audience-matrix" style="min-width:${390 + draft.segments.length * 300}px">
      <thead><tr><th scope="col"><span class="audience-table-label">Группа и критерий</span></th>${draft.segments.map((segment) => `<th scope="col"><span data-audience-segment-label="${segment.id}">${esc(segment.name || "Без названия")}</span></th>`).join("")}</tr></thead>
      <tbody>${draft.criteria.map((criterion, criterionIndex) => `<tr>
        <th scope="row"><div class="audience-criterion-heading">
          ${editable
            ? `<input class="audience-group-input" list="audience-groups" data-audience-criterion-group="${criterion.id}" value="${esc(criterion.group)}" maxlength="80" aria-label="Группа критерия ${criterionIndex + 1}" placeholder="Группа">
              <div class="audience-criterion-name"><input data-audience-criterion-name="${criterion.id}" value="${esc(criterion.name)}" maxlength="100" aria-label="Критерий ${criterionIndex + 1}" placeholder="Название критерия">${draft.criteria.length > 1 ? `<button class="icon-button" type="button" data-remove-audience-criterion="${criterion.id}" aria-label="Удалить критерий ${esc(criterion.name || criterionIndex + 1)}">×</button>` : ""}</div>`
            : `<span class="audience-group-badge">${esc(criterion.group)}</span><strong>${esc(criterion.name)}</strong>`}
        </div></th>
        ${draft.segments.map((segment) => `<td>${editable
          ? `<textarea data-audience-value data-criterion-id="${criterion.id}" data-segment-id="${segment.id}" maxlength="1200" aria-label="${esc(criterion.name || `Критерий ${criterionIndex + 1}`)}: ${esc(segment.name)}" placeholder="Факты, наблюдения, выводы…">${esc(criterion.values[segment.id])}</textarea>`
          : `<p class="audience-value-readonly">${esc(criterion.values[segment.id]) || '<span class="muted">Не заполнено</span>'}</p>`}</td>`).join("")}
      </tr>`).join("")}</tbody>
    </table>`;
    root.querySelectorAll("input, textarea").forEach((input) => input.addEventListener("input", () => {
      input.removeAttribute("aria-invalid");
      syncAudienceDraft(draft, form);
    }));
    root.querySelectorAll("[data-remove-audience-criterion]").forEach((button) => {
      button.onclick = () => {
        syncAudienceDraft(draft, form);
        draft.criteria = draft.criteria.filter((criterion) => criterion.id !== button.dataset.removeAudienceCriterion);
        drawMatrix();
      };
    });
  };
  const drawAll = () => {
    drawSegments();
    drawMatrix();
  };

  form.querySelector("[data-add-audience-segment]")?.addEventListener("click", () => {
    if (draft.segments.length >= AUDIENCE_LIMITS.segments) {
      showMessage(`Можно добавить не более ${AUDIENCE_LIMITS.segments} сегментов.`, "error", form);
      return;
    }
    syncAudienceDraft(draft, form);
    const segment = { id: audienceItemId("segment"), name: `Сегмент ${draft.segments.length + 1}`, description: "" };
    draft.segments.push(segment);
    draft.criteria.forEach((criterion) => { criterion.values[segment.id] = ""; });
    drawAll();
    form.querySelector(`[data-audience-segment-name="${segment.id}"]`)?.select();
  });
  form.querySelector("[data-add-audience-criterion]")?.addEventListener("click", () => {
    if (draft.criteria.length >= AUDIENCE_LIMITS.criteria) {
      showMessage(`Можно добавить не более ${AUDIENCE_LIMITS.criteria} критериев.`, "error", form);
      return;
    }
    syncAudienceDraft(draft, form);
    const criterion = {
      id: audienceItemId("criterion"),
      group: "Другое",
      name: "",
      values: Object.fromEntries(draft.segments.map((segment) => [segment.id, ""])),
    };
    draft.criteria.push(criterion);
    drawMatrix();
    form.querySelector(`[data-audience-criterion-name="${criterion.id}"]`)?.focus();
  });
  form.onsubmit = async (event) => {
    event.preventDefault();
    syncAudienceDraft(draft, form);
    const validationMessage = validateAudienceDraft(draft, form);
    if (validationMessage) {
      showMessage(validationMessage, "error", form);
      return;
    }
    const progress = beginFormProgress(form, "Сохраняю анализ…", 1);
    if (!progress) return;
    try {
      const payload = {
        segments: draft.segments.map((segment) => ({
          id: segment.id,
          name: segment.name.trim(),
          description: segment.description.trim(),
        })),
        criteria: draft.criteria.map((criterion) => ({
          id: criterion.id,
          group: criterion.group.trim(),
          name: criterion.name.trim(),
          values: Object.fromEntries(draft.segments.map((segment) => [segment.id, criterion.values[segment.id].trim()])),
        })),
        updatedBy: user.uid,
        updatedAt: serverTimestamp(),
      };
      if (!hasSavedAnalysis) payload.createdAt = serverTimestamp();
      await setDoc(analysisRef, payload, { merge: true });
      hasSavedAnalysis = true;
      progress.advance("Анализ сохранён");
      showMessage("Анализ целевой аудитории сохранён.", "success", form);
    } catch (error) {
      showMessage(readError(error), "error", form);
    } finally {
      progress.finish();
    }
  };
  drawAll();
}

/* ---------------- Аудит и блокнот ---------------- */

const PROJECT_DOCUMENT_CONFIG = {
  audit: {
    title: "Аудит",
    kicker: "Разбор проекта",
    description: "Фиксируйте состояние площадок, контента и процессов по отдельным главам.",
    firstChapter: "Общая картина",
  },
  notebook: {
    title: "Блокнот",
    kicker: "Рабочие записи",
    description: "Собирайте идеи, заметки и черновики в удобной структуре по главам.",
    firstChapter: "Заметки",
  },
};
const PROJECT_DOCUMENT_LIMITS = { chapters: 30, chapterHtml: 40000, totalHtml: 500000 };
const EDITOR_FONTS = [
  { label: "Georgia", value: "Georgia" },
  { label: "Arial", value: "Arial" },
  { label: "Helvetica", value: "Helvetica" },
  { label: "Verdana", value: "Verdana" },
  { label: "Tahoma", value: "Tahoma" },
  { label: "Trebuchet", value: "Trebuchet MS" },
  { label: "Times New Roman", value: "Times New Roman" },
  { label: "Courier New", value: "Courier New" },
  { label: "Garamond", value: "Garamond" },
  { label: "Palatino", value: "Palatino Linotype" },
];
const EDITOR_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40, 48];
const EDITOR_COLORS = [
  "#342b25", "#5d4637", "#88915f", "#c68b72", "#000000",
  "#374151", "#6b7280", "#991b1b", "#dc2626", "#ea580c",
  "#d97706", "#ca8a04", "#4d7c0f", "#15803d", "#0f766e",
  "#0369a1", "#2563eb", "#4338ca", "#7e22ce", "#be185d",
];
const RICH_TEXT_TAGS = new Set([
  "P", "DIV", "BR", "H1", "H2", "H3", "H4", "SPAN", "STRONG", "EM", "U", "B", "I",
  "UL", "OL", "LI", "BLOCKQUOTE",
]);

function projectDocumentItemId() {
  const randomPart = globalThis.crypto?.randomUUID?.().replaceAll("-", "")
    || `${Date.now()}${Math.random().toString(16).slice(2)}`;
  return `chapter_${randomPart}`;
}

function blankProjectDocument(kind) {
  return {
    kind,
    chapters: [{ id: projectDocumentItemId(), title: PROJECT_DOCUMENT_CONFIG[kind].firstChapter, html: "" }],
  };
}

function normalizeCssColor(value) {
  const color = String(value || "").trim().toLowerCase();
  if (/^#[0-9a-f]{3,6}$/.test(color)) return color;
  if (/^rgba?\([\d\s.,%]+\)$/.test(color)) return color;
  return "";
}

function sanitizeRichText(html = "") {
  const parsed = new DOMParser().parseFromString(String(html), "text/html");
  [...parsed.body.querySelectorAll("*")].reverse().forEach((element) => {
    if (!RICH_TEXT_TAGS.has(element.tagName)) {
      element.replaceWith(...element.childNodes);
      return;
    }
    const safeStyles = {};
    const fontFamily = element.style.fontFamily.replaceAll(/["']/g, "").trim();
    if (EDITOR_FONTS.some((font) => font.value.toLocaleLowerCase("en-US") === fontFamily.toLocaleLowerCase("en-US"))) {
      safeStyles.fontFamily = fontFamily;
    }
    const size = Number.parseInt(element.style.fontSize, 10);
    if (EDITOR_SIZES.includes(size)) safeStyles.fontSize = `${size}px`;
    const color = normalizeCssColor(element.style.color);
    if (color) safeStyles.color = color;
    if (["left", "center", "right", "justify"].includes(element.style.textAlign)) safeStyles.textAlign = element.style.textAlign;
    if (["bold", "700"].includes(element.style.fontWeight)) safeStyles.fontWeight = "bold";
    if (element.style.fontStyle === "italic") safeStyles.fontStyle = "italic";
    if (element.style.textDecorationLine === "underline" || element.style.textDecoration.includes("underline")) {
      safeStyles.textDecoration = "underline";
    }
    [...element.attributes].forEach((attribute) => element.removeAttribute(attribute.name));
    Object.assign(element.style, safeStyles);
  });
  return parsed.body.innerHTML;
}

function setSanitizedRichText(element, html) {
  const parsed = new DOMParser().parseFromString(sanitizeRichText(html), "text/html");
  element.replaceChildren(...[...parsed.body.childNodes].map((node) => document.importNode(node, true)));
}

function normalizeProjectDocument(data, kind) {
  if (!data || !Array.isArray(data.chapters)) return blankProjectDocument(kind);
  const seenIds = new Set();
  const chapters = data.chapters.slice(0, PROJECT_DOCUMENT_LIMITS.chapters).map((chapter) => {
    const storedId = typeof chapter?.id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(chapter.id)
      ? chapter.id
      : projectDocumentItemId();
    const id = seenIds.has(storedId) ? projectDocumentItemId() : storedId;
    seenIds.add(id);
    return {
      id,
      title: String(chapter?.title || "").slice(0, 100),
      html: sanitizeRichText(chapter?.html || ""),
    };
  });
  if (!chapters.length) return blankProjectDocument(kind);
  return { kind, chapters };
}

function projectDocumentToolbarMarkup() {
  return `<div class="rich-toolbar" data-rich-toolbar role="toolbar" aria-label="Форматирование текста">
    <label class="rich-toolbar-field"><span>Шрифт</span><select data-rich-font>${EDITOR_FONTS.map((font) => `<option value="${esc(font.value)}">${esc(font.label)}</option>`).join("")}</select></label>
    <label class="rich-toolbar-field rich-toolbar-size"><span>Размер</span><select data-rich-size>${EDITOR_SIZES.map((size) => `<option value="${size}"${size === 16 ? " selected" : ""}>${size}</option>`).join("")}</select></label>
    <label class="rich-toolbar-field"><span>Стиль</span><select data-rich-block><option value="p">Обычный текст</option><option value="h1">Заголовок 1</option><option value="h2">Заголовок 2</option><option value="h3">Заголовок 3</option><option value="h4">Заголовок 4</option><option value="blockquote">Цитата</option></select></label>
    <div class="rich-toolbar-buttons" aria-label="Начертание">
      <button type="button" data-rich-command="bold" aria-label="Полужирный"><strong>Ж</strong></button>
      <button type="button" data-rich-command="italic" aria-label="Курсив"><em>К</em></button>
      <button type="button" data-rich-command="underline" aria-label="Подчёркнутый"><u>Ч</u></button>
      <button type="button" data-rich-command="insertUnorderedList" aria-label="Маркированный список">• ≡</button>
      <button type="button" data-rich-command="insertOrderedList" aria-label="Нумерованный список">1. ≡</button>
    </div>
    <fieldset class="rich-color-field"><legend>Цвет текста</legend><div class="rich-color-palette">${EDITOR_COLORS.map((color, index) => `<button type="button" data-rich-color="${color}" style="--swatch:${color}" aria-label="Цвет ${index + 1}: ${color}" title="${color}"></button>`).join("")}</div></fieldset>
  </div>`;
}

function bindRichTextToolbar(editor, root, onInput) {
  let savedRange = null;
  const rememberSelection = () => {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (editor.contains(range.commonAncestorContainer)) savedRange = range.cloneRange();
  };
  const restoreSelection = () => {
    if (!savedRange) return;
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(savedRange);
  };
  const run = (command, value = null) => {
    editor.focus();
    restoreSelection();
    document.execCommand("styleWithCSS", false, true);
    document.execCommand(command, false, value);
    rememberSelection();
    onInput();
  };
  ["keyup", "mouseup", "input", "focus"].forEach((eventName) => editor.addEventListener(eventName, rememberSelection));
  editor.addEventListener("input", onInput);
  editor.addEventListener("paste", (event) => {
    event.preventDefault();
    const clipboard = event.clipboardData;
    const html = clipboard?.getData("text/html");
    const text = clipboard?.getData("text/plain") || "";
    document.execCommand(html ? "insertHTML" : "insertText", false, html ? sanitizeRichText(html) : text);
    rememberSelection();
    onInput();
  });
  editor.addEventListener("drop", (event) => event.preventDefault());
  root.querySelectorAll("button").forEach((button) => button.addEventListener("mousedown", (event) => event.preventDefault()));
  root.querySelectorAll("[data-rich-command]").forEach((button) => {
    button.onclick = () => run(button.dataset.richCommand);
  });
  root.querySelector("[data-rich-font]").onchange = (event) => run("fontName", event.target.value);
  root.querySelector("[data-rich-block]").onchange = (event) => run("formatBlock", event.target.value);
  root.querySelector("[data-rich-size]").onchange = (event) => {
    const size = Number(event.target.value);
    run("fontSize", "7");
    editor.querySelectorAll('font[size="7"]').forEach((font) => {
      const span = document.createElement("span");
      span.style.fontSize = `${size}px`;
      span.replaceChildren(...font.childNodes);
      font.replaceWith(span);
    });
    editor.querySelectorAll("span").forEach((span) => {
      if (["xxx-large", "-webkit-xxx-large"].includes(span.style.fontSize)) span.style.fontSize = `${size}px`;
    });
    onInput();
  };
  root.querySelectorAll("[data-rich-color]").forEach((button) => {
    button.onclick = () => run("foreColor", button.dataset.richColor);
  });
}

function validateProjectDocument(draft, root) {
  const titles = draft.chapters.map((chapter) => chapter.title.trim());
  const normalized = titles.map((title) => title.toLocaleLowerCase("ru-RU"));
  const emptyIndex = titles.findIndex((title) => !title);
  const duplicateIndex = normalized.findIndex((title, index) => title && normalized.indexOf(title) !== index);
  const oversizedIndex = draft.chapters.findIndex((chapter) => chapter.html.length > PROJECT_DOCUMENT_LIMITS.chapterHtml);
  const totalHtml = draft.chapters.reduce((total, chapter) => total + chapter.html.length, 0);
  let message = "";
  if (emptyIndex >= 0) message = "Назовите каждую главу.";
  else if (duplicateIndex >= 0) message = "Названия глав не должны повторяться.";
  else if (oversizedIndex >= 0) message = "Одна из глав слишком большая. Разделите её на несколько глав.";
  else if (totalHtml > PROJECT_DOCUMENT_LIMITS.totalHtml) message = "Документ слишком большой. Сократите текст или разделите его между проектами.";
  if (message) {
    const invalidIndex = emptyIndex >= 0 ? emptyIndex : duplicateIndex >= 0 ? duplicateIndex : oversizedIndex;
    const chapter = draft.chapters[invalidIndex];
    const target = chapter ? root.querySelector(`[data-document-chapter="${chapter.id}"]`) : null;
    target?.focus();
    target?.setAttribute("aria-invalid", "true");
  }
  return message;
}

async function renderProjectDocument(project, kind) {
  const config = PROJECT_DOCUMENT_CONFIG[kind];
  if (!config) return;
  loader(`Загружаю раздел «${config.title}»…`);
  const documentRef = doc(db, "projects", project.id, "projectDocuments", kind);
  let snapshot;
  try {
    snapshot = await getDoc(documentRef);
  } catch (error) {
    app.innerHTML = `<section class="screen flow-screen">${pageTopbar("К проекту")}<div class="flow-card card"><h1>${esc(config.title)}</h1><div data-message><p class="error">${esc(readError(error))}</p></div></div></section>`;
    bindTopbar(() => renderProjectWorkspace(project));
    return;
  }
  const editable = canEdit(project.role);
  let hasSavedDocument = snapshot.exists();
  const draft = hasSavedDocument ? normalizeProjectDocument(snapshot.data(), kind) : blankProjectDocument(kind);
  let selectedChapterId = draft.chapters[0].id;

  app.innerHTML = `<section class="screen flow-screen project-document-screen">
    ${pageTopbar("К проекту")}
    <header class="project-document-page-heading"><p class="step-indicator">${esc(config.kicker)}</p><h1>${esc(config.title)}</h1><p class="subtitle">${esc(config.description)}</p></header>
    ${!hasSavedDocument && !editable ? `<div class="flow-card card activity-empty"><h2>Здесь пока пусто</h2><p class="muted">Владелец или редактор проекта сможет добавить главы и текст.</p></div>` : `
      <form class="project-document-form card" data-project-document-form>
        <aside class="document-chapters-panel">
          <div class="document-chapters-heading"><span>Главы</span><small data-chapter-count></small></div>
          <nav class="document-chapter-list" data-document-chapters aria-label="Главы документа"></nav>
          ${editable ? `<button class="button ghost small document-add-chapter" type="button" data-add-document-chapter>+ Добавить главу</button>` : ""}
        </aside>
        <section class="document-editor-panel" data-document-editor-panel></section>
      </form>`}
  </section>`;
  bindTopbar(() => renderProjectWorkspace(project));
  if (!hasSavedDocument && !editable) return;

  const form = document.querySelector("[data-project-document-form]");
  const syncSelectedChapter = () => {
    const chapter = draft.chapters.find((item) => item.id === selectedChapterId);
    if (!chapter) return;
    const titleInput = form.querySelector("[data-active-chapter-title]");
    const editor = form.querySelector("[data-rich-editor]");
    if (titleInput) chapter.title = titleInput.value;
    if (editor) chapter.html = sanitizeRichText(editor.innerHTML);
  };
  const drawChapterList = () => {
    const root = form.querySelector("[data-document-chapters]");
    form.querySelector("[data-chapter-count]").textContent = `${draft.chapters.length} из ${PROJECT_DOCUMENT_LIMITS.chapters}`;
    root.innerHTML = draft.chapters.map((chapter, index) => `<button class="document-chapter-button${chapter.id === selectedChapterId ? " active" : ""}" type="button" data-document-chapter="${chapter.id}"><span>${String(index + 1).padStart(2, "0")}</span><strong>${esc(chapter.title || "Без названия")}</strong></button>`).join("");
    root.querySelectorAll("[data-document-chapter]").forEach((button) => {
      button.onclick = () => {
        if (button.dataset.documentChapter === selectedChapterId) return;
        syncSelectedChapter();
        selectedChapterId = button.dataset.documentChapter;
        drawAll();
      };
    });
  };
  const drawEditor = () => {
    const chapter = draft.chapters.find((item) => item.id === selectedChapterId);
    const root = form.querySelector("[data-document-editor-panel]");
    root.innerHTML = editable ? `
      <div class="document-editor-heading"><label>Название главы<input data-active-chapter-title maxlength="100" value="${esc(chapter.title)}" placeholder="Название главы"></label>${draft.chapters.length > 1 ? `<button class="button ghost small" type="button" data-delete-document-chapter>Удалить главу</button>` : ""}</div>
      ${projectDocumentToolbarMarkup()}
      <div class="rich-editor" data-rich-editor contenteditable="true" role="textbox" aria-multiline="true" aria-label="Текст главы ${esc(chapter.title)}" data-placeholder="Начните писать…"></div>
      <div class="document-save-row"><span class="muted">Изменения сохраняются для всей команды</span><button class="button primary" type="submit">Сохранить</button></div><div data-message></div>` : `
      <div class="document-editor-heading"><div><p class="step-indicator">Выбранная глава</p><h2>${esc(chapter.title)}</h2></div></div>
      <article class="rich-editor rich-editor-readonly" data-rich-editor aria-label="Текст главы ${esc(chapter.title)}"></article>`;
    const editor = root.querySelector("[data-rich-editor]");
    setSanitizedRichText(editor, chapter.html);
    if (!editable) return;
    const titleInput = root.querySelector("[data-active-chapter-title]");
    titleInput.addEventListener("input", () => {
      titleInput.removeAttribute("aria-invalid");
      chapter.title = titleInput.value;
      const listLabel = form.querySelector(`[data-document-chapter="${chapter.id}"] strong`);
      if (listLabel) listLabel.textContent = titleInput.value || "Без названия";
    });
    bindRichTextToolbar(editor, root.querySelector("[data-rich-toolbar]"), () => {
      chapter.html = sanitizeRichText(editor.innerHTML);
    });
    root.querySelector("[data-delete-document-chapter]")?.addEventListener("click", () => {
      draft.chapters = draft.chapters.filter((item) => item.id !== selectedChapterId);
      selectedChapterId = draft.chapters[0].id;
      drawAll();
    });
  };
  const drawAll = () => {
    drawChapterList();
    drawEditor();
  };

  form.querySelector("[data-add-document-chapter]")?.addEventListener("click", () => {
    if (draft.chapters.length >= PROJECT_DOCUMENT_LIMITS.chapters) {
      showMessage(`Можно добавить не более ${PROJECT_DOCUMENT_LIMITS.chapters} глав.`, "error", form);
      return;
    }
    syncSelectedChapter();
    const chapter = { id: projectDocumentItemId(), title: `Глава ${draft.chapters.length + 1}`, html: "" };
    draft.chapters.push(chapter);
    selectedChapterId = chapter.id;
    drawAll();
    form.querySelector("[data-active-chapter-title]")?.select();
  });
  form.onsubmit = async (event) => {
    event.preventDefault();
    syncSelectedChapter();
    const validationMessage = validateProjectDocument(draft, form);
    if (validationMessage) {
      showMessage(validationMessage, "error", form);
      return;
    }
    const progress = beginFormProgress(form, "Сохраняю документ…", 1);
    if (!progress) return;
    try {
      const payload = {
        kind,
        chapters: draft.chapters.map((chapter) => ({ id: chapter.id, title: chapter.title.trim(), html: sanitizeRichText(chapter.html) })),
        updatedBy: user.uid,
        updatedAt: serverTimestamp(),
      };
      if (!hasSavedDocument) payload.createdAt = serverTimestamp();
      await setDoc(documentRef, payload, { merge: true });
      hasSavedDocument = true;
      progress.advance("Документ сохранён");
      showMessage(`${config.title} сохранён.`, "success", form);
    } catch (error) {
      showMessage(readError(error), "error", form);
    } finally {
      progress.finish();
    }
  };
  drawAll();
}

/* ---------------- Анализ конкурентов ---------------- */

const COMPETITOR_COLORS = ["#5d4637", "#88915f", "#c68b72", "#6f8294", "#b3904d", "#8d6b91"];
const COMPETITOR_LIMITS = { companies: 6, criteria: 12 };

function competitorItemId(prefix) {
  const randomPart = globalThis.crypto?.randomUUID?.().replaceAll("-", "")
    || `${Date.now()}${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${randomPart}`;
}

function blankCompetitorAnalysis() {
  const companies = [
    { id: competitorItemId("company"), name: "Ваша компания" },
    { id: competitorItemId("company"), name: "Конкурент 1" },
  ];
  return {
    companies,
    criteria: Array.from({ length: 3 }, () => ({
      id: competitorItemId("criterion"),
      name: "",
      notes: Object.fromEntries(companies.map((company) => [company.id, ""])),
      scores: Object.fromEntries(companies.map((company) => [company.id, 0])),
    })),
  };
}

function normalizeCompetitorAnalysis(data) {
  if (!data || !Array.isArray(data.companies) || !Array.isArray(data.criteria)) return blankCompetitorAnalysis();
  const seenCompanyIds = new Set();
  const companies = data.companies.slice(0, COMPETITOR_LIMITS.companies).map((company) => {
    const storedId = typeof company?.id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(company.id)
      ? company.id
      : competitorItemId("company");
    const id = seenCompanyIds.has(storedId) ? competitorItemId("company") : storedId;
    seenCompanyIds.add(id);
    return { id, name: String(company?.name || "").slice(0, 80) };
  });
  while (companies.length < 2) companies.push({ id: competitorItemId("company"), name: companies.length ? "Конкурент 1" : "Ваша компания" });

  const seenCriterionIds = new Set();
  const criteria = data.criteria.slice(0, COMPETITOR_LIMITS.criteria).map((criterion) => {
    const storedId = typeof criterion?.id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(criterion.id)
      ? criterion.id
      : competitorItemId("criterion");
    const id = seenCriterionIds.has(storedId) ? competitorItemId("criterion") : storedId;
    seenCriterionIds.add(id);
    return {
      id,
      name: String(criterion?.name || "").slice(0, 100),
      notes: Object.fromEntries(companies.map((company) => [
        company.id,
        String(criterion?.notes?.[company.id] || "").slice(0, 1000),
      ])),
      scores: Object.fromEntries(companies.map((company) => [
        company.id,
        Math.min(5, Math.max(0, Math.round(Number(criterion?.scores?.[company.id]) || 0))),
      ])),
    };
  });
  if (!criteria.length) {
    criteria.push({
      id: competitorItemId("criterion"),
      name: "",
      notes: Object.fromEntries(companies.map((company) => [company.id, ""])),
      scores: Object.fromEntries(companies.map((company) => [company.id, 0])),
    });
  }
  return { companies, criteria };
}

function syncCompetitorDraft(draft, root = document) {
  root.querySelectorAll("[data-company-name]").forEach((input) => {
    const company = draft.companies.find((item) => item.id === input.dataset.companyName);
    if (company) company.name = input.value;
  });
  root.querySelectorAll("[data-criterion-name]").forEach((input) => {
    const criterion = draft.criteria.find((item) => item.id === input.dataset.criterionName);
    if (criterion) criterion.name = input.value;
  });
  root.querySelectorAll("[data-competitor-note]").forEach((input) => {
    const criterion = draft.criteria.find((item) => item.id === input.dataset.criterionId);
    if (criterion) criterion.notes[input.dataset.companyId] = input.value;
  });
  root.querySelectorAll("[data-competitor-score]").forEach((input) => {
    const criterion = draft.criteria.find((item) => item.id === input.dataset.criterionId);
    if (criterion) criterion.scores[input.dataset.companyId] = Math.min(5, Math.max(0, Math.round(Number(input.value) || 0)));
  });
}

function competitorRadarMarkup(draft) {
  const criteria = draft.criteria.filter((criterion) => criterion.name.trim());
  if (criteria.length < 3) {
    return `<div class="competitor-chart-empty">
      <strong>Диаграмма появится после заполнения</strong>
      <span>Укажите минимум три критерия и оценки от 0 до 5.</span>
    </div>`;
  }

  const width = 760;
  const height = 540;
  const centerX = 285;
  const centerY = 270;
  const radius = 180;
  const point = (index, value) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / criteria.length;
    const distance = radius * value / 5;
    return [centerX + Math.cos(angle) * distance, centerY + Math.sin(angle) * distance];
  };
  const pointsString = (values) => values.map((value, index) => point(index, value).map((part) => part.toFixed(1)).join(",")).join(" ");
  const levels = Array.from({ length: 5 }, (_, index) => index + 1);

  return `<div class="competitor-chart-scroll">
    <svg class="competitor-radar" viewBox="0 0 ${width} ${height}" role="img" aria-label="Диаграмма сравнения компаний по ${criteria.length} критериям">
      <g class="radar-grid">
        ${levels.map((level) => `<polygon points="${pointsString(criteria.map(() => level))}" />`).join("")}
        ${criteria.map((criterion, index) => {
          const [x, y] = point(index, 5);
          return `<line x1="${centerX}" y1="${centerY}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" />`;
        }).join("")}
      </g>
      <g class="radar-scale" aria-hidden="true">
        ${levels.map((level) => `<text x="${centerX + 7}" y="${(centerY - radius * level / 5 + 4).toFixed(1)}">${level}</text>`).join("")}
      </g>
      <g class="radar-labels">
        ${criteria.map((criterion, index) => {
          const angle = -Math.PI / 2 + (Math.PI * 2 * index) / criteria.length;
          const labelRadius = radius + 28;
          const x = centerX + Math.cos(angle) * labelRadius;
          const y = centerY + Math.sin(angle) * labelRadius;
          const anchor = Math.cos(angle) > 0.25 ? "start" : Math.cos(angle) < -0.25 ? "end" : "middle";
          const label = criterion.name.trim();
          const shortLabel = label.length > 24 ? `${label.slice(0, 22)}…` : label;
          return `<text x="${x.toFixed(1)}" y="${(y + 5).toFixed(1)}" text-anchor="${anchor}"><title>${esc(label)}</title>${esc(shortLabel)}</text>`;
        }).join("")}
      </g>
      <g class="radar-series">
        ${draft.companies.map((company, companyIndex) => {
          const color = COMPETITOR_COLORS[companyIndex];
          const values = criteria.map((criterion) => criterion.scores[company.id] || 0);
          return `<g style="--series-color:${color}">
            <polygon points="${pointsString(values)}" />
            ${values.map((value, index) => {
              const [x, y] = point(index, value);
              return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4"><title>${esc(company.name || `Компания ${companyIndex + 1}`)}: ${value}</title></circle>`;
            }).join("")}
          </g>`;
        }).join("")}
      </g>
      <g class="radar-legend">
        ${draft.companies.map((company, index) => `<g transform="translate(525 ${150 + index * 42})">
          <line x1="0" y1="0" x2="34" y2="0" style="stroke:${COMPETITOR_COLORS[index]}" />
          <circle cx="17" cy="0" r="4" style="fill:${COMPETITOR_COLORS[index]}" />
          <text x="46" y="5"><title>${esc(company.name || `Компания ${index + 1}`)}</title>${esc((company.name || `Компания ${index + 1}`).slice(0, 23))}</text>
        </g>`).join("")}
      </g>
    </svg>
  </div>`;
}

function validateCompetitorDraft(draft, root) {
  const companies = draft.companies.map((company) => company.name.trim());
  const criteria = draft.criteria.map((criterion) => criterion.name.trim());
  const duplicate = (values) => {
    const normalized = values.map((value) => value.toLocaleLowerCase("ru-RU"));
    return normalized.findIndex((value, index) => value && normalized.indexOf(value) !== index);
  };
  const emptyCompany = companies.findIndex((name) => !name);
  const emptyCriterion = criteria.findIndex((name) => !name);
  const duplicateCompany = duplicate(companies);
  const duplicateCriterion = duplicate(criteria);
  let input = null;
  let message = "";
  if (emptyCompany >= 0) {
    input = root.querySelector(`[data-company-name="${draft.companies[emptyCompany].id}"]`);
    message = "Назовите каждую сравниваемую компанию.";
  } else if (emptyCriterion >= 0) {
    input = root.querySelector(`[data-criterion-name="${draft.criteria[emptyCriterion].id}"]`);
    message = "Заполните название каждого критерия.";
  } else if (duplicateCompany >= 0) {
    input = root.querySelector(`[data-company-name="${draft.companies[duplicateCompany].id}"]`);
    message = "Названия компаний не должны повторяться.";
  } else if (duplicateCriterion >= 0) {
    input = root.querySelector(`[data-criterion-name="${draft.criteria[duplicateCriterion].id}"]`);
    message = "Названия критериев не должны повторяться.";
  }
  if (input) {
    input.focus();
    input.setAttribute("aria-invalid", "true");
    return message;
  }
  return "";
}

async function renderCompetitorAnalysis(project) {
  loader("Загружаю анализ конкурентов…");
  const analysisRef = doc(db, "projects", project.id, "competitorAnalyses", "main");
  let snapshot;
  try {
    snapshot = await getDoc(analysisRef);
  } catch (error) {
    app.innerHTML = `<section class="screen flow-screen">${pageTopbar("К проекту")}<div class="flow-card card"><h1>Анализ конкурентов</h1><div data-message><p class="error">${esc(readError(error))}</p></div></div></section>`;
    bindTopbar(() => renderProjectWorkspace(project));
    return;
  }
  const editable = canEdit(project.role);
  let hasSavedAnalysis = snapshot.exists();
  const draft = hasSavedAnalysis ? normalizeCompetitorAnalysis(snapshot.data()) : blankCompetitorAnalysis();

  app.innerHTML = `
    <section class="screen flow-screen competitors-screen">
      ${pageTopbar("К проекту")}
      <header class="competitor-page-heading">
        <p class="step-indicator">Исследование рынка</p>
        <h1>Анализ конкурентов</h1>
        <p class="subtitle">Создайте собственные критерии, добавьте компании и запишите наблюдения. Оценки от 0 до 5 автоматически складываются в диаграмму.</p>
      </header>
      ${!hasSavedAnalysis && !editable ? `<div class="flow-card card activity-empty"><h2>Анализа пока нет</h2><p class="muted">Владелец или редактор проекта сможет создать сравнение конкурентов.</p></div>` : `
        <form class="competitor-analysis-form" data-competitor-form>
          <section class="card competitor-editor-card">
            <div class="competitor-section-heading">
              <div><h2>Критерии и наблюдения</h2><p class="muted">Текст — для деталей, оценка — для итоговой диаграммы.</p></div>
              ${editable ? `<div class="competitor-editor-actions">
                <button class="button ghost small" type="button" data-add-company>+ Компания</button>
                <button class="button ghost small" type="button" data-add-criterion>+ Критерий</button>
              </div>` : ""}
            </div>
            <div class="competitor-table-scroll" data-competitor-table></div>
            ${editable ? `<div class="competitor-save-row">
              <span class="muted">До ${COMPETITOR_LIMITS.companies} компаний и ${COMPETITOR_LIMITS.criteria} критериев</span>
              <button class="button primary" type="submit">Сохранить анализ</button>
            </div><div data-message></div>` : ""}
          </section>
          <section class="card competitor-chart-card">
            <div class="competitor-section-heading"><div><p class="step-indicator">Итог</p><h2>Карта сравнения</h2><p class="muted">Чем дальше точка от центра, тем выше оценка по критерию.</p></div></div>
            <div data-competitor-chart></div>
          </section>
        </form>`}
    </section>`;
  bindTopbar(() => renderProjectWorkspace(project));
  if (!hasSavedAnalysis && !editable) return;

  const form = document.querySelector("[data-competitor-form]");
  const drawChart = () => {
    form.querySelector("[data-competitor-chart]").innerHTML = competitorRadarMarkup(draft);
  };
  const drawTable = () => {
    const tableRoot = form.querySelector("[data-competitor-table]");
    tableRoot.innerHTML = `<table class="competitor-table" style="min-width:${220 + draft.companies.length * 270}px">
      <thead><tr>
        <th scope="col"><span class="competitor-table-label">Критерий сравнения</span></th>
        ${draft.companies.map((company, companyIndex) => `<th scope="col">
          <div class="competitor-company-heading">
            <span class="competitor-color" style="background:${COMPETITOR_COLORS[companyIndex]}" aria-hidden="true"></span>
            ${editable
              ? `<input data-company-name="${company.id}" value="${esc(company.name)}" maxlength="80" aria-label="Название компании ${companyIndex + 1}" placeholder="Название компании">
                ${draft.companies.length > 2 ? `<button class="icon-button" type="button" data-remove-company="${company.id}" aria-label="Удалить компанию ${esc(company.name || companyIndex + 1)}">×</button>` : ""}`
              : `<strong>${esc(company.name)}</strong>`}
          </div>
        </th>`).join("")}
      </tr></thead>
      <tbody>${draft.criteria.map((criterion, criterionIndex) => `<tr>
        <th scope="row"><div class="competitor-criterion-heading">
          ${editable
            ? `<input data-criterion-name="${criterion.id}" value="${esc(criterion.name)}" maxlength="100" aria-label="Критерий ${criterionIndex + 1}" placeholder="Например, цена">
              ${draft.criteria.length > 1 ? `<button class="icon-button" type="button" data-remove-criterion="${criterion.id}" aria-label="Удалить критерий ${esc(criterion.name || criterionIndex + 1)}">×</button>` : ""}`
            : `<strong>${esc(criterion.name)}</strong>`}
        </div></th>
        ${draft.companies.map((company) => `<td>
          ${editable
            ? `<textarea data-competitor-note data-criterion-id="${criterion.id}" data-company-id="${company.id}" maxlength="1000" aria-label="Наблюдение: ${esc(criterion.name || `критерий ${criterionIndex + 1}`)}, ${esc(company.name)}" placeholder="Факты, особенности, выводы…">${esc(criterion.notes[company.id])}</textarea>
              <label class="competitor-score">Оценка <input type="number" min="0" max="5" step="1" inputmode="numeric" data-competitor-score data-criterion-id="${criterion.id}" data-company-id="${company.id}" value="${criterion.scores[company.id]}"><span>из 5</span></label>`
            : `<p class="competitor-note-readonly">${esc(criterion.notes[company.id]) || '<span class="muted">Нет заметки</span>'}</p><span class="competitor-score-badge">${criterion.scores[company.id]} / 5</span>`}
        </td>`).join("")}
      </tr>`).join("")}</tbody>
    </table>`;

    tableRoot.querySelectorAll("input, textarea").forEach((input) => {
      input.addEventListener("input", () => {
        input.removeAttribute("aria-invalid");
        syncCompetitorDraft(draft, form);
        drawChart();
      });
    });
    tableRoot.querySelectorAll("[data-remove-company]").forEach((button) => {
      button.onclick = () => {
        syncCompetitorDraft(draft, form);
        draft.companies = draft.companies.filter((company) => company.id !== button.dataset.removeCompany);
        draft.criteria.forEach((criterion) => {
          delete criterion.notes[button.dataset.removeCompany];
          delete criterion.scores[button.dataset.removeCompany];
        });
        drawTable();
        drawChart();
      };
    });
    tableRoot.querySelectorAll("[data-remove-criterion]").forEach((button) => {
      button.onclick = () => {
        syncCompetitorDraft(draft, form);
        draft.criteria = draft.criteria.filter((criterion) => criterion.id !== button.dataset.removeCriterion);
        drawTable();
        drawChart();
      };
    });
  };

  form.querySelector("[data-add-company]")?.addEventListener("click", () => {
    if (draft.companies.length >= COMPETITOR_LIMITS.companies) {
      showMessage(`Можно сравнить не более ${COMPETITOR_LIMITS.companies} компаний.`, "error", form);
      return;
    }
    syncCompetitorDraft(draft, form);
    const company = { id: competitorItemId("company"), name: `Конкурент ${draft.companies.length}` };
    draft.companies.push(company);
    draft.criteria.forEach((criterion) => {
      criterion.notes[company.id] = "";
      criterion.scores[company.id] = 0;
    });
    drawTable();
    drawChart();
    form.querySelector(`[data-company-name="${company.id}"]`)?.select();
  });
  form.querySelector("[data-add-criterion]")?.addEventListener("click", () => {
    if (draft.criteria.length >= COMPETITOR_LIMITS.criteria) {
      showMessage(`Можно добавить не более ${COMPETITOR_LIMITS.criteria} критериев.`, "error", form);
      return;
    }
    syncCompetitorDraft(draft, form);
    const criterion = {
      id: competitorItemId("criterion"),
      name: "",
      notes: Object.fromEntries(draft.companies.map((company) => [company.id, ""])),
      scores: Object.fromEntries(draft.companies.map((company) => [company.id, 0])),
    };
    draft.criteria.push(criterion);
    drawTable();
    drawChart();
    form.querySelector(`[data-criterion-name="${criterion.id}"]`)?.focus();
  });
  form.onsubmit = async (event) => {
    event.preventDefault();
    syncCompetitorDraft(draft, form);
    const validationMessage = validateCompetitorDraft(draft, form);
    if (validationMessage) {
      showMessage(validationMessage, "error", form);
      return;
    }
    const progress = beginFormProgress(form, "Сохраняю анализ…", 1);
    if (!progress) return;
    try {
      const payload = {
        companies: draft.companies.map((company) => ({ id: company.id, name: company.name.trim() })),
        criteria: draft.criteria.map((criterion) => ({
          id: criterion.id,
          name: criterion.name.trim(),
          notes: Object.fromEntries(draft.companies.map((company) => [company.id, criterion.notes[company.id].trim()])),
          scores: Object.fromEntries(draft.companies.map((company) => [company.id, criterion.scores[company.id]])),
        })),
        updatedBy: user.uid,
        updatedAt: serverTimestamp(),
      };
      if (!hasSavedAnalysis) payload.createdAt = serverTimestamp();
      await setDoc(analysisRef, payload, { merge: true });
      hasSavedAnalysis = true;
      progress.advance("Анализ сохранён");
      showMessage("Анализ конкурентов сохранён.", "success", form);
    } catch (error) {
      showMessage(readError(error), "error", form);
    } finally {
      progress.finish();
    }
  };
  drawTable();
  drawChart();
}

async function getNetworks(projectId) {
  const snapshot = await getDocs(collection(db, "projects", projectId, "networks"));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

async function getRubrics(projectId) {
  const snapshot = await getDocs(collection(db, "projects", projectId, "rubrics"));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

async function getProjectMembers(projectId) {
  const snapshot = await getDocs(query(collection(db, "memberships"), where("projectId", "==", projectId)));
  return snapshot.docs
    .map((item) => ({ id: item.id, ...item.data(), role: normalizeRole(item.data().role) }))
    .sort((a, b) => {
      if (a.role === "owner" && b.role !== "owner") return -1;
      if (b.role === "owner" && a.role !== "owner") return 1;
      return memberDisplayName(a).localeCompare(memberDisplayName(b), "ru");
    });
}

function memberDisplayName(member) {
  return member.userName || member.userEmail || "Участник";
}

function assigneeOptions(members, selectedId = "", selectedName = "") {
  const hasSelectedMember = members.some((member) => member.userId === selectedId);
  const unavailableOption = selectedId && !hasSelectedMember
    ? `<option value="${esc(selectedId)}" selected>${esc(selectedName || "Участник больше не подключён")}</option>`
    : "";
  return `<option value="" ${selectedId ? "" : "selected"}>Не назначен</option>
    ${unavailableOption}
    ${members.map((member) => {
      const name = memberDisplayName(member);
      const label = member.specialty ? `${name} — ${member.specialty}` : name;
      return `<option value="${esc(member.userId)}" ${member.userId === selectedId ? "selected" : ""}>${esc(label)}</option>`;
    }).join("")}`;
}

async function renderRubricSetup(project, options = {}) {
  loader();
  const networks = await getNetworks(project.id);
  const existing = await getRubrics(project.id);
  const rows = existing.length
    ? existing.map((rubric) => ({ id: rubric.id, name: rubric.name, networkIds: rubricNetworkIds(rubric, networks) }))
    : [{ id: "", name: "", networkIds: [] }];
  const removed = new Set();

  const drawRows = () => {
    const list = document.querySelector("[data-rubric-list]");
    list.innerHTML = rows.map((row, index) => `
      <div class="rubric-editor-row" data-rubric-row="${index}">
        <input data-rubric-name value="${esc(row.name)}" maxlength="70" placeholder="Название рубрики">
        <div class="checkbox-list">
          ${networks.map((network) => `<label class="check-pill"><input type="checkbox" value="${network.id}" ${row.networkIds.includes(network.id) ? "checked" : ""}>${esc(network.name)}</label>`).join("")}
        </div>
        <button type="button" class="icon-button" data-remove-rubric="${index}" aria-label="Удалить рубрику">×</button>
        <p class="rubric-row-hint" data-rubric-hint hidden></p>
      </div>`).join("");
    list.querySelectorAll("[data-remove-rubric]").forEach((button) => {
      button.onclick = () => {
        syncRowsFromDom(rows);
        const index = Number(button.dataset.removeRubric);
        if (rows[index].id) removed.add(rows[index].id);
        rows.splice(index, 1);
        if (!rows.length) rows.push({ id: "", name: "", networkIds: [] });
        drawRows();
      };
    });
    bindRubricValidation("[data-rubric-row]");
  };

  app.innerHTML = `
    <section class="screen flow-screen">
      ${pageTopbar(options.firstRun ? "К проекту" : "Назад")}
      <div class="flow-card card">
        <h1>Рубрики</h1>
        <p class="subtitle">Создайте рубрики и укажите, в каких соцсетях каждая из них используется. Можно выбрать несколько площадок.</p>
        <form class="form" id="rubrics-form">
          <div class="rubric-editor-list" data-rubric-list></div>
          <button type="button" class="button ghost" data-add-rubric>+ Добавить рубрику</button>
          <div data-message></div>
          <div class="flow-actions"><span></span><button class="button primary">Сохранить рубрики</button></div>
        </form>
      </div>
    </section>`;

  const goBack = () => options.returnToPlan
    ? renderPlan(options.returnToPlan.projectId, options.returnToPlan.networkId)
    : renderNetworkSelection(project);
  bindTopbar(goBack);
  drawRows();
  document.querySelector("[data-add-rubric]").onclick = () => {
    syncRowsFromDom(rows);
    rows.push({ id: "", name: "", networkIds: [] });
    drawRows();
  };

  document.querySelector("#rubrics-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    syncRowsFromDom(rows);
    const validation = refreshRubricValidation("[data-rubric-row]", true);
    if (!validation.valid) {
      showMessage("Исправьте отмеченные рубрики и повторите сохранение.", "error", form);
      focusFirstRubricError(validation);
      return;
    }
    const progress = beginFormProgress(form, "Сохраняю рубрики…", removed.size + rows.length);
    if (!progress) return;
    try {
      for (const id of removed) {
        await deleteDoc(doc(db, "projects", project.id, "rubrics", id));
        progress.advance("Удаляю ненужную рубрику");
      }
      for (const row of rows) {
        const payload = { name: row.name.trim(), networkIds: row.networkIds, updatedAt: serverTimestamp() };
        if (row.id) await updateDoc(doc(db, "projects", project.id, "rubrics", row.id), payload);
        else await addDoc(collection(db, "projects", project.id, "rubrics"), { ...payload, createdAt: serverTimestamp() });
        progress.advance(`Сохранена рубрика «${row.name.trim()}»`);
      }
      if (options.returnToPlan) renderPlan(options.returnToPlan.projectId, options.returnToPlan.networkId);
      else renderNetworkSelection(project);
    } catch (error) {
      showMessage(readError(error), "error", form);
    } finally {
      progress.finish();
    }
  };
}

function syncRowsFromDom(rows) {
  document.querySelectorAll("[data-rubric-row]").forEach((element) => {
    const index = Number(element.dataset.rubricRow);
    rows[index].name = element.querySelector("[data-rubric-name]").value;
    rows[index].networkIds = [...element.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
  });
}

async function renderNetworkSettings(project) {
  loader();
  const networks = await getNetworks(project.id);
  const existingRubrics = await getRubrics(project.id);
  const rubricRows = existingRubrics.length
    ? existingRubrics.map((rubric) => ({ id: rubric.id, name: rubric.name, networkIds: rubricNetworkIds(rubric, networks) }))
    : [{ id: "", name: "", networkIds: [] }];
  const removedRubrics = new Set();

  const drawProjectRubrics = () => {
    const list = document.querySelector("[data-project-rubric-list]");
    list.innerHTML = rubricRows.map((row, index) => `
      <div class="rubric-editor-row" data-project-rubric-row="${index}">
        <input data-rubric-name value="${esc(row.name)}" maxlength="70" placeholder="Название рубрики">
        <div class="checkbox-list">
          ${networks.map((network) => `<label class="check-pill"><input type="checkbox" value="${network.id}" ${row.networkIds.includes(network.id) ? "checked" : ""}>${esc(network.name)}</label>`).join("")}
        </div>
        <button type="button" class="icon-button" data-remove-project-rubric="${index}" aria-label="Удалить рубрику">×</button>
        <p class="rubric-row-hint" data-rubric-hint hidden></p>
      </div>`).join("");
    list.querySelectorAll("[data-remove-project-rubric]").forEach((button) => {
      button.onclick = () => {
        syncProjectRubrics();
        const index = Number(button.dataset.removeProjectRubric);
        if (rubricRows[index].id) removedRubrics.add(rubricRows[index].id);
        rubricRows.splice(index, 1);
        if (!rubricRows.length) rubricRows.push({ id: "", name: "", networkIds: [] });
        drawProjectRubrics();
      };
    });
    bindRubricValidation("[data-project-rubric-row]");
  };

  const syncProjectRubrics = () => {
    document.querySelectorAll("[data-project-rubric-row]").forEach((element) => {
      const index = Number(element.dataset.projectRubricRow);
      rubricRows[index].name = element.querySelector("[data-rubric-name]").value;
      rubricRows[index].networkIds = [...element.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
    });
  };

  app.innerHTML = `
    <section class="screen flow-screen">
      ${pageTopbar("К проекту")}
      <div class="flow-card card project-setup-card">
        <h1>Настройка проекта</h1>
        <section class="settings-section">
          <h2>Соцсети</h2>
          <p class="subtitle">Добавляйте площадки проекта или удаляйте те, которые больше не используются.</p>
          <div class="tag-list" data-network-tags>
            ${networks.map((network) => `<span class="tag">${esc(network.name)} <button class="icon-button" data-delete-network="${network.id}" aria-label="Удалить соцсеть ${esc(network.name)}">×</button></span>`).join("") || '<span class="muted">Нет соцсетей</span>'}
          </div>
          <form class="form settings-inline-form" id="network-settings-form">
            <label>Новая соцсеть<input name="name" required maxlength="40" placeholder="Название площадки"></label>
            <button class="button">Добавить</button>
            <div data-message></div>
          </form>
        </section>
        <section class="settings-section">
          <h2>Рубрики</h2>
          <p class="subtitle">Создайте рубрики и отметьте соцсети, в которых используется каждая из них.</p>
          <form class="form" id="project-rubrics-form">
            <div class="rubric-editor-list" data-project-rubric-list></div>
            <button type="button" class="button ghost" data-add-project-rubric>+ Добавить рубрику</button>
            <button class="button primary">Сохранить рубрики</button>
            <div data-message></div>
          </form>
        </section>
      </div>
    </section>`;
  bindTopbar(() => renderNetworkSelection(project));
  drawProjectRubrics();
  document.querySelector("#network-settings-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = new FormData(form).get("name").trim();
    const progress = beginFormProgress(form, "Добавляю соцсеть…");
    if (!progress) return;
    try {
      await addDoc(collection(db, "projects", project.id, "networks"), { name, createdAt: serverTimestamp() });
      progress.advance("Соцсеть добавлена");
      await renderNetworkSettings(project);
    } catch (error) {
      showMessage(readError(error), "error", form);
    } finally {
      progress.finish();
    }
  };
  document.querySelectorAll("[data-delete-network]").forEach((button) => {
    button.onclick = async () => {
      if (!confirm("Удалить эту соцсеть из проекта?")) return;
      await deleteDoc(doc(db, "projects", project.id, "networks", button.dataset.deleteNetwork));
      renderNetworkSettings(project);
    };
  });
  document.querySelector("[data-add-project-rubric]").onclick = () => {
    syncProjectRubrics();
    rubricRows.push({ id: "", name: "", networkIds: [] });
    drawProjectRubrics();
  };
  document.querySelector("#project-rubrics-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    syncProjectRubrics();
    const validation = refreshRubricValidation("[data-project-rubric-row]", true);
    if (!validation.valid) {
      showMessage("Исправьте отмеченные рубрики и повторите сохранение.", "error", form);
      focusFirstRubricError(validation);
      return;
    }
    const progress = beginFormProgress(form, "Сохраняю рубрики…", removedRubrics.size + rubricRows.length);
    if (!progress) return;
    try {
      for (const id of removedRubrics) {
        await deleteDoc(doc(db, "projects", project.id, "rubrics", id));
        progress.advance("Удаляю ненужную рубрику");
      }
      removedRubrics.clear();
      for (const row of rubricRows) {
        const payload = { name: row.name.trim(), networkIds: row.networkIds, updatedAt: serverTimestamp() };
        if (row.id) await updateDoc(doc(db, "projects", project.id, "rubrics", row.id), payload);
        else {
          const createdRubric = await addDoc(collection(db, "projects", project.id, "rubrics"), { ...payload, createdAt: serverTimestamp() });
          row.id = createdRubric.id;
        }
        progress.advance(`Сохранена рубрика «${row.name.trim()}»`);
      }
      showMessage("Рубрики сохранены.", "success", form);
    } catch (error) {
      showMessage(readError(error), "error", form);
    } finally {
      progress.finish();
    }
  };
}

async function renderNetworkSelection(project) {
  loader();
  const [networks, members] = await Promise.all([
    getNetworks(project.id),
    canEdit(project.role) ? getProjectMembers(project.id) : Promise.resolve([]),
  ]);
  app.innerHTML = `
    <section class="screen flow-screen">
      ${pageTopbar("Все проекты")}
      <div class="network-select-header">
        <div><h1>${esc(project.name)}</h1><p class="subtitle">Выберите соцсеть, чтобы открыть её контент-план.</p></div>
        <div class="plan-tools">
          <button class="button ghost" data-activity>История</button>
          ${project.role === "owner" ? '<button class="button ghost" data-network-settings>Соцсети</button><button class="button" data-access>Доступ</button>' : ""}
        </div>
      </div>
      <div data-message></div>
      <div class="network-grid">
        ${networks.map((network) => `<article class="network-card">
          <button class="network-card-open" data-open-plan="${network.id}"><strong>${esc(network.name)}</strong><span>Открыть контент-план в новой вкладке →</span></button>
          ${canEdit(project.role)
            ? `<label class="network-assignee">Ответственный
                <select data-network-assignee="${network.id}">${assigneeOptions(members, network.assigneeId, network.assigneeName)}</select>
              </label>`
            : `<div class="network-assignee-summary"><small>Ответственный</small><strong>${esc(network.assigneeName || "Не назначен")}</strong></div>`}
        </article>`).join("") || '<div class="card flow-card"><p>В проекте пока нет соцсетей.</p></div>'}
      </div>
    </section>`;
  bindTopbar(() => renderProjectWorkspace(project));
  document.querySelector("[data-activity]").onclick = () => renderActivity(project);
  document.querySelector("[data-network-settings]")?.addEventListener("click", () => renderNetworkSettings(project));
  document.querySelector("[data-access]")?.addEventListener("click", () => renderAccess(project));
  document.querySelectorAll("[data-network-assignee]").forEach((select) => {
    let savedAssigneeId = select.value;
    select.onchange = async () => {
      const selectedMember = members.find((member) => member.userId === select.value);
      select.disabled = true;
      try {
        await updateDoc(doc(db, "projects", project.id, "networks", select.dataset.networkAssignee), {
          assigneeId: selectedMember?.userId || "",
          assigneeName: selectedMember ? memberDisplayName(selectedMember) : "",
          updatedAt: serverTimestamp(),
        });
        savedAssigneeId = select.value;
        showMessage("Ответственный за соцсеть обновлён.", "success");
      } catch (error) {
        select.value = savedAssigneeId;
        showMessage(readError(error));
      } finally {
        select.disabled = false;
      }
    };
  });
  document.querySelectorAll("[data-open-plan]").forEach((button) => {
    button.onclick = () => {
      const url = new URL(window.location.href);
      url.search = "";
      url.searchParams.set("plan", project.id);
      url.searchParams.set("network", button.dataset.openPlan);
      window.open(url.toString(), "_blank");
    };
  });
}

/* ---------------- Настройки и доступ ---------------- */

async function renderActivity(project) {
  loader("Загружаю историю…");
  try {
    const activitySnapshot = await getDocs(query(
      collection(db, "projects", project.id, "activity"),
      orderBy("createdAt", "desc"),
      limit(100),
    ));
    const activities = activitySnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    app.innerHTML = `
      <section class="screen flow-screen">
        ${pageTopbar("К проекту")}
        <div class="flow-card card activity-card">
          <div class="activity-heading">
            <div><h1>История проекта</h1><p class="subtitle">Последние 100 действий участников. Записи формируются на сервере и не редактируются через приложение.</p></div>
            <span class="activity-count" aria-label="Показано событий: ${activities.length}">${activities.length}</span>
          </div>
          <div class="activity-list">
            ${activities.length ? activities.map((activity) => `
              <article class="activity-item">
                <span class="activity-marker" aria-hidden="true"></span>
                <div class="activity-content">
                  <div class="activity-meta"><strong>${esc(activity.actorName || "Система")}</strong><time>${esc(formatActivityDate(activity.createdAt))}</time></div>
                  <p>${esc(activity.summary || "Изменены данные проекта.")}</p>
                </div>
              </article>`).join("") : '<div class="activity-empty"><h2>Действий пока нет</h2><p class="muted">Новые записи появятся здесь после развёртывания серверной функции истории.</p></div>'}
          </div>
        </div>
      </section>`;
    bindTopbar(() => renderNetworkSelection(project));
  } catch (error) {
    app.innerHTML = `
      <section class="screen flow-screen">
        ${pageTopbar("К проекту")}
        <div class="flow-card card narrow"><h1>История недоступна</h1><p>${esc(readError(error))}</p><p class="muted">Опубликуйте актуальные правила Firestore и повторите попытку.</p></div>
      </section>`;
    bindTopbar(() => renderNetworkSelection(project));
  }
}

async function renderProjectSettings(project) {
  app.innerHTML = `
    <section class="screen flow-screen">
      ${pageTopbar("На главный экран")}
      <div class="flow-card card narrow">
        <h1>Настройки проекта</h1>
        <form class="form" id="project-settings-form">
          <label>Название<input name="name" required maxlength="80" value="${esc(project.name)}"></label>
          <label>О проекте<textarea name="description" maxlength="600">${esc(project.description || "")}</textarea></label>
          <button type="button" class="button ghost" data-manage-networks>Настроить проект</button>
          <button class="button primary">Сохранить изменения</button>
          <div data-message></div>
        </form>
        <div class="flow-actions project-danger-actions">
          <span></span>
          <button class="button danger" data-delete-project>Удалить проект</button>
        </div>
      </div>
    </section>`;
  bindTopbar(renderDashboard);
  document.querySelector("[data-manage-networks]").onclick = () => renderNetworkSettings(project);
  document.querySelector("#project-settings-form").onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await updateDoc(doc(db, "projects", project.id), {
      name: data.get("name").trim(),
      description: data.get("description").trim(),
      updatedAt: serverTimestamp(),
    });
    await loadProjects();
    showMessage("Изменения сохранены.", "success");
  };
  document.querySelector("[data-delete-project]").onclick = async (event) => {
    if (!confirm(`Удалить проект «${project.name}» вместе со всеми публикациями? Это действие нельзя отменить.`)) return;
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Удаляю…";
    try {
      await deleteProject(project);
      projects = [];
      await loadProjects();
      renderDashboard();
    } catch (error) {
      button.disabled = false;
      button.textContent = "Удалить проект";
      showMessage(`Не удалось удалить проект: ${readError(error)}`);
    }
  };
}

async function deleteProject(project) {
  const projectRef = doc(db, "projects", project.id);
  let projectDeleted = false;
  await updateDoc(projectRef, { deletingAt: serverTimestamp(), updatedAt: serverTimestamp() });
  try {
    const snapshots = new Map();
    for (const subcollection of ["networks", "rubrics", "posts", "postImages", "comments", "references", "audienceAnalyses", "competitorAnalyses", "projectDocuments", "activity"]) {
      try {
        snapshots.set(subcollection, await getDocs(collection(db, "projects", project.id, subcollection)));
      } catch (error) {
        if (["postImages", "references", "audienceAnalyses", "competitorAnalyses", "projectDocuments", "activity"].includes(subcollection) && error?.code === "permission-denied") {
          throw new Error("Firestore не разрешил удалить связанные данные. Опубликуйте актуальный файл firestore.rules в Firebase и повторите удаление.");
        }
        throw error;
      }
    }
    const referenceMedia = snapshots.get("references").docs.flatMap((item) => normalizeReferenceMedia(item.data().media, project.id, item.id));
    await deleteStoredReferenceMedia(referenceMedia);
    for (const snapshot of snapshots.values()) {
      for (const item of snapshot.docs) await deleteDoc(item.ref);
    }
    const members = await getDocs(query(collection(db, "memberships"), where("projectId", "==", project.id)));
    const expectedOwnerMembershipId = `${project.id}_${user.uid}`;
    const ownerMembership = members.docs.find((item) => item.id === expectedOwnerMembershipId)
      || members.docs.find((item) => item.data().userId === user.uid && item.data().role === "owner");
    if (!ownerMembership) throw new Error("Не найдена запись владельца проекта. Обновите страницу и повторите удаление.");
    for (const member of members.docs) {
      if (member.id !== ownerMembership.id) await deleteDoc(member.ref);
    }
    if (project.shareCode) {
      const invitationRef = doc(db, "invitations", project.shareCode);
      const invitationSnapshot = await getDoc(invitationRef);
      if (invitationSnapshot.exists()) await deleteDoc(invitationRef);
    }
    await deleteDoc(projectRef);
    projectDeleted = true;
    await deleteDoc(ownerMembership.ref);
  } catch (error) {
    if (!projectDeleted) {
      try {
        await updateDoc(projectRef, { deletingAt: deleteField(), updatedAt: serverTimestamp() });
      } catch {
        // Сохраняем исходную ошибку удаления; повторная попытка доступна после перезагрузки.
      }
    }
    throw error;
  }
}

async function renderAccess(project) {
  loader();
  const shareCode = await ensureShareCode(project);
  const memberSnapshot = await getDocs(query(collection(db, "memberships"), where("projectId", "==", project.id)));
  const legacyCommenters = memberSnapshot.docs.filter((item) => item.data().role === "commenter");
  if (legacyCommenters.length) {
    const batch = writeBatch(db);
    legacyCommenters.forEach((item) => batch.update(item.ref, { role: "viewer" }));
    await batch.commit();
  }
  const members = memberSnapshot.docs.map((item) => ({
    id: item.id,
    ...item.data(),
    role: normalizeRole(item.data().role),
  }));
  app.innerHTML = `
    <section class="screen flow-screen">
      ${pageTopbar("К проекту")}
      <div class="flow-card card">
        <h1>Доступ</h1>
        <p class="subtitle">Все участники входят по одному коду и сначала получают роль читателя. После входа вы можете изменить роль каждого человека отдельно.</p>
        <div class="code-box"><span>Код проекта:</span><span class="code">${esc(shareCode)}</span><button class="button small" data-copy-code>Копировать</button></div>
        <h2>Участники</h2>
        <div class="member-list">
          ${members.map((member) => {
            const isOwner = member.role === "owner";
            const name = member.userName || (member.userId === user.uid ? user.displayName : "Участник");
            const email = member.userEmail || (member.userId === user.uid ? user.email : "");
            return `<div class="member-row">
              <div><strong>${esc(name || "Участник")}</strong>${email ? `<div class="member-email">${esc(email)}</div>` : ""}</div>
              <div class="member-actions">
                <label class="member-specialty-field"><span>Функция в проекте</span>
                  <input class="member-specialty" data-member-specialty="${esc(member.id)}" value="${esc(member.specialty || "")}" maxlength="100" placeholder="Дизайнер, художник…" aria-label="Функция участника ${esc(name || "Участник")}">
                </label>
                <select data-member-role="${esc(member.id)}" ${isOwner ? "disabled" : ""}>
                  ${(isOwner ? ["owner"] : ["viewer", "editor"]).map((role) => `<option value="${role}" ${member.role === role ? "selected" : ""}>${roleLabel(role)}</option>`).join("")}
                </select>
                ${isOwner ? "" : `<button class="button small danger" type="button" data-remove-member="${esc(member.id)}" data-member-name="${esc(name || "Участник")}">Удалить</button>`}
              </div>
            </div>`;
          }).join("")}
        </div>
        <div data-message></div>
      </div>
    </section>`;
  bindTopbar(() => renderNetworkSelection(project));
  document.querySelector("[data-copy-code]").onclick = async (event) => {
    await navigator.clipboard.writeText(shareCode);
    event.currentTarget.textContent = "Скопировано";
  };
  document.querySelectorAll("[data-member-role]").forEach((select) => {
    select.onchange = async () => {
      try {
        await updateDoc(doc(db, "memberships", select.dataset.memberRole), { role: select.value });
        showMessage("Роль участника обновлена.", "success");
      } catch (error) {
        showMessage(readError(error));
      }
    };
  });
  document.querySelectorAll("[data-member-specialty]").forEach((input) => {
    let savedSpecialty = input.value;
    input.onchange = async () => {
      const specialty = input.value.trim();
      input.disabled = true;
      try {
        await updateDoc(doc(db, "memberships", input.dataset.memberSpecialty), { specialty });
        input.value = specialty;
        savedSpecialty = specialty;
        showMessage("Функция участника обновлена.", "success");
      } catch (error) {
        input.value = savedSpecialty;
        showMessage(readError(error));
      } finally {
        input.disabled = false;
      }
    };
  });
  document.querySelectorAll("[data-remove-member]").forEach((button) => {
    button.onclick = async () => {
      const memberName = button.dataset.memberName;
      if (!confirm(`Удалить участника «${memberName}» из проекта?`)) return;
      button.disabled = true;
      try {
        await deleteDoc(doc(db, "memberships", button.dataset.removeMember));
        button.closest(".member-row")?.remove();
        showMessage("Участник удалён из проекта.", "success");
      } catch (error) {
        button.disabled = false;
        showMessage(readError(error));
      }
    };
  });
}

async function ensureShareCode(project) {
  let code = project.shareCode;
  if (!code) {
    code = await uniqueCode();
    await updateDoc(doc(db, "projects", project.id), { shareCode: code, updatedAt: serverTimestamp() });
    project.shareCode = code;
  }
  await setDoc(doc(db, "invitations", code), {
    projectId: project.id,
    role: "viewer",
    active: true,
    updatedAt: serverTimestamp(),
  }, { merge: true });
  return code;
}

/* ---------------- Контент-план ---------------- */

async function renderPlan(projectId, networkId) {
  loader("Открываю контент-план…");
  const membershipDoc = await getDoc(doc(db, "memberships", `${projectId}_${user.uid}`));
  if (!membershipDoc.exists()) {
    app.innerHTML = '<div class="loader"><div><h2>Нет доступа</h2><p>Вернитесь на главный экран и введите код проекта.</p></div></div>';
    return;
  }
  const [projectDoc, networkDoc] = await Promise.all([
    getDoc(doc(db, "projects", projectId)),
    getDoc(doc(db, "projects", projectId, "networks", networkId)),
  ]);
  if (!projectDoc.exists() || !networkDoc.exists()) {
    app.innerHTML = '<div class="loader"><div><h2>Контент-план не найден</h2></div></div>';
    return;
  }
  const project = { id: projectDoc.id, ...projectDoc.data(), role: normalizeRole(membershipDoc.data().role) };
  const network = { id: networkDoc.id, ...networkDoc.data() };
  const allRubrics = await getRubrics(projectId);
  const rubrics = allRubrics.filter((rubric) => rubricAppliesToNetwork(rubric, networkId));
  const postsSnapshot = await getDocs(collection(db, "projects", projectId, "posts"));
  const posts = postsSnapshot.docs
    .map((item) => ({ id: item.id, ...item.data() }))
    .filter((post) => post.networkId === networkId);

  drawPlan(project, network, rubrics, posts);
}

function drawPlan(project, network, rubrics, posts) {
  const baseStart = project.planStartDate || todayIso();
  const dates = monthDates(baseStart, planOffset);
  const columns = rubrics;
  const monthLabel = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(new Date(`${dates[0]}T12:00:00`));
  const gridMinWidth = Math.max(280, 100 + columns.length * 180);
  const postMap = new Map(posts.map((post) => [`${post.date}|${post.rubricId}`, post]));

  app.innerHTML = `
    <section class="plan-screen">
      <div class="page-topbar compact"><button class="back-button" data-close-tab>← Закрыть вкладку</button>${accountMarkup()}</div>
      <div class="plan-header">
        <div><h1>${esc(project.name)} — ${esc(network.name)}</h1><p class="subtitle">Нажмите на ячейку, чтобы создать или открыть публикацию.</p></div>
        <div class="plan-tools">
          ${canEdit(project.role) ? '<button class="button" data-edit-rubrics>Редактировать рубрики</button>' : ""}
          <button class="button ghost small" data-prev-dates>← Месяц</button>
          <span class="month-label">${esc(monthLabel)}</span>
          <button class="button ghost small" data-next-dates>Месяц →</button>
          <button class="button ghost small" data-zoom-out>−</button>
          <span class="zoom-value">${Math.round(planZoom * 100)}%</span>
          <button class="button ghost small" data-zoom-in>+</button>
        </div>
      </div>
      <div class="grid-scroll">
        <table class="content-grid" style="--cell-height:${Math.round(50 * planZoom)}px;--header-height:${Math.round(44 * planZoom)}px;--grid-font:${(0.92 * planZoom).toFixed(2)}rem;width:${Math.round(planZoom * 100)}%;min-width:${Math.round(gridMinWidth * planZoom)}px">
          <thead><tr><th class="date-column">Дата</th>${columns.map((rubric) => `<th>${rubric ? esc(rubric.name) : ""}</th>`).join("")}</tr></thead>
          <tbody>
            ${dates.map((date) => `<tr>
              <td class="date-column">${formatDate(date)}</td>
              ${columns.map((rubric) => {
                const post = postMap.get(`${date}|${rubric.id}`);
                const clickable = post || canEdit(project.role);
                return `<td class="post-cell real ${post ? `post-status-${statusClass(post.status)}` : ""}" ${clickable ? `data-post-cell data-date="${date}" data-rubric="${rubric.id}" data-post="${post?.id || ""}"` : ""}>
                  ${post ? `<span class="post-title">${esc(post.title)}</span><i class="post-status-dot" title="${esc(post.status || "Идея")}"></i>` : ""}
                </td>`;
              }).join("")}
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </section>`;

  bindAccountMenu();
  document.querySelector("[data-close-tab]").onclick = () => window.close();
  document.querySelector("[data-edit-rubrics]")?.addEventListener("click", () => {
    renderRubricSetup(project, { returnToPlan: { projectId: project.id, networkId: network.id } });
  });
  document.querySelector("[data-prev-dates]").onclick = () => { planOffset -= 1; renderPlan(project.id, network.id); };
  document.querySelector("[data-next-dates]").onclick = () => { planOffset += 1; renderPlan(project.id, network.id); };
  document.querySelector("[data-zoom-out]").onclick = () => { planZoom = Math.max(0.8, planZoom - 0.1); drawPlan(project, network, rubrics, posts); };
  document.querySelector("[data-zoom-in]").onclick = () => { planZoom = Math.min(1.4, planZoom + 0.1); drawPlan(project, network, rubrics, posts); };
  document.querySelectorAll("[data-post-cell]").forEach((cell) => {
    cell.onclick = () => {
      const post = posts.find((item) => item.id === cell.dataset.post) || null;
      const rubric = rubrics.find((item) => item.id === cell.dataset.rubric);
      openPostEditor({ project, network, rubric, date: cell.dataset.date, post });
    };
  });
}

function openImageViewer(url, label) {
  openModal(
    label,
    `<div class="image-viewer"><img src="${esc(url)}" alt="${esc(label)}"></div>`,
    "image-viewer-modal",
  );
}

async function openPostEditor({ project, network, rubric, date, post }) {
  const editable = canEdit(project.role);
  const commentable = canComment(project.role);
  const members = editable ? await getProjectMembers(project.id) : [];
  let comments = [];
  let postImages = [];
  if (post) {
    const [commentSnapshot, imageSnapshot] = await Promise.all([
      getDocs(query(collection(db, "projects", project.id, "comments"), where("postId", "==", post.id))),
      getDocs(query(collection(db, "projects", project.id, "postImages"), where("postId", "==", post.id))),
    ]);
    comments = commentSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    postImages = imageSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  }
  const disabled = editable ? "" : "disabled";
  const referenceImages = [
    ...postImages.filter((image) => image.kind === "reference").map((image) => ({ id: image.id, url: image.dataUrl })),
    ...normalizeImageList(post?.referenceImages, post?.reference).map((url) => ({ id: "", url })),
  ];
  const visualImages = [
    ...postImages.filter((image) => image.kind === "visual").map((image) => ({ id: image.id, url: image.dataUrl })),
    ...normalizeImageList(post?.visualImages, post?.visual).map((url) => ({ id: "", url })),
  ];
  let currentImageCount = referenceImages.length + visualImages.length;
  const postHasAssignee = post && Object.prototype.hasOwnProperty.call(post, "assigneeId");
  const networkAssigneeIsAvailable = editable
    ? members.some((member) => member.userId === network.assigneeId)
    : Boolean(network.assigneeId);
  const selectedAssigneeId = postHasAssignee ? post.assigneeId : (networkAssigneeIsAvailable ? network.assigneeId : "");
  const selectedAssigneeName = postHasAssignee ? post.assigneeName : (networkAssigneeIsAvailable ? network.assigneeName : "");
  const field = (label, name, value = "", tag = "textarea", extra = "") => `
    <label>${label}${tag === "input"
      ? `<input name="${name}" value="${esc(value)}" ${extra} ${disabled}>`
      : `<textarea name="${name}" ${disabled}>${esc(value)}</textarea>`}
    </label>`;
  const imageField = (label, name, images) => `
    <div class="image-field">
      <label>${label}<input type="file" name="${name}" accept="image/*" multiple ${disabled}></label>
      <div class="image-preview">
        ${images.map((image) => `<span class="image-preview-item">
          <button type="button" class="image-preview-button" data-view-image="${esc(image.url)}" aria-label="Открыть изображение: ${esc(label)}"><img src="${esc(image.url)}" alt="${esc(label)}"></button>
          ${editable && image.id ? `<button type="button" class="image-remove" data-delete-image="${image.id}" aria-label="Удалить изображение">×</button>` : ""}
        </span>`).join("") || '<span class="muted">Изображения не добавлены</span>'}
      </div>
    </div>`;

  const editorPostRef = post
    ? doc(db, "projects", project.id, "posts", post.id)
    : doc(collection(db, "projects", project.id, "posts"));

  const modal = openModal(
    post ? "Публикация" : "Новая публикация",
    `<form class="form" id="post-form">
      ${editable ? '<div class="post-form-toolbar"><span>Сохраните изменения перед закрытием</span><button class="button primary">Сохранить</button></div>' : ""}
      <div class="form-row post-meta-row">
        <label>Дата<input value="${formatDate(date)}" disabled></label>
        <label>Рубрика<input value="${esc(rubric.name)}" disabled></label>
        <label>Ответственный<select name="assigneeId" ${disabled}>${assigneeOptions(members, selectedAssigneeId, selectedAssigneeName)}</select></label>
      </div>
      <div class="post-editor-grid">
        <section class="editor-column">
          <h3>Задача и материалы</h3>
          ${field("Название поста", "title", post?.title, "input", "required maxlength=120")}
          ${field("Суть поста", "idea", post?.idea)}
          ${field("Польза для пользователя", "benefit", post?.benefit)}
          ${field("Формат", "format", post?.format)}
          ${imageField("Референсы и скрины", "referenceFiles", referenceImages)}
        </section>
        <section class="editor-column">
          <h3>Готовый материал</h3>
          ${field("Подводка / готовый текст", "caption", post?.caption)}
          ${imageField("Визуал", "visualFiles", visualImages)}
          <label>Статус<select name="status" ${disabled}>${POST_STATUSES.map((status) => `<option ${post?.status === status ? "selected" : ""}>${status}</option>`).join("")}</select></label>
        </section>
      </div>
      ${editable && post ? '<div class="flow-actions"><button type="button" class="button danger" data-delete-post>Удалить</button><span></span></div>' : ""}
      <div data-message></div>
    </form>
    <section class="comments">
      <h3>Комментарии</h3>
      <div>${comments.map((comment) => `<div class="comment"><small>${esc(comment.authorName || "Участник")}</small>${esc(comment.text)}</div>`).join("") || '<p class="muted">Комментариев пока нет.</p>'}</div>
      ${commentable && post ? '<form class="form" id="comment-form"><label>Новый комментарий<textarea name="text" required></textarea></label><button class="button small">Отправить</button></form>' : ""}
      ${commentable && !post ? '<p class="muted">Сначала сохраните публикацию — после этого можно будет оставить комментарий.</p>' : ""}
    </section>`,
  );

  const form = modal.querySelector("#post-form");
  modal.querySelectorAll("[data-view-image]").forEach((button) => {
    button.onclick = () => openImageViewer(button.dataset.viewImage, button.querySelector("img").alt);
  });
  if (editable) {
    modal.querySelectorAll("[data-delete-image]").forEach((button) => {
      button.onclick = async () => {
        button.disabled = true;
        try {
          await deleteDoc(doc(db, "projects", project.id, "postImages", button.dataset.deleteImage));
          postImages = postImages.filter((image) => image.id !== button.dataset.deleteImage);
          currentImageCount -= 1;
          button.closest(".image-preview-item").remove();
        } catch (error) {
          button.disabled = false;
          showMessage(readError(error), "error", modal);
        }
      };
    });
    form.onsubmit = async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const saveButton = form.querySelector(".post-form-toolbar .primary");
      saveButton.disabled = true;
      saveButton.textContent = "Сохраняю…";
      const referenceFiles = data.getAll("referenceFiles").filter((file) => file instanceof File && file.size);
      const visualFiles = data.getAll("visualFiles").filter((file) => file instanceof File && file.size);
      const assigneeId = data.get("assigneeId");
      const selectedMember = members.find((member) => member.userId === assigneeId);
      const payload = {
        networkId: network.id,
        networkName: network.name,
        rubricId: rubric.id,
        rubricName: rubric.name,
        date,
        title: data.get("title").trim(),
        idea: data.get("idea").trim(),
        benefit: data.get("benefit").trim(),
        format: data.get("format").trim(),
        caption: data.get("caption").trim(),
        status: data.get("status"),
        assigneeId,
        assigneeName: selectedMember
          ? memberDisplayName(selectedMember)
          : (assigneeId === selectedAssigneeId ? selectedAssigneeName || "" : ""),
        updatedAt: serverTimestamp(),
      };
      try {
        if (currentImageCount + referenceFiles.length + visualFiles.length > 4) {
          throw new Error("В одной публикации можно сохранить не более четырёх изображений.");
        }
        const [newReferences, newVisuals] = await Promise.all([
          Promise.all(referenceFiles.map(compressImage)),
          Promise.all(visualFiles.map(compressImage)),
        ]);
        const batch = writeBatch(db);
        if (post) batch.update(editorPostRef, payload);
        else batch.set(editorPostRef, { ...payload, createdAt: serverTimestamp(), authorId: user.uid });
        for (const [kind, images] of [["reference", newReferences], ["visual", newVisuals]]) {
          for (const dataUrl of images) {
            const imageRef = doc(collection(db, "projects", project.id, "postImages"));
            batch.set(imageRef, {
              postId: editorPostRef.id,
              kind,
              dataUrl,
              authorId: user.uid,
              createdAt: serverTimestamp(),
            });
          }
        }
        await batch.commit();
        modal.remove();
        renderPlan(project.id, network.id);
      } catch (error) {
        saveButton.disabled = false;
        saveButton.textContent = "Сохранить";
        showMessage(readError(error), "error", modal);
      }
    };
    modal.querySelector("[data-delete-post]")?.addEventListener("click", async () => {
      if (!confirm("Удалить эту публикацию?")) return;
      const batch = writeBatch(db);
      postImages.forEach((image) => batch.delete(doc(db, "projects", project.id, "postImages", image.id)));
      batch.delete(doc(db, "projects", project.id, "posts", post.id));
      await batch.commit();
      modal.remove();
      renderPlan(project.id, network.id);
    });
  }
  modal.querySelector("#comment-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = new FormData(event.currentTarget).get("text").trim();
    await addDoc(collection(db, "projects", project.id, "comments"), {
      postId: post.id,
      authorId: user.uid,
      authorName: user.displayName || "Участник",
      text,
      createdAt: serverTimestamp(),
    });
    modal.remove();
    openPostEditor({ project, network, rubric, date, post });
  });
}

function normalizeImageList(value, legacyValue = "") {
  const safeImageUrl = (item) => typeof item === "string" && /^(https:\/\/|data:image\/(?:webp|png|jpeg);base64,)/i.test(item);
  if (Array.isArray(value)) return value.filter(safeImageUrl);
  if (typeof legacyValue === "string" && /^https?:\/\//i.test(legacyValue.trim())) return [legacyValue.trim()];
  return [];
}

async function compressImage(file) {
  if (!file.type.startsWith("image/")) throw new Error(`Файл «${file.name}» не является изображением.`);
  if (file.size > 20 * 1024 * 1024) throw new Error(`Файл «${file.name}» больше 20 МБ.`);

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`Не удалось прочитать «${file.name}». Выберите JPG, PNG или WebP.`);
  }

  const maxDimension = 1400;
  const initialScale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  let width = Math.max(1, Math.round(bitmap.width * initialScale));
  let height = Math.max(1, Math.round(bitmap.height * initialScale));
  let quality = 0.8;
  let blob = null;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: true });

  for (let attempt = 0; attempt < 18; attempt += 1) {
    canvas.width = width;
    canvas.height = height;
    context.clearRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
    if (!blob) throw new Error(`Не удалось обработать «${file.name}».`);
    if (blob.size <= 90 * 1024) break;
    if (quality > 0.35) quality -= 0.1;
    else if (Math.max(width, height) > 480) {
      width = Math.max(1, Math.round(width * 0.8));
      height = Math.max(1, Math.round(height * 0.8));
      quality = 0.7;
    } else quality = Math.max(0.15, quality - 0.08);
  }
  bitmap.close?.();
  if (!blob || blob.size > 100 * 1024) throw new Error(`Не удалось достаточно уменьшить «${file.name}».`);
  return blobToDataUrl(blob);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Не удалось подготовить изображение к сохранению."));
    reader.readAsDataURL(blob);
  });
}

/* ---------------- Запуск ---------------- */

async function continueAuthenticatedSession() {
  const params = new URLSearchParams(window.location.search);
  const planProjectId = params.get("plan");
  const planNetworkId = params.get("network");
  if (planProjectId && planNetworkId) await renderPlan(planProjectId, planNetworkId);
  else {
    await loadProjects();
    renderDashboard();
  }
}

onAuthStateChanged(auth, async (nextUser) => {
  user = nextUser;
  if (!user) {
    renderAuth();
    return;
  }
  try {
    await continueAuthenticatedSession();
  } catch (error) {
    app.innerHTML = `<div class="loader"><div><h2>Не удалось открыть страницу</h2><p class="error">${esc(readError(error))}</p><button class="button" onclick="location.reload()">Обновить</button></div></div>`;
  }
});
