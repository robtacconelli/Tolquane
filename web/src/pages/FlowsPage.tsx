import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { createFlow, deleteFlow, renameFlow } from '../api/flowsCrud';
import { listFlows, type FlowSummary } from '../api/flowsList';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { EmptyFlowsArt } from '../components/Illustrations';
import { Notice } from '../components/Notice';
import { ListColumns, Page, PageHeader, Panel, PanelHeader } from '../components/Page';
import { ConfirmDialog } from '../components/form/Dialog';
import pageStyles from '../components/Page.module.css';
import { FlowListSkeleton, FlowRow } from '../flows/FlowRow';
import { shortPath } from '../flows/format';
import {
  NewFlowDialog,
  RenameFlowDialog,
  type NewFlowMode,
  type NewFlowValues,
} from '../flows/NewFlowDialog';
import styles from '../flows/Flows.module.css';
import { useAiStore } from '../store/ai';
import { takeIntent, useCommandsStore } from '../store/commands';

/*
 * The workspace: every flow file, what it last did, and the four things you do to one --
 * open it, make another, rename it, delete it.
 *
 * "Build with AI" starts here as well as in the editor: a described flow is created as an
 * empty file and the description is handed to the AI panel, which asks it the moment the
 * editor opens. That way the builder always works on a file that exists, and the user
 * saves what it writes like any other edit.
 */

const COLUMNS = ['Flow', 'Last run', 'Modified', 'Size', ''] as const;
const TEMPLATE = 'minmax(0, 2.2fr) 150px 170px 110px 170px';

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

export function FlowsPage(): JSX.Element {
  const navigate = useNavigate();

  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [filter, setFilter] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  /* The command palette's "Build a flow with the AI builder…" asks for this dialog: it
   * sets the flag and comes here, so the page may be opening for it (read once, below)
   * or already on screen (the subscription further down). */
  const [creating, setCreating] = useState<NewFlowMode | null>(() => {
    if (takeIntent('new-flow')) return 'empty';
    return useAiStore.getState().wantsNewFlow ? 'describe' : null;
  });
  const [renaming, setRenaming] = useState<FlowSummary | null>(null);
  const [confirming, setConfirming] = useState<FlowSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    listFlows().then(
      (answer) => {
        if (cancelled) return;
        setFlows(answer.flows);
        setWorkspace(answer.workspace);
        setLoadError(null);
      },
      (caught: unknown) => {
        if (cancelled) return;
        setFlows(null);
        setLoadError(caught instanceof Error ? caught : new Error(String(caught)));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tick]);

  /* "New flow…" in the command palette, when this page was already the one on screen. */
  useEffect(
    () =>
      useCommandsStore.subscribe((state) => {
        if (!takeIntent('new-flow', state.intent)) return;
        setDialogError(null);
        setCreating('empty');
      }),
    [],
  );

  useEffect(() => {
    const ai = useAiStore.getState();
    if (ai.wantsNewFlow) ai.clearNewFlow();
    return useAiStore.subscribe((state, previous) => {
      if (!state.wantsNewFlow || previous.wantsNewFlow) return;
      useAiStore.getState().clearNewFlow();
      setDialogError(null);
      setCreating('describe');
    });
  }, []);

  const taken = useMemo(() => (flows ?? []).map((flow) => flow.path), [flows]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return flows ?? [];
    return (flows ?? []).filter(
      (flow) =>
        flow.path.toLowerCase().includes(needle) || flow.name.toLowerCase().includes(needle),
    );
  }, [flows, filter]);

  function create(values: NewFlowValues): void {
    setBusy(true);
    setDialogError(null);
    createFlow(values.path, values.template).then(
      () => {
        setBusy(false);
        setCreating(null);
        if (values.description) {
          const ai = useAiStore.getState();
          ai.prime(values.path, values.description);
          ai.setOpen(true);
        }
        void navigate(`/flows/${values.path}`);
      },
      (caught: unknown) => {
        setBusy(false);
        setDialogError(messageOf(caught));
      },
    );
  }

  function rename(to: string): void {
    const flow = renaming;
    if (!flow) return;
    setBusy(true);
    setDialogError(null);
    renameFlow(flow.path, to).then(
      () => {
        setBusy(false);
        setRenaming(null);
        setNotice(`Renamed ${flow.path} to ${to}.`);
        reload();
      },
      (caught: unknown) => {
        setBusy(false);
        setDialogError(messageOf(caught));
      },
    );
  }

  function remove(): void {
    const flow = confirming;
    if (!flow) return;
    setBusy(true);
    setDialogError(null);
    deleteFlow(flow.path).then(
      () => {
        setBusy(false);
        setConfirming(null);
        setNotice(`Deleted ${flow.path}.`);
        reload();
      },
      (caught: unknown) => {
        setBusy(false);
        setDialogError(messageOf(caught));
      },
    );
  }

  const offline = loadError instanceof ApiError && loadError.isOffline;

  const buildButton = (
    <Button
      variant="secondary"
      onClick={() => {
        setDialogError(null);
        setCreating('describe');
      }}
    >
      <Icon name="sparkle" />
      Build with AI
    </Button>
  );

  const newButton = (
    <Button
      variant="primary"
      onClick={() => {
        setDialogError(null);
        setCreating('empty');
      }}
    >
      <Icon name="plus" />
      New flow
    </Button>
  );

  return (
    <Page>
      <PageHeader
        title="Flows"
        description={
          <>
            Every flow is a plain <code>flow.py</code> in your workspace. Edit it on the canvas or
            in code; it still runs anywhere Tolquane is installed.
          </>
        }
        actions={
          <>
            {buildButton}
            {newButton}
          </>
        }
      />

      <Panel>
        <PanelHeader
          title="Workspace"
          hint={
            workspace ? (
              <span className={styles.workspace} title={workspace}>
                {shortPath(workspace)}
              </span>
            ) : (
              'No workspace open'
            )
          }
          actions={
            <label className={pageStyles.field} style={{ width: 220 }}>
              <Icon name="search" size={14} />
              <input
                className={pageStyles.fieldInput}
                placeholder="Filter flows"
                aria-label="Filter flows"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                disabled={flows === null}
              />
            </label>
          }
        />

        {notice ? (
          <Notice tone="success" onDismiss={() => setNotice(null)}>
            {notice}
          </Notice>
        ) : null}

        <ListColumns columns={COLUMNS} template={TEMPLATE} />

        {flows === null && !loadError ? <FlowListSkeleton template={TEMPLATE} /> : null}

        {loadError ? (
          <EmptyState
            art={<EmptyFlowsArt />}
            title={offline ? 'The server is not running' : 'The workspace could not be read'}
            body={
              offline ? (
                <>
                  Start it with <code>tolquane web</code>. Flows are files on disk, so they are all
                  still there.
                </>
              ) : (
                loadError.message
              )
            }
            actions={<Button onClick={reload}>Try again</Button>}
          />
        ) : null}

        {flows && flows.length === 0 ? (
          <EmptyState
            art={<EmptyFlowsArt />}
            title="No flows yet"
            body={
              <>
                Start from an empty canvas, or describe what you want and let the AI builder write
                the first version. Flows you create appear here.
              </>
            }
            actions={
              <>
                {newButton}
                {buildButton}
              </>
            }
          />
        ) : null}

        {flows && flows.length > 0 && shown.length === 0 ? (
          <p className={styles.nothing}>No flow matches “{filter.trim()}”.</p>
        ) : null}

        {shown.length > 0 ? (
          <div className={styles.list} role="list">
            {shown.map((flow) => (
              <FlowRow
                key={flow.path}
                flow={flow}
                template={TEMPLATE}
                busy={busy}
                onRename={(row) => {
                  setDialogError(null);
                  setRenaming(row);
                }}
                onDelete={(row) => {
                  setDialogError(null);
                  setConfirming(row);
                }}
              />
            ))}
          </div>
        ) : null}
      </Panel>

      {creating ? (
        <NewFlowDialog
          initialMode={creating}
          taken={taken}
          busy={busy}
          error={dialogError}
          onCreate={create}
          onClose={() => setCreating(null)}
        />
      ) : null}

      {renaming ? (
        <RenameFlowDialog
          path={renaming.path}
          taken={taken}
          busy={busy}
          error={dialogError}
          onRename={rename}
          onClose={() => setRenaming(null)}
        />
      ) : null}

      {confirming ? (
        <ConfirmDialog
          title="Delete this flow?"
          body={
            <>
              <code>{confirming.path}</code> and its layout sidecar are removed from the workspace.
              Past runs stay in the history.
            </>
          }
          confirmLabel="Delete flow"
          busy={busy}
          error={dialogError}
          onConfirm={remove}
          onClose={() => setConfirming(null)}
        />
      ) : null}
    </Page>
  );
}
