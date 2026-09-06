import type { JSX } from 'react';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { EmptyFlowsArt } from '../components/Illustrations';
import { ListColumns, Page, PageHeader, Panel, PanelHeader } from '../components/Page';
import styles from '../components/Page.module.css';

const COLUMNS = ['Name', 'Blocks', 'Runtime', 'Last run', 'Modified'] as const;
const TEMPLATE = 'minmax(0, 2.4fr) 80px 110px 160px 130px';

export function FlowsPage(): JSX.Element {
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
            <Button variant="secondary">
              <Icon name="sparkle" />
              Build with AI
            </Button>
            <Button variant="primary">
              <Icon name="plus" />
              New flow
            </Button>
          </>
        }
      />

      <Panel>
        <PanelHeader
          title="Workspace"
          hint="No workspace open"
          actions={
            <label className={styles.field} style={{ width: 220 }}>
              <Icon name="search" size={14} />
              <input className={styles.fieldInput} placeholder="Filter flows" disabled />
            </label>
          }
        />
        <ListColumns columns={COLUMNS} template={TEMPLATE} />
        <EmptyState
          art={<EmptyFlowsArt />}
          title="No flows yet"
          body={
            <>
              Start from an empty canvas, or describe what you want and let the AI builder write the
              first version. Flows you create appear here.
            </>
          }
          actions={
            <>
              <Button variant="primary">
                <Icon name="plus" />
                New flow
              </Button>
              <Button variant="secondary">
                <Icon name="folder" />
                Choose workspace
              </Button>
            </>
          }
        />
      </Panel>
    </Page>
  );
}
