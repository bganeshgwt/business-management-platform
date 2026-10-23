import api from "../../../services/api";

// The tasks API, for either front door (backend modules/tasks):
//   restaurant  /tasks/…
//   business    /businesses/<id>/tasks/…
// tasksApi(base) gives every call bound to one of them.

const data = (request) => request.then((response) => response.data.data);

export const tasksBase = (businessId) => (businessId ? `/businesses/${businessId}/tasks` : "/tasks");

export function tasksApi(base) {
  const get = (path = "", params) => data(api.get(`${base}${path}`, { params }));
  const post = (path, body = {}) => data(api.post(`${base}${path}`, body));
  const put = (path, body = {}) => data(api.put(`${base}${path}`, body));
  const patch = (path, body = {}) => data(api.patch(`${base}${path}`, body));
  const del = (path) => data(api.delete(`${base}${path}`));
  return {
    base,
    context: () => get("/context"),
    // People are searched on the server, a page at a time.
    people: (params, signal) => data(api.get(`${base}/people`, { params, signal })),
    report: (params) => get("/reports", params),
    // Tasks
    mine: () => get("/my"),
    list: (params) => get("", params),
    calendar: (params) => get("/calendar", params),
    task: (id) => get(`/${id}`),
    createTask: (body) => post("", body),
    updateTask: (id, body) => patch(`/${id}`, body),
    startTask: (id) => post(`/${id}/start`),
    answer: (id, itemId, body) => put(`/${id}/items/${itemId}`, body),
    complete: (id, body) => post(`/${id}/complete`, body),
    review: (id, body) => post(`/${id}/review`, body),
    cancel: (id, body) => post(`/${id}/cancel`, body),
    reopen: (id, body) => post(`/${id}/reopen`, body),
    removeTask: (id) => del(`/${id}`),
    commentTask: (id, body) => post(`/${id}/comments`, { body }),
    // Files (a photo, a signature): FormData with "file", "kind", optional "itemId".
    uploadTaskFile: (id, form) => data(api.post(`${base}/${id}/files`, form)),
    uploadIssueFile: (id, form) => data(api.post(`${base}/issues/${id}/files`, form)),
    fileBlob: (fileId) => api.get(`${base}/files/${fileId}`, { responseType: "blob" }).then((r) => r.data),
    removeFile: (fileId) => del(`/files/${fileId}`),
    // Templates
    library: (params) => get("/library", params),
    libraryOne: (code) => get(`/library/${encodeURIComponent(code)}`),
    templates: (params) => get("/templates", params),
    template: (id) => get(`/templates/${id}`),
    createTemplate: (body) => post("/templates", body),
    updateTemplate: (id, body) => put(`/templates/${id}`, body),
    templateActive: (id, active) => patch(`/templates/${id}/active`, { active }),
    copyTemplate: (body) => post("/templates/copy", body),
    // Recurring
    schedules: (params) => get("/schedules", params),
    createSchedule: (body) => post("/schedules", body),
    updateSchedule: (id, body) => put(`/schedules/${id}`, body),
    scheduleActive: (id, active) => patch(`/schedules/${id}/active`, { active }),
    compliance: (id, params) => get(`/schedules/${id}/compliance`, params),
    // Issues
    issues: (params) => get("/issues", params),
    issue: (id) => get(`/issues/${id}`),
    createIssue: (body) => post("/issues", body),
    updateIssue: (id, body) => patch(`/issues/${id}`, body),
    issueStatus: (id, body) => post(`/issues/${id}/status`, body),
    convertIssue: (id, body) => post(`/issues/${id}/convert`, body),
    commentIssue: (id, body) => post(`/issues/${id}/comments`, { body }),
    removeIssue: (id) => del(`/issues/${id}`),
    issueFromLogbook: (entryId, body) => post(`/issues/from-logbook/${entryId}`, body),
    // Projects
    projects: (params) => get("/projects", params),
    projectTemplates: () => get("/project-templates"),
    project: (id) => get(`/projects/${id}`),
    createProject: (body) => post("/projects", body),
    updateProject: (id, body) => patch(`/projects/${id}`, body),
    projectMembers: (id, memberIds) => put(`/projects/${id}/members`, { memberIds }),
    addMilestone: (id, body) => post(`/projects/${id}/milestones`, body),
    updateMilestone: (id, milestoneId, body) => patch(`/projects/${id}/milestones/${milestoneId}`, body),
    removeMilestone: (id, milestoneId) => del(`/projects/${id}/milestones/${milestoneId}`),
    addList: (id, body) => post(`/projects/${id}/lists`, body),
    removeList: (id, listId) => del(`/projects/${id}/lists/${listId}`),
    commentProject: (id, body) => post(`/projects/${id}/comments`, { body }),
  };
}

// Restaurant log book: raise an entry as an issue (the restaurant door only).
export const raiseLogbookIssue = (entryId, body = {}) => tasksApi("/tasks").issueFromLogbook(entryId, body);
