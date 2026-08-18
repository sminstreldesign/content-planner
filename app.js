import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  onAuthStateChanged,
  sendEmailVerification,
  checkActionCode,
  applyActionCode,
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
  writeBatch,
  query,
  where,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyD3X0A-r34omGmCmm2v1eXIm_bATY6G_Yw",
  authDomain: "content-planner-aef9e.firebaseapp.com",
  projectId: "content-planner-aef9e",
  messagingSenderId: "879380511083",
  appId: "1:879380511083:web:a1e8f9a5f0d5cdb372b42e",
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
auth.languageCode = "ru";
const db = getFirestore(firebaseApp);
const app = document.querySelector("#app");
const startupParams = new URLSearchParams(window.location.search);
const emailVerificationCode = startupParams.get("mode") === "verifyEmail" ? startupParams.get("oobCode") || "" : null;

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

function readError(error) {
  return ({
    "auth/email-already-in-use": "Этот email уже зарегистрирован. Войдите в аккаунт.",
    "auth/invalid-email": "Проверьте формат email.",
    "auth/invalid-credential": "Неверный email или пароль.",
    "auth/expired-action-code": "Срок действия ссылки истёк. Запросите новое письмо подтверждения.",
    "auth/invalid-action-code": "Ссылка подтверждения недействительна или уже была использована.",
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
        <div class="account-name"><strong>${esc(user?.displayName || "Аккаунт")}</strong><br><small>${esc(user?.email || "")}</small>${user?.emailVerified ? '<span class="verified-email">✓ Email подтверждён</span>' : ""}</div>
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

function verificationOlivesMarkup() {
  const olive = (variant) => `
    <svg class="verification-olive verification-olive-${variant}" viewBox="0 0 76 104" aria-hidden="true">
      <ellipse class="verification-olive-shadow" cx="38" cy="97" rx="20" ry="4" />
      <g class="verification-olive-character">
        <g class="verification-olive-leg verification-olive-leg-left"><path d="M30 78c-1 9-5 14-11 18" /><path d="M19 96h-7" /></g>
        <g class="verification-olive-leg verification-olive-leg-right"><path d="M46 78c1 9 5 14 11 18" /><path d="M57 96h7" /></g>
        <g class="verification-olive-arm verification-olive-arm-left"><path d="M21 42C11 38 8 32 7 25" /><path d="M7 25 2 30M7 25l5 3" /></g>
        <g class="verification-olive-arm verification-olive-arm-right"><path d="M55 42c10-4 13-10 14-17" /><path d="m69 25-5 5m5-5 5 3" /></g>
        <path class="verification-olive-body" d="M38 8c17 0 27 18 27 39 0 23-10 35-27 35S11 70 11 47C11 26 21 8 38 8Z" />
        <path class="verification-olive-shine" d="M22 25c4-8 9-12 15-14-6 10-9 19-10 28-6-3-8-8-5-14Z" />
        <ellipse class="verification-olive-opening" cx="38" cy="10" rx="10" ry="4" />
        <ellipse class="verification-olive-pimento" cx="38" cy="10" rx="6" ry="2.5" />
        <ellipse class="verification-olive-eye" cx="29" cy="45" rx="2.4" ry="3.3" />
        <ellipse class="verification-olive-eye" cx="47" cy="45" rx="2.4" ry="3.3" />
        <path class="verification-olive-mouth" d="M30 57q8 10 16 0" />
      </g>
    </svg>`;

  return `<div class="verification-olives" aria-hidden="true">${olive("one")}${olive("two")}${olive("three")}</div>`;
}

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

function renderEmailActionState(state, message = "") {
  const states = {
    loading: {
      eyebrow: "Проверяем ссылку",
      title: "Секундочку…",
      copy: "Убеждаемся, что ссылка подтверждения ещё действует.",
      action: '<span class="email-action-loader" aria-hidden="true"></span>',
    },
    ready: {
      eyebrow: "Один короткий шаг",
      title: "Подтвердите email",
      copy: "Нажмите кнопку — и адрес будет привязан к вашему аккаунту.",
      action: '<button class="button primary email-action-button" data-complete-verification>Подтвердить адрес</button>',
    },
    success: {
      eyebrow: "Готово!",
      title: "Email подтверждён",
      copy: "Теперь можно вернуться в Контент-план и продолжить работу.",
      action: `<a class="button primary email-action-button" href="./">${auth.currentUser ? "Перейти к проектам" : "Войти в аккаунт"}</a>`,
    },
    error: {
      eyebrow: "Не получилось",
      title: "Ссылка не сработала",
      copy: message,
      action: '<a class="button primary email-action-button" href="./">Вернуться в Контент-план</a>',
    },
  };
  const content = states[state];
  app.innerHTML = `
    <section class="screen auth-screen email-action-screen">
      <div class="card auth-card verification-card email-action-card">
        <p class="email-action-eyebrow">${content.eyebrow}</p>
        ${verificationOlivesMarkup()}
        <h1>${content.title}</h1>
        <p class="subtitle">${esc(content.copy)}</p>
        <div class="email-action-controls">${content.action}</div>
      </div>
    </section>`;
}

async function renderEmailVerificationAction(code) {
  renderEmailActionState("loading");
  if (!code) {
    renderEmailActionState("error", "В ссылке не хватает кода подтверждения. Запросите новое письмо.");
    return;
  }
  try {
    await checkActionCode(auth, code);
    renderEmailActionState("ready");
  } catch (error) {
    renderEmailActionState("error", readError(error));
    return;
  }

  document.querySelector("[data-complete-verification]").onclick = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.innerHTML = '<span class="button-spinner" aria-hidden="true"></span>Подтверждаем…';
    try {
      await applyActionCode(auth, code);
      if (auth.currentUser) {
        await auth.currentUser.reload();
        await auth.currentUser.getIdToken(true);
        user = auth.currentUser;
      }
      window.history.replaceState({}, document.title, window.location.pathname);
      renderEmailActionState("success");
    } catch (error) {
      renderEmailActionState("error", readError(error));
    }
  };
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
    const progress = beginFormProgress(authForm, isRegister ? "Создаю аккаунт…" : "Вхожу…", isRegister ? 3 : 1);
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
        await sendEmailVerification(credential.user);
        progress.advance("Письмо отправлено");
        renderEmailVerification({ sent: true });
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

function renderEmailVerification({ sent = false } = {}) {
  app.innerHTML = `
    <section class="screen auth-screen email-action-screen">
      <div class="card auth-card verification-card email-action-card">
        ${verificationOlivesMarkup()}
        <h2>Подтвердите email</h2>
        <p class="subtitle">Мы отправили письмо на <strong>${esc(user?.email || "указанный адрес")}</strong>. Перейдите по ссылке в письме, затем вернитесь сюда.</p>
        <div class="verification-steps">
          <span>1</span><p>Проверьте папки «Входящие» и «Спам».</p>
          <span>2</span><p>Нажмите ссылку подтверждения в письме.</p>
          <span>3</span><p>Вернитесь и нажмите кнопку ниже.</p>
        </div>
        <div class="auth-actions">
          <button class="button primary" data-check-verification>Я подтвердил(а) email</button>
          <button class="button ghost" data-resend-verification>Отправить письмо ещё раз</button>
          <button class="link-button" data-verification-signout>Выйти из аккаунта</button>
        </div>
        <div data-message>${sent ? '<p class="success">Письмо отправлено. Оно может прийти в течение нескольких минут.</p>' : ""}</div>
      </div>
    </section>`;

  document.querySelector("[data-check-verification]").onclick = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.innerHTML = '<span class="button-spinner" aria-hidden="true"></span>Проверяю…';
    try {
      await auth.currentUser.reload();
      await auth.currentUser.getIdToken(true);
      user = auth.currentUser;
      if (!user.emailVerified) throw new Error("Email пока не подтверждён. Откройте ссылку из письма и повторите проверку.");
      loader("Открываю проекты…");
      await continueAuthenticatedSession();
    } catch (error) {
      showMessage(readError(error));
      button.disabled = false;
      button.textContent = "Я подтвердил(а) email";
    }
  };

  document.querySelector("[data-resend-verification]").onclick = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.innerHTML = '<span class="button-spinner" aria-hidden="true"></span>Отправляю…';
    try {
      await sendEmailVerification(auth.currentUser);
      showMessage("Новое письмо отправлено. Проверьте также папку «Спам».", "success");
    } catch (error) {
      showMessage(readError(error));
    } finally {
      button.disabled = false;
      button.textContent = "Отправить письмо ещё раз";
    }
  };
  document.querySelector("[data-verification-signout]").onclick = () => signOut(auth);
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
    button.onclick = () => renderNetworkSelection(projectById(button.dataset.openProject));
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
      renderNetworkSelection(projectById(invitation.projectId));
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
        await renderNetworkSelection(projectById(projectDoc.id));
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

async function getNetworks(projectId) {
  const snapshot = await getDocs(collection(db, "projects", projectId, "networks"));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

async function getRubrics(projectId) {
  const snapshot = await getDocs(collection(db, "projects", projectId, "rubrics"));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => a.name.localeCompare(b.name, "ru"));
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
  const networks = await getNetworks(project.id);
  app.innerHTML = `
    <section class="screen flow-screen">
      ${pageTopbar("Все проекты")}
      <div class="network-select-header">
        <div><h1>${esc(project.name)}</h1><p class="subtitle">Выберите соцсеть, чтобы открыть её контент-план.</p></div>
        ${project.role === "owner" ? '<div class="plan-tools"><button class="button ghost" data-network-settings>Соцсети</button><button class="button" data-access>Доступ</button></div>' : ""}
      </div>
      <div class="network-grid">
        ${networks.map((network) => `<button class="network-card" data-open-plan="${network.id}"><strong>${esc(network.name)}</strong><span>Открыть контент-план в новой вкладке →</span></button>`).join("") || '<div class="card flow-card"><p>В проекте пока нет соцсетей.</p></div>'}
      </div>
    </section>`;
  bindTopbar(renderDashboard);
  document.querySelector("[data-network-settings]")?.addEventListener("click", () => renderNetworkSettings(project));
  document.querySelector("[data-access]")?.addEventListener("click", () => renderAccess(project));
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
  const snapshots = [];
  for (const subcollection of ["networks", "rubrics", "posts", "postImages", "comments"]) {
    try {
      snapshots.push(await getDocs(collection(db, "projects", project.id, subcollection)));
    } catch (error) {
      if (subcollection === "postImages" && error?.code === "permission-denied") {
        throw new Error("Firestore не разрешил удалить изображения. Опубликуйте актуальный файл firestore.rules в Firebase и повторите удаление.");
      }
      throw error;
    }
  }
  for (const snapshot of snapshots) {
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
  await deleteDoc(doc(db, "projects", project.id));
  await deleteDoc(ownerMembership.ref);
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
      <div class="form-row">
        <label>Дата<input value="${formatDate(date)}" disabled></label>
        <label>Рубрика<input value="${esc(rubric.name)}" disabled></label>
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
  if (emailVerificationCode !== null) return;
  if (!user) {
    renderAuth();
    return;
  }
  if (!user.emailVerified) {
    renderEmailVerification();
    return;
  }
  try {
    await continueAuthenticatedSession();
  } catch (error) {
    app.innerHTML = `<div class="loader"><div><h2>Не удалось открыть страницу</h2><p class="error">${esc(readError(error))}</p><button class="button" onclick="location.reload()">Обновить</button></div></div>`;
  }
});

if (emailVerificationCode !== null) renderEmailVerificationAction(emailVerificationCode);
