const crypto = require("node:crypto");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onDocumentWrittenWithAuthContext } = require("firebase-functions/v2/firestore");

initializeApp();
setGlobalOptions({ region: "europe-west1", maxInstances: 3 });

const db = getFirestore();

const ROLE_LABELS = {
  owner: "владелец",
  editor: "редактор",
  viewer: "читатель",
  commenter: "читатель",
};

const ENTITY_SPECS = {
  network: {
    label: "площадка",
    gender: "f",
    name: (data) => data.name || "Без названия",
    fields: ["name", "assigneeId", "assigneeName"],
    fieldLabels: { name: "название", assigneeId: "ответственный", assigneeName: "ответственный" },
  },
  rubric: {
    label: "рубрика",
    gender: "f",
    name: (data) => data.name || "Без названия",
    fields: ["name", "networkIds"],
    fieldLabels: { name: "название", networkIds: "площадки" },
  },
  post: {
    label: "публикация",
    gender: "f",
    name: (data) => data.title || `${data.rubricName || "Публикация"} · ${data.date || "без даты"}`,
    fields: ["networkId", "rubricId", "date", "title", "idea", "benefit", "format", "caption", "status", "assigneeId", "assigneeName"],
    fieldLabels: {
      networkId: "площадка",
      rubricId: "рубрика",
      date: "дата",
      title: "название",
      idea: "идея",
      benefit: "польза",
      format: "формат",
      caption: "готовый текст",
      status: "статус",
      assigneeId: "исполнитель",
      assigneeName: "исполнитель",
    },
  },
  image: {
    label: "изображение",
    gender: "n",
    name: (data) => data.kind === "visual" ? "Визуал" : "Референс",
    fields: ["kind", "postId"],
    fieldLabels: { kind: "тип", postId: "публикация" },
  },
  reference: {
    label: "референс",
    gender: "m",
    name: (data) => data.note || data.networkName || "Референс",
    fields: ["networkId", "networkName", "note", "media"],
    fieldLabels: { networkId: "площадка", networkName: "площадка", note: "что понравилось", media: "медиафайлы" },
  },
  comment: {
    label: "комментарий",
    gender: "m",
    name: () => "Комментарий",
    fields: ["postId", "text"],
    fieldLabels: { postId: "публикация", text: "текст" },
  },
  competitorAnalysis: {
    label: "анализ конкурентов",
    gender: "m",
    name: () => "Сравнение компаний",
    fields: ["companies", "criteria"],
    fieldLabels: { companies: "компании", criteria: "критерии и оценки" },
  },
  audienceAnalysis: {
    label: "анализ аудитории",
    gender: "m",
    name: () => "Сегменты целевой аудитории",
    fields: ["segments", "criteria"],
    fieldLabels: { segments: "сегменты", criteria: "критерии и портреты" },
  },
  projectDocument: {
    label: "документ проекта",
    gender: "m",
    name: (data) => data.kind === "audit" ? "Аудит" : "Блокнот",
    fields: ["chapters"],
    fieldLabels: { chapters: "главы и текст" },
  },
  member: {
    label: "участник",
    gender: "m",
    name: (data) => data.userName || data.userEmail || "Участник",
    fields: ["role", "specialty", "userName", "userEmail"],
    fieldLabels: { role: "роль", specialty: "функция", userName: "имя", userEmail: "email" },
  },
};

function actionFromChange(change) {
  if (!change.before.exists) return "create";
  if (!change.after.exists) return "delete";
  return "update";
}

function comparable(value) {
  if (Array.isArray(value)) return [...value].sort();
  return value ?? null;
}

function changedFields(before, after, fields) {
  return fields.filter((field) => JSON.stringify(comparable(before[field])) !== JSON.stringify(comparable(after[field])));
}

function uniqueLabels(fields, labels) {
  return [...new Set(fields.map((field) => labels[field] || field))];
}

function quoted(value, fallback = "не указано") {
  const text = String(value || fallback).trim();
  return `«${text.slice(0, 120)}»`;
}

function creationWord(gender) {
  return gender === "f" ? "Создана" : gender === "n" ? "Создано" : "Создан";
}

function updateWord(gender) {
  return gender === "f" ? "Изменена" : gender === "n" ? "Изменено" : "Изменён";
}

function deletionWord(gender) {
  return gender === "f" ? "Удалена" : gender === "n" ? "Удалено" : "Удалён";
}

function transition(before, after, field, transform = (value) => value) {
  return `${quoted(transform(before[field]))} → ${quoted(transform(after[field]))}`;
}

function summarize(spec, action, before, after, fields) {
  const data = action === "delete" ? before : after;
  const name = quoted(spec.name(data));
  if (action === "create") return `${creationWord(spec.gender)} ${spec.label} ${name}.`;
  if (action === "delete") return `${deletionWord(spec.gender)} ${spec.label} ${name}.`;

  const details = [];
  if (fields.includes("status")) details.push(`статус ${transition(before, after, "status")}`);
  if (fields.includes("assigneeId") || fields.includes("assigneeName")) {
    details.push(`ответственный ${transition(before, after, "assigneeName", (value) => value || "не назначен")}`);
  }
  if (fields.includes("role")) {
    details.push(`роль ${transition(before, after, "role", (value) => ROLE_LABELS[value] || value)}`);
  }
  const detailedFields = new Set(["status", "assigneeId", "assigneeName", "role"]);
  const remaining = uniqueLabels(fields.filter((field) => !detailedFields.has(field)), spec.fieldLabels);
  if (remaining.length) details.push(`поля: ${remaining.join(", ")}`);
  return `${updateWord(spec.gender)} ${spec.label} ${name}${details.length ? ` — ${details.join("; ")}` : ""}.`;
}

async function actorFor(event, data) {
  if (event.authType !== "user" || !event.authId) {
    return { actorId: "", actorName: "Система" };
  }
  const profile = await db.collection("profiles").doc(event.authId).get();
  return {
    actorId: event.authId,
    actorName: profile.data()?.name || data.authorName || data.userName || "Участник",
  };
}

async function projectAcceptsActivity(projectId) {
  const project = await db.collection("projects").doc(projectId).get();
  return project.exists && !project.data().deletingAt;
}

async function writeActivity(projectId, event, activity) {
  const actor = await actorFor(event, activity.sourceData);
  const eventKey = crypto.createHash("sha256").update(String(event.id)).digest("hex");
  const eventDate = new Date(event.time);
  await db.collection("projects").doc(projectId).collection("activity").doc(eventKey).set({
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: activity.action,
    entityType: activity.entityType,
    entityId: activity.entityId,
    entityName: activity.entityName,
    summary: activity.summary,
    changedFields: activity.changedFields,
    createdAt: Timestamp.fromDate(Number.isNaN(eventDate.getTime()) ? new Date() : eventDate),
  });
}

async function auditEntity(event, entityType, entityId, projectId = event.params.projectId) {
  if (!event.data) return;
  if (!(await projectAcceptsActivity(projectId))) return;
  const action = actionFromChange(event.data);
  const before = event.data.before.data() || {};
  const after = event.data.after.data() || {};
  const spec = ENTITY_SPECS[entityType];
  const fields = action === "update" ? changedFields(before, after, spec.fields) : [];
  if (action === "update" && !fields.length) return;
  const sourceData = action === "delete" ? before : after;
  await writeActivity(projectId, event, {
    action,
    entityType,
    entityId,
    entityName: spec.name(sourceData),
    summary: summarize(spec, action, before, after, fields),
    changedFields: fields,
    sourceData,
  });
}

async function auditProject(event) {
  if (!event.data) return;
  const action = actionFromChange(event.data);
  if (action === "delete") return;
  const before = event.data.before.data() || {};
  const after = event.data.after.data() || {};
  if (after.deletingAt) return;
  const fields = action === "update"
    ? changedFields(before, after, ["name", "description", "shareCode", "planStartDate"])
    : [];
  if (action === "update" && !fields.length) return;
  const spec = {
    label: "проект",
    gender: "m",
    name: (data) => data.name || "Без названия",
    fieldLabels: { name: "название", description: "описание", shareCode: "код приглашения", planStartDate: "дата начала плана" },
  };
  await writeActivity(event.params.projectId, event, {
    action,
    entityType: "project",
    entityId: event.params.projectId,
    entityName: spec.name(after),
    summary: summarize(spec, action, before, after, fields),
    changedFields: fields,
    sourceData: after,
  });
}

exports.auditProject = onDocumentWrittenWithAuthContext("projects/{projectId}", auditProject);
exports.auditNetwork = onDocumentWrittenWithAuthContext("projects/{projectId}/networks/{entityId}", (event) => auditEntity(event, "network", event.params.entityId));
exports.auditRubric = onDocumentWrittenWithAuthContext("projects/{projectId}/rubrics/{entityId}", (event) => auditEntity(event, "rubric", event.params.entityId));
exports.auditPost = onDocumentWrittenWithAuthContext("projects/{projectId}/posts/{entityId}", (event) => auditEntity(event, "post", event.params.entityId));
exports.auditImage = onDocumentWrittenWithAuthContext("projects/{projectId}/postImages/{entityId}", (event) => auditEntity(event, "image", event.params.entityId));
exports.auditReference = onDocumentWrittenWithAuthContext("projects/{projectId}/references/{entityId}", (event) => auditEntity(event, "reference", event.params.entityId));
exports.auditComment = onDocumentWrittenWithAuthContext("projects/{projectId}/comments/{entityId}", (event) => auditEntity(event, "comment", event.params.entityId));
exports.auditCompetitorAnalysis = onDocumentWrittenWithAuthContext("projects/{projectId}/competitorAnalyses/{entityId}", (event) => auditEntity(event, "competitorAnalysis", event.params.entityId));
exports.auditAudienceAnalysis = onDocumentWrittenWithAuthContext("projects/{projectId}/audienceAnalyses/{entityId}", (event) => auditEntity(event, "audienceAnalysis", event.params.entityId));
exports.auditProjectDocument = onDocumentWrittenWithAuthContext("projects/{projectId}/projectDocuments/{entityId}", (event) => auditEntity(event, "projectDocument", event.params.entityId));
exports.auditMembership = onDocumentWrittenWithAuthContext("memberships/{entityId}", async (event) => {
  if (!event.data) return;
  const sourceData = event.data.after.data() || event.data.before.data() || {};
  if (!sourceData.projectId) return;
  await auditEntity(event, "member", sourceData.userId || event.params.entityId, sourceData.projectId);
});
