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
const db = getFirestore(firebaseApp);
const app = document.querySelector("#app");

const ROLE_LABELS = {
  owner: "Владелец",
  editor: "Редактор",
  commenter: "Комментатор",
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

const roleLabel = (role) => ROLE_LABELS[role] || role;
const canEdit = (role) => ["owner", "editor"].includes(role);
const canComment = (role) => ["owner", "editor", "commenter"].includes(role);
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
    "auth/invalid-credential": "Неверный email или пароль.",
    "auth/weak-password": "Пароль должен содержать минимум 6 символов.",
    "permission-denied": "Нет доступа к этому действию.",
  })[error?.code] || error?.message || "Что-то пошло не так. Попробуйте ещё раз.";
}

function showMessage(message, type = "error", root = document) {
  const spot = root.querySelector("[data-message]");
  if (spot) spot.innerHTML = `<p class="${type}">${esc(message)}</p>`;
}

function loader(label = "Загружаю…") {
  app.innerHTML = `<div class="loader">${esc(label)}</div>`;
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

function renderAuth(mode = "welcome") {
  const welcome = `
    <p class="subtitle">Создавайте контент-планы для проектов и работайте в команде</p>
    <div class="auth-actions">
      <button class="button primary" data-auth-mode="login">Войти</button>
      <button class="button" data-auth-mode="register">Зарегистрироваться</button>
    </div>`;

  const isRegister = mode === "register";
  const form = `
    <p class="subtitle">${isRegister ? "Создайте аккаунт, чтобы хранить проекты и приглашать участников." : "Введите email и пароль, указанные при регистрации."}</p>
    <form class="form" id="auth-form">
      ${isRegister ? '<label>Имя<input name="name" required maxlength="60" autocomplete="name"></label>' : ""}
      <label>Email<input name="email" type="email" required autocomplete="email"></label>
      <label>Пароль<input name="password" type="password" required minlength="6" autocomplete="current-password"></label>
      <button class="button primary">${isRegister ? "Создать аккаунт" : "Войти"}</button>
      <button type="button" class="link-button" data-auth-back>Назад</button>
    </form>
    <div data-message></div>`;

  app.innerHTML = `<section class="screen auth-screen"><div class="card auth-card"><h1>Контент-план</h1>${mode === "welcome" ? welcome : form}</div></section>`;
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.onclick = () => renderAuth(button.dataset.authMode);
  });
  document.querySelector("[data-auth-back]")?.addEventListener("click", () => renderAuth());

  const authForm = document.querySelector("#auth-form");
  if (!authForm) return;
  authForm.onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(authForm);
    try {
      if (isRegister) {
        const credential = await createUserWithEmailAndPassword(auth, data.get("email"), data.get("password"));
        const name = data.get("name").trim();
        await updateProfile(credential.user, { displayName: name });
        await setDoc(doc(db, "profiles", credential.user.uid), {
          name,
          email: data.get("email"),
          createdAt: serverTimestamp(),
        });
      } else {
        await signInWithEmailAndPassword(auth, data.get("email"), data.get("password"));
      }
    } catch (error) {
      showMessage(readError(error));
    }
  };
}

/* ---------------- Данные и главный экран ---------------- */

async function loadProjects() {
  const membershipSnapshot = await getDocs(query(collection(db, "memberships"), where("userId", "==", user.uid)));
  const loaded = [];
  for (const membershipDoc of membershipSnapshot.docs) {
    const membership = membershipDoc.data();
    const projectDoc = await getDoc(doc(db, "projects", membership.projectId));
    if (projectDoc.exists()) loaded.push({ id: projectDoc.id, ...projectDoc.data(), role: membership.role });
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
          <div class="welcome-copy">
            <h1>Здравствуйте, ${esc(user.displayName || "друг")}!</h1>
            <p class="subtitle">С чего начнём?</p>
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
      const validRubrics = draft.rubrics
        .map((rubric) => ({ name: rubric.name.trim(), networkKeys: rubric.networkKeys }))
        .filter((rubric) => rubric.name);
      const submitButton = form.querySelector("[data-finish-create]");
      try {
        if (!draft.networks.length) throw new Error("Добавьте хотя бы одну соцсеть.");
        if (!validRubrics.length) throw new Error("Добавьте хотя бы одну рубрику.");
        if (validRubrics.some((rubric) => !rubric.networkKeys.length)) {
          throw new Error("Для каждой рубрики выберите хотя бы одну соцсеть.");
        }
        submitButton.disabled = true;
        submitButton.textContent = "Создаю…";
        const shareCode = await uniqueCode();
        const projectDoc = await addDoc(collection(db, "projects"), {
          ownerId: user.uid,
          name: draft.name,
          description: draft.description,
          shareCode,
          planStartDate: todayIso(),
          createdAt: serverTimestamp(),
        });
        await setDoc(doc(db, "memberships", `${projectDoc.id}_${user.uid}`), {
          projectId: projectDoc.id,
          userId: user.uid,
          role: "owner",
          userName: user.displayName || "Владелец",
          userEmail: user.email || "",
          joinedAt: serverTimestamp(),
        });
        await setDoc(doc(db, "invitations", shareCode), {
          projectId: projectDoc.id,
          role: "viewer",
          active: true,
          createdAt: serverTimestamp(),
        });
        const networkIds = new Map();
        for (const network of draft.networks) {
          const networkDoc = await addDoc(collection(db, "projects", projectDoc.id, "networks"), {
            name: network.name,
            createdAt: serverTimestamp(),
          });
          networkIds.set(network.key, networkDoc.id);
        }
        for (const rubric of validRubrics) {
          await addDoc(collection(db, "projects", projectDoc.id, "rubrics"), {
            name: rubric.name,
            networkIds: rubric.networkKeys.map((key) => networkIds.get(key)),
            createdAt: serverTimestamp(),
          });
        }
        await loadProjects();
        renderNetworkSelection(projectById(projectDoc.id));
      } catch (error) {
        submitButton.disabled = false;
        submitButton.textContent = "Создать проект";
        showMessage(readError(error), "error", form);
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
    ? existing.map((rubric) => ({ id: rubric.id, name: rubric.name, networkIds: [...(rubric.networkIds || [])] }))
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
      </div>`).join("");
    list.querySelectorAll("[data-remove-rubric]").forEach((button) => {
      button.onclick = () => {
        const index = Number(button.dataset.removeRubric);
        if (rows[index].id) removed.add(rows[index].id);
        rows.splice(index, 1);
        if (!rows.length) rows.push({ id: "", name: "", networkIds: [] });
        drawRows();
      };
    });
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
    syncRowsFromDom(rows);
    try {
      const validRows = rows.filter((row) => row.name.trim());
      if (!validRows.length) throw new Error("Добавьте хотя бы одну рубрику.");
      if (validRows.some((row) => !row.networkIds.length)) throw new Error("Для каждой рубрики выберите хотя бы одну соцсеть.");
      for (const id of removed) await deleteDoc(doc(db, "projects", project.id, "rubrics", id));
      for (const row of validRows) {
        const payload = { name: row.name.trim(), networkIds: row.networkIds, updatedAt: serverTimestamp() };
        if (row.id) await updateDoc(doc(db, "projects", project.id, "rubrics", row.id), payload);
        else await addDoc(collection(db, "projects", project.id, "rubrics"), { ...payload, createdAt: serverTimestamp() });
      }
      if (options.returnToPlan) renderPlan(options.returnToPlan.projectId, options.returnToPlan.networkId);
      else renderNetworkSelection(project);
    } catch (error) {
      showMessage(readError(error));
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
    ? existingRubrics.map((rubric) => ({ id: rubric.id, name: rubric.name, networkIds: [...(rubric.networkIds || [])] }))
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
    const name = new FormData(event.currentTarget).get("name").trim();
    await addDoc(collection(db, "projects", project.id, "networks"), { name, createdAt: serverTimestamp() });
    renderNetworkSettings(project);
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
    syncProjectRubrics();
    try {
      const validRows = rubricRows.filter((row) => row.name.trim());
      if (!validRows.length) throw new Error("Добавьте хотя бы одну рубрику.");
      if (validRows.some((row) => !row.networkIds.length)) throw new Error("Для каждой рубрики выберите хотя бы одну соцсеть.");
      for (const id of removedRubrics) await deleteDoc(doc(db, "projects", project.id, "rubrics", id));
      for (const row of validRows) {
        const payload = { name: row.name.trim(), networkIds: row.networkIds, updatedAt: serverTimestamp() };
        if (row.id) await updateDoc(doc(db, "projects", project.id, "rubrics", row.id), payload);
        else await addDoc(collection(db, "projects", project.id, "rubrics"), { ...payload, createdAt: serverTimestamp() });
      }
      showMessage("Рубрики сохранены.", "success", event.currentTarget);
    } catch (error) {
      showMessage(readError(error), "error", event.currentTarget);
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
  const members = memberSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
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
              <select data-member-role="${member.id}" ${isOwner ? "disabled" : ""}>
                ${(isOwner ? ["owner"] : ["viewer", "commenter", "editor"]).map((role) => `<option value="${role}" ${member.role === role ? "selected" : ""}>${roleLabel(role)}</option>`).join("")}
              </select>
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
  const project = { id: projectDoc.id, ...projectDoc.data(), role: membershipDoc.data().role };
  const network = { id: networkDoc.id, ...networkDoc.data() };
  const allRubrics = await getRubrics(projectId);
  const rubrics = allRubrics.filter((rubric) => (rubric.networkIds || []).includes(networkId));
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

onAuthStateChanged(auth, async (nextUser) => {
  user = nextUser;
  if (!user) {
    renderAuth();
    return;
  }
  try {
    const params = new URLSearchParams(window.location.search);
    const planProjectId = params.get("plan");
    const planNetworkId = params.get("network");
    if (planProjectId && planNetworkId) await renderPlan(planProjectId, planNetworkId);
    else {
      await loadProjects();
      renderDashboard();
    }
  } catch (error) {
    app.innerHTML = `<div class="loader"><div><h2>Не удалось открыть страницу</h2><p class="error">${esc(readError(error))}</p><button class="button" onclick="location.reload()">Обновить</button></div></div>`;
  }
});
