import type { DragEvent, JSX } from 'react';
import { BlockChip } from '../components/BlockCard';
import { Icon } from '../components/Icon';
import { PALETTE, templateFor } from '../model';
import { useFlowStore } from '../store/flow';
import { BLOCK_DRAG_TYPE } from './dragTypes';
import { useEditorLayout } from './layout';
import styles from './Palette.module.css';

/**
 * The blocks a flow is made of. Dragging one onto the canvas drops it where it lands;
 * clicking one appends it to the end of the flow, which is what a person does nine times
 * out of ten. Either way it also writes the node's Python: a block on the canvas is a
 * block in the file, and an empty stage nobody can run is not a block.
 *
 * The column folds to a rail of icons, because on a 1280-wide screen its 176px are the
 * difference between a flow that reads and a flow that has to be panned.
 */
export function Palette({ disabled = false }: { disabled?: boolean }): JSX.Element {
  const model = useFlowStore((state) => state.model);
  const appendBlock = useFlowStore((state) => state.appendBlock);
  const open = useEditorLayout((state) => state.paletteOpen);
  const togglePalette = useEditorLayout((state) => state.togglePalette);

  const start = (event: DragEvent<HTMLDivElement>, kind: string): void => {
    event.dataTransfer.setData(BLOCK_DRAG_TYPE, kind);
    event.dataTransfer.effectAllowed = 'copy';
  };

  const add = (kind: (typeof PALETTE)[number]['kind']): void => {
    if (disabled || !model) return;
    const template = templateFor(kind, model);
    appendBlock(template.block, template.nodes);
  };

  return (
    <aside className={styles.palette} aria-label="Blocks" data-open={open}>
      <div className={styles.head}>
        {open ? <span className={styles.title}>Blocks</span> : null}
        <button
          type="button"
          className={styles.fold}
          onClick={togglePalette}
          aria-label={open ? 'Fold the block palette' : 'Unfold the block palette'}
          aria-expanded={open}
          title={open ? 'Fold the block palette' : 'Unfold the block palette'}
        >
          <Icon name={open ? 'chevronLeft' : 'chevronRight'} size={15} />
        </button>
      </div>
      <div className={styles.list}>
        {PALETTE.map((item) => (
          <div
            key={item.kind}
            className={styles.row}
            draggable={!disabled}
            aria-disabled={disabled}
            aria-label={item.label}
            onDragStart={(event) => start(event, item.kind)}
            onClick={() => add(item.kind)}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              add(item.kind);
            }}
            title={open ? item.hint : `${item.label} — ${item.hint}`}
          >
            <BlockChip kind={item.kind} compact={!open} />
          </div>
        ))}
      </div>
    </aside>
  );
}
