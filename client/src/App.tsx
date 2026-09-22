import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Redirect, Route, Switch } from "wouter";
import { LoaderCircle } from "lucide-react";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { LoadingQueueProvider } from "./contexts/LoadingQueueContext";
import DashboardLayout from "./components/DashboardLayout";
import { ProtectedRoute } from "./components/ProtectedRoute";

const NotFound = lazy(() => import("./pages/NotFound"));
const Home = lazy(() => import("./pages/Home"));
const APTLSSManagement = lazy(() => import("./pages/APTLSSManagement"));
const Settings = lazy(() => import("./pages/Settings"));
const Calendar = lazy(() => import("./pages/Calendar"));
const FounderDashboard = lazy(() => import("./pages/FounderDashboard"));
const AdvancedScheduling = lazy(() => import("./pages/AdvancedScheduling"));
const ATISPhasesAnalysisDashboard = lazy(() => import("./pages/ATISPhasesAnalysisDashboard"));
const RobertDashboard = lazy(() => import("./pages/manus/RobertDashboard"));
const PriorityCommandCenter = lazy(() => import("./pages/manus/PriorityCommandCenter"));
const AdminMonitor = lazy(() => import("./pages/manus/AdminMonitor"));
const WorkerOperator = lazy(() => import("./pages/worker/WorkerOperator"));
const WorkerInvitationAcceptance = lazy(() => import("./pages/worker/WorkerInvitationAcceptance"));

function RouteLoading() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center" role="status" aria-label="Loading page">
      <LoaderCircle className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
    </div>
  );
}


function ProtectedRoutes() {
  return (
    <DashboardLayout>
      <Switch>
        <Route path={"/"} component={() => <ProtectedRoute component={Home} allowedRoles={["admin"]} />} />
        <Route path={"/aptlss"} component={() => <ProtectedRoute component={APTLSSManagement} allowedRoles={["admin"]} />} />
        <Route path={"/settings"} component={() => <ProtectedRoute component={Settings} allowedRoles={["admin"]} />} />
        <Route path={"/calendar"} component={() => <ProtectedRoute component={Calendar} allowedRoles={["admin"]} />} />
        <Route path={"/advanced-scheduling"} component={() => <ProtectedRoute component={AdvancedScheduling} allowedRoles={["admin"]} />} />
        <Route path={"/atis-phases"} component={() => <ProtectedRoute component={ATISPhasesAnalysisDashboard} allowedRoles={["admin"]} />} />

        <Route path={"/founder"} component={() => <ProtectedRoute component={FounderDashboard} allowedRoles={["admin"]} />} />
        <Route path={"/robert"} component={() => <ProtectedRoute component={RobertDashboard} allowedRoles={["admin"]} />} />
        <Route path={"/command-center"} component={() => <ProtectedRoute component={PriorityCommandCenter} allowedRoles={["admin"]} />} />
        <Route path={"/admin"} component={() => <ProtectedRoute component={AdminMonitor} allowedRoles={["admin"]} />} />
        <Route path={"/worker/operations"} component={() => <Redirect to="/worker" replace />} />
        <Route path={"/worker/plan"} component={() => <ProtectedRoute component={() => <WorkerOperator view="plan" />} allowedRoles={["worker"]} />} />
        <Route path={"/worker/decisions"} component={() => <ProtectedRoute component={() => <WorkerOperator view="decisions" />} allowedRoles={["worker"]} />} />
        <Route path={"/worker/evidence"} component={() => <ProtectedRoute component={() => <WorkerOperator view="evidence" />} allowedRoles={["worker"]} />} />
        <Route path={"/worker/reminders"} component={() => <ProtectedRoute component={() => <WorkerOperator view="reminders" />} allowedRoles={["worker"]} />} />
        <Route path={"/worker/settings"} component={() => <ProtectedRoute component={() => <WorkerOperator view="settings" />} allowedRoles={["worker"]} />} />
        <Route path={"/worker"} component={() => <ProtectedRoute component={WorkerOperator} allowedRoles={["worker"]} />} />
        <Route path={"/404"} component={NotFound} />
        {/* Final fallback route */}
        <Route component={NotFound} />
      </Switch>
    </DashboardLayout>
  );
}

function Router() {
  return (
    <Suspense fallback={<RouteLoading />}>
      <Switch>
        <Route path="/accept-invite/:token" component={WorkerInvitationAcceptance} />
        <Route component={ProtectedRoutes} />
      </Switch>
    </Suspense>
  );
}

// NOTE: About Theme
// - First choose a default theme according to your design style (dark or light bg), than change color palette in index.css
//   to keep consistent foreground/background color across components
// - If you want to make theme switchable, pass `switchable` ThemeProvider and use `useTheme` hook

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider
        defaultTheme="dark"
        switchable
      >
        <LoadingQueueProvider>
          <TooltipProvider>
            <Toaster />
            <Router />
          </TooltipProvider>
        </LoadingQueueProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
