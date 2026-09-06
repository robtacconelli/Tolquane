import { useEffect, type JSX } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { LoginGate } from './components/LoginGate';
import { useTokenGeneration } from './hooks/useToken';
import { EditorPage } from './pages/EditorPage';
import { FlowsPage } from './pages/FlowsPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { RunsPage } from './pages/RunsPage';
import { SchedulesPage } from './pages/SchedulesPage';
import { SettingsPage } from './pages/SettingsPage';
import { UsersPage } from './pages/UsersPage';
import { loadAuth } from './store/auth';

/* The editor route is a splat, not `:path`: a flow lives at a path inside the workspace
 * and may sit in a subdirectory.
 *
 * `/login` is the only route outside the shell -- there is nothing to navigate to until
 * it is answered -- and everything else is behind `LoginGate`, which is not in the way
 * at all on a server without users. */
export function App(): JSX.Element {
  /* Who the caller is, asked once at start-up and again on every token change: a
   * sign-in, a sign-out, or the `--token` dialog being answered. */
  const generation = useTokenGeneration();
  useEffect(() => {
    void loadAuth();
  }, [generation]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <LoginGate>
            <AppShell />
          </LoginGate>
        }
      >
        <Route path="/" element={<Navigate to="/flows" replace />} />
        <Route path="/flows" element={<FlowsPage />} />
        <Route path="/flows/*" element={<EditorPage />} />
        <Route path="/runs" element={<RunsPage />} />
        <Route path="/schedules" element={<SchedulesPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
