import type { JSX, ReactNode } from 'react';
import { Button } from '../components/Button';
import { Page, PageHeader, Panel, PanelHeader, Segmented } from '../components/Page';
import { NODE_STATE_LABEL, NODE_STATES } from '../components/nodeState';
import { StatusDot } from '../components/StatusDot';
import { useUiStore, type ThemeMode } from '../store/ui';
import styles from './Settings.module.css';

const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const satisfies readonly { value: ThemeMode; label: string }[];

function Row({
  label,
  help,
  children,
}: {
  label: string;
  help?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={styles.row}>
      <div>
        <div className={styles.label}>{label}</div>
        {help ? <div className={styles.help}>{help}</div> : null}
      </div>
      <div className={styles.control}>{children}</div>
    </div>
  );
}

export function SettingsPage(): JSX.Element {
  const themeMode = useUiStore((state) => state.themeMode);
  const setThemeMode = useUiStore((state) => state.setThemeMode);

  return (
    <Page>
      <PageHeader
        title="Settings"
        description="Settings live in the Tolquane Web database next to your workspace. API keys are the exception: they are read from the environment or from a permissions-restricted settings file, never from the database."
      />

      <Panel>
        <PanelHeader title="Appearance" />
        <Row
          label="Theme"
          help="System follows your operating system. Your choice is remembered in this browser."
        >
          <Segmented
            label="Theme"
            options={THEME_OPTIONS}
            value={themeMode}
            onChange={setThemeMode}
          />
        </Row>
        <div className={styles.stackRow}>
          <div className={styles.label}>Run states</div>
          <div className={styles.help}>
            The five colours a node takes on the canvas while a flow runs. Waiting means back
            pressure, not an error.
          </div>
          <div className={styles.legend}>
            {NODE_STATES.map((state) => (
              <span key={state} className={styles.chip}>
                <StatusDot state={state} />
                {NODE_STATE_LABEL[state]}
              </span>
            ))}
          </div>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Workspace" hint="Waiting for the server" />
        <Row label="Workspace directory" help="Where flows are read from and written to.">
          <input className={`${styles.input} ${styles.mono}`} placeholder="~/tolquane" disabled />
        </Row>
        <Row
          label="Default runtime"
          help="Used for a new flow and for runs that do not override it."
        >
          <select className={styles.select} disabled defaultValue="threads">
            <option value="threads">threads</option>
            <option value="processes">processes</option>
            <option value="sync">sync</option>
          </select>
        </Row>
        <Row label="Concurrent runs" help="How many flows the server will run at once.">
          <input className={styles.input} type="number" defaultValue={2} disabled />
        </Row>
      </Panel>

      <Panel>
        <PanelHeader title="AI builder" />
        <Row
          label="Provider"
          help="The builder uses the same tolquane.ai.Builder as the command line."
        >
          <select className={styles.select} disabled defaultValue="anthropic">
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
          </select>
        </Row>
        <Row
          label="API key"
          help="Read from the environment, or from a settings file only you can read. It is never stored in the database and never written into a flow."
        >
          <input
            className={`${styles.input} ${styles.mono}`}
            type="password"
            placeholder="not set"
            disabled
          />
        </Row>
      </Panel>

      <Panel>
        <PanelHeader
          title="Server"
          actions={
            <Button variant="secondary" size="sm" disabled>
              Restart
            </Button>
          }
        />
        <Row label="Bind address" help="127.0.0.1 keeps the server on this machine.">
          <input
            className={`${styles.input} ${styles.mono}`}
            defaultValue="127.0.0.1:8765"
            disabled
          />
        </Row>
        <Row
          label="Access token"
          help="Required only when the server is bound to an address other than localhost."
        >
          <input className={`${styles.input} ${styles.mono}`} placeholder="none" disabled />
        </Row>
      </Panel>
    </Page>
  );
}
