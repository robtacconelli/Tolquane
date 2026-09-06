import { createContext, use } from 'react';
import type { HealthState } from '../hooks/useHealth';

export interface AppShellValue {
  server: HealthState;
}

export const AppShellContext = createContext<AppShellValue | null>(null);

/** Pages read the server state from here rather than polling it a second time. */
export function useAppShell(): AppShellValue {
  const value = use(AppShellContext);
  if (!value) throw new Error('useAppShell must be used inside the app shell');
  return value;
}
