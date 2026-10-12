const tasks = require("../services/tasks.service");
const templates = require("../services/templates.service");
const recurrence = require("../services/recurrence.service");
const issues = require("../services/issues.service");
const projects = require("../services/projects.service");
const files = require("../services/files.service");
const reports = require("../services/reports.service");
const people = require("../services/people.service");
const { CATEGORIES } = require("../services/common");
const repo = require("../repositories/tasks.repository");

// Reads the request and answers; the services hold every rule. req.scope was
// built by the route (restaurant or business front door).

const send = (res, data, status = 200) => res.status(status).json({ success: true, data });
const body = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});

let categories = null;
const categoryList = async () => {
  if (!categories) categories = await repo.all(repo.pool, "SELECT code, name, icon FROM platform_task_categories ORDER BY sort_order");
  return categories;
};

module.exports = {
  // What the screens need first: who I am here, what I may do, the pickers.
  async context(req, res) {
    const s = req.scope;
    const [directory, cats] = await Promise.all([people.directory(s), categoryList()]);
    const codes = ["tasks.view", "tasks.create", "tasks.assign", "tasks.review", "tasks.manage", "issues.view", "issues.create", "issues.assign", "issues.review",
      "issues.manage", "projects.view", "projects.create", "projects.manage"];
    send(res, {
      world: s.world, businessId: s.businessId, businessType: s.businessType, businessName: s.businessName, timezone: s.timezone,
      userId: s.userId, userName: s.userName, outletScope: s.outletScope, categories: cats, CATEGORIES,
      modules: { tasks: s.has("tasks"), issues: s.has("issues"), projects: s.has("projects") },
      permissions: codes.filter((code) => s.can(code)),
      directory,
    });
  },
  // Round 2: the people pickers search here (paged) instead of loading everyone.
  people: async (req, res) => send(res, await people.search(req.scope, req.query)),
  summary: async (req, res) => send(res, await reports.summary(req.scope)),
  report: async (req, res) => send(res, await reports.report(req.scope, req.query)),

  // Tasks.
  mine: async (req, res) => send(res, await tasks.mine(req.scope, req.query)),
  list: async (req, res) => send(res, await tasks.list(req.scope, req.query)),
  calendar: async (req, res) => send(res, await tasks.calendar(req.scope, req.query)),
  detail: async (req, res) => send(res, await tasks.detail(req.scope, req.params.taskId)),
  create: async (req, res) => send(res, await tasks.create(req.scope, body(req)), 201),
  update: async (req, res) => send(res, await tasks.update(req.scope, req.params.taskId, body(req))),
  start: async (req, res) => send(res, await tasks.start(req.scope, req.params.taskId)),
  answer: async (req, res) => send(res, await tasks.answer(req.scope, req.params.taskId, req.params.itemId, body(req))),
  complete: async (req, res) => send(res, await tasks.complete(req.scope, req.params.taskId, body(req))),
  review: async (req, res) => send(res, await tasks.review(req.scope, req.params.taskId, body(req))),
  cancel: async (req, res) => send(res, await tasks.cancel(req.scope, req.params.taskId, body(req))),
  reopen: async (req, res) => send(res, await tasks.reopen(req.scope, req.params.taskId, body(req))),
  remove: async (req, res) => send(res, await tasks.remove(req.scope, req.params.taskId)),
  comment: async (req, res) => send(res, await tasks.comment(req.scope, req.params.taskId, body(req)), 201),

  // Files (task, checklist item or issue).
  addTaskFile: async (req, res) => send(res, await files.add(req.scope, { taskId: req.params.taskId }, req), 201),
  addIssueFile: async (req, res) => send(res, await files.add(req.scope, { issueId: req.params.issueId }, req), 201),
  async openFile(req, res) {
    const { file, full } = await files.open(req.scope, req.params.fileId);
    res.set("Cache-Control", "private, max-age=300");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.file_name)}`);
    res.type(file.mime_type);
    res.sendFile(full);
  },
  removeFile: async (req, res) => send(res, await files.remove(req.scope, req.params.fileId)),

  // Templates.
  library: async (req, res) => send(res, templates.libraryList(req.scope, req.query)),
  libraryOne: async (req, res) => send(res, templates.libraryOne(req.scope, req.params.code)),
  templates: async (req, res) => send(res, await templates.ownList(req.scope, req.query)),
  template: async (req, res) => send(res, await templates.ownOne(req.scope, req.params.templateId)),
  createTemplate: async (req, res) => send(res, await templates.create(req.scope, body(req)), 201),
  updateTemplate: async (req, res) => send(res, await templates.update(req.scope, req.params.templateId, body(req))),
  templateActive: async (req, res) => send(res, await templates.setActive(req.scope, req.params.templateId, body(req))),
  copyTemplate: async (req, res) => send(res, await templates.copy(req.scope, body(req)), 201),

  // Recurring.
  schedules: async (req, res) => send(res, await recurrence.list(req.scope, req.query)),
  schedule: async (req, res) => send(res, await recurrence.one(req.scope, req.params.scheduleId)),
  createSchedule: async (req, res) => send(res, await recurrence.save(req.scope, null, body(req)), 201),
  updateSchedule: async (req, res) => send(res, await recurrence.save(req.scope, req.params.scheduleId, body(req))),
  scheduleActive: async (req, res) => send(res, await recurrence.setActive(req.scope, req.params.scheduleId, body(req))),
  compliance: async (req, res) => send(res, await recurrence.compliance(req.scope, req.params.scheduleId, req.query)),

  // Issues.
  issues: async (req, res) => send(res, await issues.list(req.scope, req.query)),
  issue: async (req, res) => send(res, await issues.detail(req.scope, req.params.issueId)),
  createIssue: async (req, res) => send(res, await issues.create(req.scope, body(req)), 201),
  updateIssue: async (req, res) => send(res, await issues.update(req.scope, req.params.issueId, body(req))),
  issueStatus: async (req, res) => send(res, await issues.setStatus(req.scope, req.params.issueId, body(req))),
  convertIssue: async (req, res) => send(res, await issues.convert(req.scope, req.params.issueId, body(req)), 201),
  issueComment: async (req, res) => send(res, await issues.comment(req.scope, req.params.issueId, body(req)), 201),
  removeIssue: async (req, res) => send(res, await issues.remove(req.scope, req.params.issueId)),
  issueFromLogbook: async (req, res) => send(res, await issues.fromLogbook(req.scope, req.params.entryId, body(req)), 201),

  // Projects.
  projects: async (req, res) => send(res, await projects.list(req.scope, req.query)),
  projectTemplates: async (req, res) => send(res, projects.templatesList()),
  project: async (req, res) => send(res, await projects.detail(req.scope, req.params.projectId)),
  createProject: async (req, res) => send(res, await projects.create(req.scope, body(req)), 201),
  updateProject: async (req, res) => send(res, await projects.update(req.scope, req.params.projectId, body(req))),
  projectMembers: async (req, res) => send(res, await projects.setMembers(req.scope, req.params.projectId, body(req))),
  addMilestone: async (req, res) => send(res, await projects.saveMilestone(req.scope, req.params.projectId, null, body(req)), 201),
  updateMilestone: async (req, res) => send(res, await projects.saveMilestone(req.scope, req.params.projectId, req.params.milestoneId, body(req))),
  removeMilestone: async (req, res) => send(res, await projects.removeMilestone(req.scope, req.params.projectId, req.params.milestoneId)),
  addList: async (req, res) => send(res, await projects.saveList(req.scope, req.params.projectId, null, body(req)), 201),
  updateList: async (req, res) => send(res, await projects.saveList(req.scope, req.params.projectId, req.params.listId, body(req))),
  removeList: async (req, res) => send(res, await projects.removeList(req.scope, req.params.projectId, req.params.listId)),
  projectComment: async (req, res) => send(res, await projects.comment(req.scope, req.params.projectId, body(req)), 201),
};
