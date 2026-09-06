import { useState, type JSX } from 'react';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { EmptyRunsArt } from '../components/Illustrations';
import { ListColumns, Page, PageHeader, Panel, PanelHeader, Segmented } from '../components/Page';

const COLUMNS = ['Flow', 'Status', 'Started', 'Elapsed', 'Items', 'Trigger'] as const;
const TEMPLATE = 'minmax(0, 2fr) 110px 150px 90px 90px 110px';

type Filter = 'all' | 'running' | 'done' | 'failed';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'done', label: 'Done' },
  { value: 'failed', label: 'Failed' },
] as const satisfies readonly { value: Filter; label: string }[];

export function RunsPage(): JSX.Element {
  const [filter, setFilter] = useState<Filter>('all');

  return (
    <Page>
      <PageHeader
        title="Runs"
        description="Every run is a child process streaming its progress back here: node states, item counts, queue depths, output and the final report."
        actions={
          <Button variant="secondary" disabled>
            <Icon name="runs" />
            Refresh
          </Button>
        }
      />

      <Panel>
        <PanelHeader
          title="History"
          hint="Kept in ~/.tolquane/web.db"
          actions={
            <Segmented label="Filter runs" options={FILTERS} value={filter} onChange={setFilter} />
          }
        />
        <ListColumns columns={COLUMNS} template={TEMPLATE} />
        <EmptyState
          art={<EmptyRunsArt />}
          title="Nothing has run yet"
          body="Open a flow and press Run. Progress arrives live while it works, and the run stays here afterwards with its report and log."
          actions={<Button variant="primary">Open a flow</Button>}
        />
      </Panel>
    </Page>
  );
}
