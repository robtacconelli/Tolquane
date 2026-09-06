import { useState, type JSX } from 'react';
import { useParams } from 'react-router-dom';
import { BlockCard, BlockChip } from '../components/BlockCard';
import type { BlockKind } from '../components/blockKinds';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { Segmented } from '../components/Page';
import styles from './Editor.module.css';

const PALETTE: readonly BlockKind[] = [
  'source',
  'node',
  'sink',
  'farm',
  'comb',
  'feedback',
  'all2all',
  'raw',
];

const VIEWS = [
  { value: 'canvas', label: 'Canvas' },
  { value: 'code', label: 'Code' },
] as const;

const TABS = ['Console', 'Taps', 'Report', 'Problems'] as const;

export function EditorPage(): JSX.Element {
  const params = useParams<{ '*': string }>();
  const path = params['*'] ?? 'untitled.py';
  const [view, setView] = useState<'canvas' | 'code'>('canvas');
  const [tab, setTab] = useState<(typeof TABS)[number]>('Console');

  return (
    <div className={styles.editor}>
      <div className={styles.toolbar}>
        <div className={styles.file}>
          <span className={styles.fileName}>{path}</span>
          <span className={styles.fileState}>not opened</span>
        </div>
        <span className={styles.divider} />
        <Segmented label="Editor view" options={VIEWS} value={view} onChange={setView} />
        <div className={styles.toolbarSpacer} />
        <Button variant="ghost" size="sm" disabled>
          <Icon name="sparkle" size={15} />
          AI builder
        </Button>
        <Button variant="secondary" size="sm" disabled>
          <Icon name="check" size={15} />
          Check
        </Button>
        <Button variant="primary" size="sm" disabled>
          <Icon name="play" size={15} />
          Run
        </Button>
      </div>

      <div className={styles.canvas}>
        <aside className={styles.palette}>
          <div className={styles.paletteTitle}>Blocks</div>
          {PALETTE.map((kind) => (
            <BlockChip key={kind} kind={kind} />
          ))}
        </aside>

        <div className={styles.dropZone}>
          <BlockCard kind="node" title="stage" subtitle="tq.node" ghost />
          <p className={styles.dropHint}>
            Drag a block here to start a flow, or open a <code>flow.py</code> from the workspace.
          </p>
        </div>

        <div className={styles.zoom}>
          <button type="button" className={styles.zoomButton} aria-label="Zoom out" disabled>
            −
          </button>
          <span className={styles.zoomLevel}>100%</span>
          <button type="button" className={styles.zoomButton} aria-label="Zoom in" disabled>
            +
          </button>
        </div>
      </div>

      <aside className={styles.properties}>
        <div className={styles.sectionHead}>Properties</div>
        <div className={styles.sectionBody}>
          <span className={styles.hintGlyph}>
            <Icon name="settings" size={18} />
          </span>
          <span className={styles.hintTitle}>Nothing selected</span>
          <p className={styles.hint}>
            Select a block to edit its options: workers, ordering, capacity, runtime and the node
            body itself.
          </p>
        </div>
      </aside>

      <section className={styles.drawer}>
        <div className={styles.tabs} role="tablist" aria-label="Run output">
          {TABS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={name === tab}
              className={name === tab ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              onClick={() => setTab(name)}
            >
              {name}
              {name === 'Console' ? null : <span className={styles.tabCount}>0</span>}
            </button>
          ))}
        </div>
        <div className={styles.console}>
          <span className={styles.prompt}>$</span> tolquane run {path} --events
          <br />
          waiting for the server…
        </div>
      </section>
    </div>
  );
}
