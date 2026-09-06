import type { DragEvent, JSX } from 'react';
import { BlockChip } from '../components/BlockCard';
import { PALETTE, templateFor } from '../model';
import { useFlowStore } from '../store/flow';
import { BLOCK_DRAG_TYPE } from './dragTypes';
import styles from './Palette.module.css';

/**
 * The blocks a flow is made of. Dragging one onto the canvas drops it where it lands;
 * clicking one appends it to the end of the flow, which is what a person does nine times
 * out of ten. Either way it also writes the node's Python: a block on the canvas is a
 * block in the file, and an empty stage nobody can run is not a block.
 */
export function Palette({ disabled = false }: { disabled?: boolean }): JSX.Element {
  const model = useFlowStore((state) => state.model);
  const appendBlock = useFlowStore((state) => state.appendBlock);

  const start = (event: DragEvent<HTMLDivElement>, kind: string): void => {
    event.dataTransfer.setData(BLOCK_DRAG_TYPE, kind);
    event.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <aside className={styles.palette} aria-label="Blocks">
      <div className={styles.title}>Blocks</div>
      {PALETTE.map((item) => (
        <div
          key={item.kind}
          className={styles.row}
          draggable={!disabled}
          aria-disabled={disabled}
          onDragStart={(event) => start(event, item.kind)}
          onClick={() => {
            if (disabled || !model) return;
            const template = templateFor(item.kind, model);
            appendBlock(template.block, template.nodes);
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            if (disabled || !model) return;
            const template = templateFor(item.kind, model);
            appendBlock(template.block, template.nodes);
          }}
          title={item.hint}
        >
          <BlockChip kind={item.kind} />
        </div>
      ))}
    </aside>
  );
}
