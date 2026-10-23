const express = require("express");
const authenticate = require("../../../middlewares/authenticate");
const authorize = require("../../../middlewares/authorize");
const AppError = require("../../../utils/AppError");
const c = require("../controllers/tasks.controller");
const files = require("../services/files.service");
const { restaurantScope, businessScope } = require("../services/scope");

// Tasks, issues & projects: one API, two front doors (see services/scope.js).
//
//   /api/tasks/…                          the signed-in restaurant
//   /api/businesses/:businessId/tasks/…   any business the caller is a member of
//
// Mounted in routes/index.js BEFORE the /businesses router, so photo uploads
// (multipart) reach multer here rather than that router's JSON-only check.
//
// Every route needs the module switched on (tasks; issues and projects for
// theirs). Permissions are checked in the services, against the record:
// tasks.view / create / assign / review / manage, issues.*, projects.*.
// Doing your own task needs no permission beyond the module.
["tasks.view", "tasks.create", "tasks.assign", "tasks.review", "tasks.manage", "issues.view", "issues.create", "issues.assign", "issues.review",
  "issues.manage", "projects.view", "projects.create", "projects.manage"].forEach((code) => authorize.noteEnforced(code));

function build(scopeFor) {
  const r = express.Router({ mergeParams: true });
  r.use(authenticate);
  r.use((req, res, next) => {
    if (["POST", "PATCH", "PUT"].includes(req.method) && !req.is("multipart/form-data") && (!req.body || typeof req.body !== "object" || Array.isArray(req.body))) {
      return next(new AppError(400, "A JSON object is required"));
    }
    next();
  });
  const T = scopeFor("tasks");
  const I = scopeFor("issues");
  const P = scopeFor("projects");

  r.get("/context", T, c.context);
  r.get("/people", T, c.people);
  r.get("/reports", T, c.report);

  // Templates and the built-in library.
  r.get("/library", T, c.library);
  r.get("/library/:code", T, c.libraryOne);
  r.get("/templates", T, c.templates);
  r.post("/templates", T, c.createTemplate);
  r.post("/templates/copy", T, c.copyTemplate);
  r.get("/templates/:templateId", T, c.template);
  r.put("/templates/:templateId", T, c.updateTemplate);
  r.patch("/templates/:templateId/active", T, c.templateActive);

  // Recurring tasks.
  r.get("/schedules", T, c.schedules);
  r.post("/schedules", T, c.createSchedule);
  r.put("/schedules/:scheduleId", T, c.updateSchedule);
  r.patch("/schedules/:scheduleId/active", T, c.scheduleActive);
  r.get("/schedules/:scheduleId/compliance", T, c.compliance);

  // Issues.
  r.get("/issues", I, c.issues);
  r.post("/issues", I, c.createIssue);
  r.post("/issues/from-logbook/:entryId", I, c.issueFromLogbook);
  r.get("/issues/:issueId", I, c.issue);
  r.patch("/issues/:issueId", I, c.updateIssue);
  r.post("/issues/:issueId/status", I, c.issueStatus);
  r.post("/issues/:issueId/convert", I, c.convertIssue);
  r.post("/issues/:issueId/comments", I, c.issueComment);
  r.post("/issues/:issueId/files", I, files.uploadOne, c.addIssueFile);
  r.delete("/issues/:issueId", I, c.removeIssue);

  // Projects.
  r.get("/projects", P, c.projects);
  r.get("/project-templates", P, c.projectTemplates);
  r.post("/projects", P, c.createProject);
  r.get("/projects/:projectId", P, c.project);
  r.patch("/projects/:projectId", P, c.updateProject);
  r.put("/projects/:projectId/members", P, c.projectMembers);
  r.post("/projects/:projectId/milestones", P, c.addMilestone);
  r.patch("/projects/:projectId/milestones/:milestoneId", P, c.updateMilestone);
  r.delete("/projects/:projectId/milestones/:milestoneId", P, c.removeMilestone);
  r.post("/projects/:projectId/lists", P, c.addList);
  r.delete("/projects/:projectId/lists/:listId", P, c.removeList);
  r.post("/projects/:projectId/comments", P, c.projectComment);

  // Files (photos, signatures) of tasks and issues.
  r.get("/files/:fileId", T, c.openFile);
  r.delete("/files/:fileId", T, c.removeFile);

  // Tasks.
  r.get("/my", T, c.mine);
  r.get("/calendar", T, c.calendar);
  r.get("/", T, c.list);
  r.post("/", T, c.create);
  r.get("/:taskId", T, c.detail);
  r.patch("/:taskId", T, c.update);
  r.delete("/:taskId", T, c.remove);
  r.post("/:taskId/start", T, c.start);
  r.put("/:taskId/items/:itemId", T, c.answer);
  r.post("/:taskId/complete", T, c.complete);
  r.post("/:taskId/review", T, c.review);
  r.post("/:taskId/cancel", T, c.cancel);
  r.post("/:taskId/reopen", T, c.reopen);
  r.post("/:taskId/comments", T, c.comment);
  r.post("/:taskId/files", T, files.uploadOne, c.addTaskFile);

  // Database rules are the person's conflict, not a server fault.
  r.use((error, req, res, next) => {
    if (error.code === "23505") return next(new AppError(409, "This already exists"));
    if (error.code === "23503") return next(new AppError(400, "A related record is not available in this business"));
    if (error.code === "23514" && !error.constraint) return next(new AppError(409, error.message));
    if (error.code === "23514") return next(new AppError(400, "A value is outside what is allowed"));
    next(error);
  });
  return r;
}

const router = express.Router();
router.use("/tasks", build(restaurantScope));
router.use("/businesses/:businessId/tasks", build(businessScope));

module.exports = router;
