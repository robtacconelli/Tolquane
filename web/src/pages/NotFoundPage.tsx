import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { EmptyFlowsArt } from '../components/Illustrations';
import { Page, Panel } from '../components/Page';

export function NotFoundPage(): JSX.Element {
  return (
    <Page>
      <Panel>
        <EmptyState
          art={<EmptyFlowsArt />}
          title="That page does not exist"
          body={
            <>
              The address does not match anything in Tolquane Web.{' '}
              <Link to="/flows">Go to flows</Link>.
            </>
          }
        />
      </Panel>
    </Page>
  );
}
