import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import { ScreenLoading, ErrorMessage } from "../../../components/Feedback";
import PageHeader from "../../../components/PageHeader";
import { TasksProvider } from "./TasksScope";
import useTasks from "./useTasks";
import { NotAllowed, TasksNav } from "./parts";
import "../styles/tasks.css";

const MyTasksPage = lazy(() => import("./MyTasksPage"));
const TaskRunPage = lazy(() => import("./TaskRunPage"));
const BoardPage = lazy(() => import("./BoardPage"));
const CalendarPage = lazy(() => import("./CalendarPage"));
const IssuesPage = lazy(() => import("./IssuesPage"));
const IssueDetailPage = lazy(() => import("./IssueDetailPage"));
const ProjectsPage = lazy(() => import("./ProjectsPage"));
const ProjectDetailPage = lazy(() => import("./ProjectDetailPage"));
const TemplatesPage = lazy(() => import("./TemplatesPage"));
const RecurringPage = lazy(() => import("./RecurringPage"));
const TaskReportsPage = lazy(() => import("./TaskReportsPage"));

// Tasks, issues & projects: /tasks/… in a restaurant, /business-admin/<id>/tasks/…
// in any other business. The same screens; TasksProvider says which.
export default function TasksRoutes() {
  return (
    <TasksProvider>
      <TasksShell />
    </TasksProvider>
  );
}

function Gate({ need, module, what, children }) {
  const { can, has } = useTasks();
  if (module && !has(module)) return <NotAllowed what={what} />;
  if (need && !(Array.isArray(need) ? need.some(can) : can(need))) return <NotAllowed what={what} />;
  return children;
}

function TasksShell() {
  const { ready, error } = useTasks();
  if (error) {
    return (
      <div className="stack">
        <PageHeader title="Tasks" icon="check" />
        <ErrorMessage message={error} />
      </div>
    );
  }
  if (!ready) return <ScreenLoading label="Opening tasks…" />;
  return (
    <div className="tk-shell">
      <TasksNav />
      <Suspense fallback={<ScreenLoading />}>
        <Routes>
          <Route index element={<MyTasksPage />} />
          <Route path="run/:taskId" element={<TaskRunPage />} />
          <Route path="board" element={<Gate need="tasks.view" what="The team board"><BoardPage /></Gate>} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="issues" element={<Gate module="issues" what="Issues"><IssuesPage /></Gate>} />
          <Route path="issues/:issueId" element={<Gate module="issues" what="Issues"><IssueDetailPage /></Gate>} />
          <Route path="projects" element={<Gate module="projects" what="Projects"><ProjectsPage /></Gate>} />
          <Route path="projects/:projectId" element={<Gate module="projects" what="Projects"><ProjectDetailPage /></Gate>} />
          <Route path="templates" element={<Gate need={["tasks.create", "tasks.manage"]} what="The template library"><TemplatesPage /></Gate>} />
          <Route path="recurring" element={<Gate need="tasks.view" what="Recurring tasks"><RecurringPage /></Gate>} />
          <Route path="reports" element={<Gate need="tasks.view" what="Task reports"><TaskReportsPage /></Gate>} />
          <Route path="*" element={<NotAllowed what="This page" />} />
        </Routes>
      </Suspense>
    </div>
  );
}
