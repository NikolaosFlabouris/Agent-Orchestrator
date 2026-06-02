import './index.css';
import { BrowserRouter, Routes, Route, Outlet } from 'react-router-dom';
import { createRoot } from 'react-dom/client';
import { Dashboard } from './views/Dashboard.js';
import { TaskDetail } from './views/TaskDetail.js';
import { CreateTask } from './views/CreateTask.js';
import { Settings } from './views/Settings.js';
import { Help } from './views/Help.js';
import { SignedOut } from './views/SignedOut.js';
import { AuthGate } from './components/AuthGate.js';

/** Layout route that gates every authenticated view behind a single
 *  AuthGate. Mounted once for the whole authenticated subtree, so
 *  GET /api/me fires exactly once on startup and stays resolved while
 *  the user navigates between views via <Outlet>. */
function GatedLayout() {
  return (
    <AuthGate>
      <Outlet />
    </AuthGate>
  );
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public route — must stay OUTSIDE AuthGate (and never call
            /api/*) or it would trip the 401-redirect in api.ts and
            bounce straight back into the Forgejo login flow, making
            logout feel like a no-op. */}
        <Route path="/signed-out" element={<SignedOut />} />
        <Route element={<GatedLayout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/tasks/:id" element={<TaskDetail />} />
          <Route path="/tasks/new" element={<CreateTask />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/help" element={<Help />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
