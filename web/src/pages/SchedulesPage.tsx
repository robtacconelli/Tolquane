import type { JSX } from 'react';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { EmptySchedulesArt } from '../components/Illustrations';
import { ListColumns, Page, PageHeader, Panel, PanelHeader } from '../components/Page';

const COLUMNS = ['Flow', 'Schedule', 'Next run', 'Last result', 'Enabled'] as const;
const TEMPLATE = 'minmax(0, 2fr) 200px 170px 130px 80px';

export function SchedulesPage(): JSX.Element {
  return (
    <Page>
      <PageHeader
        title="Schedules"
        description="Run a flow on a cron expression while the server is up. Missed times are not queued: a schedule fires once when it comes due."
        actions={
          <Button variant="primary">
            <Icon name="plus" />
            New schedule
          </Button>
        }
      />

      <Panel>
        <PanelHeader title="Scheduled flows" hint="Five-field cron, in local time" />
        <ListColumns columns={COLUMNS} template={TEMPLATE} />
        <EmptyState
          art={<EmptySchedulesArt />}
          title="No schedules"
          body="Pick a flow and a cron expression. Tolquane shows the expression in plain English and the next five times before you save it."
          actions={
            <Button variant="primary">
              <Icon name="plus" />
              New schedule
            </Button>
          }
        />
      </Panel>
    </Page>
  );
}
