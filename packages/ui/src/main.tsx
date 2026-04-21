import './index.css';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { createRoot } from 'react-dom/client';
import { Dashboard } from './views/Dashboard.js';
import { TaskDetail } from './views/TaskDetail.js';
import { CreateTask } from './views/CreateTask.js';
import { Settings } from './views/Settings.js';
import { Help } from './views/Help.js';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/tasks/:id" element={<TaskDetail />} />
        <Route path="/tasks/new" element={<CreateTask />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/help" element={<Help />} />
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
