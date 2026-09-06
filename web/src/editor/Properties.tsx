import { lazy, Suspense, useState, type JSX, type ReactNode } from 'react';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { paramFieldType, pythonLiteral, type ParamFieldType } from '../inputs/params';
import {
  COLLECT_LABEL,
  COLLECT_POLICIES,
  EMIT_LABEL,
  EMIT_POLICIES,
  RUNTIMES,
  RUNTIME_LABEL,
  blockSubtitle,
  blockTitle,
  cardKind,
  findNode,
  getAt,
  isTree,
  nodeSignature,
  paramNameError,
  problemsAt,
  type CollectPolicy,
  type EmitPolicy,
  type FarmTree,
  type FlowModel,
  type FlowParam,
  type Problem,
  type Runtime,
  type Tree,
} from '../model';
import { useFlowStore, useProblems } from '../store/flow';
import { CodeBlock, NumberField, Section, SelectField, TextField, ToggleField } from './controls';
import styles from './Properties.module.css';

/* The body editor is CodeMirror, which is a lazy chunk: until it arrives the panel shows
 * the same body as the read-only block it replaces, so nothing jumps. */
const NodeBody = lazy(() => import('./code/NodeBody'));

/* The right-hand panel: every option of the selected block, as a proper control, with
 * the problems that belong to it under the control that causes them. It reads and writes
 * the flow store directly -- there is one selection and one model, and passing them down
 * through the canvas would only put React Flow between a person and their farm. */

const NONE = '—';

function optionOf(value: Tree | false | null): 'default' | 'off' | 'custom' {
  if (value === false) return 'off';
  return isTree(value) ? 'custom' : 'default';
}

function firstError(problems: readonly Problem[], match: RegExp): string | undefined {
  return problems.find((problem) => match.test(problem.message))?.message;
}

function nodeOptions(model: FlowModel): { value: string; label: string }[] {
  return model.nodes.map((node) => ({ value: node.id, label: `${node.id} · tq.${node.kind}` }));
}

export function Properties({ onEditCode }: { onEditCode?: (nodeId: string) => void }): JSX.Element {
  const model = useFlowStore((state) => state.model);
  const selected = useFlowStore((state) => state.selected);
  const problems = useProblems();
  const codeOnly = useFlowStore((state) => state.codeOnly);

  const setFarmOptions = useFlowStore((state) => state.setFarmOptions);
  const setWorkers = useFlowStore((state) => state.setWorkers);
  const setBlockName = useFlowStore((state) => state.setBlockName);
  const setMerge = useFlowStore((state) => state.setMerge);
  const setCrossBlock = useFlowStore((state) => state.setCrossBlock);
  const replaceBlock = useFlowStore((state) => state.replaceBlock);
  const setStart = useFlowStore((state) => state.setStart);
  const wrapBlock = useFlowStore((state) => state.wrapBlock);
  const unwrapBlock = useFlowStore((state) => state.unwrapBlock);
  const removeBlock = useFlowStore((state) => state.removeBlock);

  const block = model && selected !== null ? getAt(model.flow, selected) : null;

  if (!model || !block || selected === null) {
    return (
      <div className={styles.panel}>
        <Head title="Properties" />
        <div className={styles.empty}>
          <span className={styles.emptyGlyph}>
            <Icon name="settings" size={18} />
          </span>
          <span className={styles.emptyTitle}>
            {codeOnly ? 'Read-only flow' : 'Nothing selected'}
          </span>
          <p className={styles.emptyBody}>
            {codeOnly
              ? 'This file cannot be modelled, so the canvas shows the expanded graph instead. The code editor still works.'
              : 'Select a block to edit its options: workers, ordering, capacity, runtime and the node body itself.'}
          </p>
        </div>
      </div>
    );
  }

  const own = problemsAt(problems, selected);
  const kind = cardKind(block, model);

  return (
    <div className={styles.panel}>
      <Head title="Properties" />
      <div className={styles.body}>
        <header className={styles.head} data-kind={kind}>
          <span className={styles.headTitle}>{blockTitle(block, model)}</span>
          <span className={styles.headKind}>{blockSubtitle(block, model)}</span>
        </header>

        {own.length > 0 ? (
          <div className={styles.problems}>
            {own.map((problem, index) => (
              <p
                key={`${problem.message}-${String(index)}`}
                className={
                  problem.severity === 'error' ? styles.problemError : styles.problemWarning
                }
              >
                <Icon name="alert" size={13} />
                {problem.message}
              </p>
            ))}
          </div>
        ) : null}

        {block.type === 'ref' ? (
          <RefFields
            model={model}
            block={block}
            path={selected}
            {...(onEditCode ? { onEditCode } : {})}
          />
        ) : null}
        {block.type === 'start' ? (
          <>
            <Section title="Start">
              <SelectField
                label="Source node"
                value={model.start ?? ''}
                options={[{ value: '', label: NONE }, ...nodeOptions(model)]}
                onChange={(value) => setStart(value === '' ? null : value)}
                hint="Used when the flow runs without a sample: start = this node."
              />
            </Section>
            <ParameterFields model={model} />
          </>
        ) : null}
        {block.type === 'inline' ? (
          <Section title="Expression">
            <CodeBlock code={block.source} title="As written" />
            <p className={styles.note}>
              Tolquane Web keeps expressions it does not model verbatim and writes them back where
              they were. Edit it in the code view.
            </p>
          </Section>
        ) : null}
        {block.type === 'farm' ? (
          <FarmFields
            farm={block}
            model={model}
            problems={own}
            onWorkers={(value) => setWorkers(selected, value)}
            onOptions={(patch) => setFarmOptions(selected, patch)}
          />
        ) : null}
        {block.type === 'feedback' ? (
          <Section title="Feedback loop">
            <TextField
              label="Name"
              value={block.name ?? ''}
              placeholder="loop"
              onChange={(value) => setBlockName(selected, value === '' ? null : value)}
              hint="Names the loop in reports and deadlock messages."
            />
          </Section>
        ) : null}
        {block.type === 'comb' ? (
          <Section title="Fused nodes">
            <SelectField
              label="First"
              value={block.first.type === 'ref' ? block.first.id : ''}
              options={[{ value: '', label: NONE }, ...nodeOptions(model)]}
              onChange={(value) =>
                replaceBlock(selected, { ...block, first: { type: 'ref', id: value } })
              }
            />
            <SelectField
              label="Second"
              value={block.second.type === 'ref' ? block.second.id : ''}
              options={[{ value: '', label: NONE }, ...nodeOptions(model)]}
              onChange={(value) =>
                replaceBlock(selected, { ...block, second: { type: 'ref', id: value } })
              }
              hint="Both run on one thread, with no channel between them."
            />
          </Section>
        ) : null}
        {block.type === 'all2all' ? (
          <Section title="All-to-all">
            <ToggleField
              label="Merge"
              checked={block.merge}
              onChange={(value) => setMerge(selected, value)}
              hint="The two farms meet through one node instead of every pair."
            />
            <SelectField
              label="R · after each left worker"
              value={block.R && block.R.type === 'ref' ? block.R.id : ''}
              options={[{ value: '', label: NONE }, ...nodeOptions(model)]}
              onChange={(value) =>
                setCrossBlock(selected, 'R', value === '' ? null : { type: 'ref', id: value })
              }
            />
            <SelectField
              label="G · before each right worker"
              value={block.G && block.G.type === 'ref' ? block.G.id : ''}
              options={[{ value: '', label: NONE }, ...nodeOptions(model)]}
              onChange={(value) =>
                setCrossBlock(selected, 'G', value === '' ? null : { type: 'ref', id: value })
              }
            />
          </Section>
        ) : null}

        <Section title="Block">
          <div className={styles.actions}>
            <Button size="sm" variant="secondary" onClick={() => wrapBlock(selected, 'farm')}>
              <Icon name="flows" size={14} />
              Wrap in a farm
            </Button>
            <Button size="sm" variant="secondary" onClick={() => wrapBlock(selected, 'feedback')}>
              <Icon name="runs" size={14} />
              Wrap in a loop
            </Button>
            {block.type === 'farm' || block.type === 'feedback' || block.type === 'pipeline' ? (
              <Button size="sm" variant="secondary" onClick={() => unwrapBlock(selected)}>
                <Icon name="close" size={14} />
                Unwrap
              </Button>
            ) : null}
            <Button size="sm" variant="danger" onClick={() => removeBlock(selected)}>
              <Icon name="close" size={14} />
              Delete
            </Button>
          </div>
        </Section>
      </div>
    </div>
  );
}

function Head({ title, actions }: { title: string; actions?: ReactNode }): JSX.Element {
  return (
    <div className={styles.sectionHead}>
      {title}
      {actions}
    </div>
  );
}

function RefFields({
  model,
  block,
  path,
  onEditCode,
}: {
  model: FlowModel;
  block: Tree & { type: 'ref' };
  path: string;
  onEditCode?: (nodeId: string) => void;
}): JSX.Element {
  const replaceBlock = useFlowStore((state) => state.replaceBlock);
  const node = findNode(model, block.id);
  const title = block.id;
  const edit = (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => onEditCode?.(block.id)}
      disabled={!onEditCode || !node}
    >
      <Icon name="code" size={14} />
      Edit code
    </Button>
  );
  return (
    <>
      <Section title="Node">
        <SelectField
          label="Definition"
          value={block.id}
          options={nodeOptions(model)}
          onChange={(value) => replaceBlock(path, { type: 'ref', id: value })}
          hint={nodeSignature(model, block.id) ?? 'This name is not defined in the file.'}
        />
      </Section>
      <Section title="Body">
        {node ? (
          <Suspense fallback={<CodeBlock code={node.source} title={title} action={edit} />}>
            <NodeBody key={node.id} id={node.id} source={node.source} title={title} action={edit} />
          </Suspense>
        ) : (
          <CodeBlock code={`# ${block.id} is not defined in this file`} title={title} />
        )}
      </Section>
    </>
  );
}

function FarmFields({
  farm,
  model,
  problems,
  onWorkers,
  onOptions,
}: {
  farm: FarmTree;
  model: FlowModel;
  problems: readonly Problem[];
  onWorkers: (workers: number) => void;
  onOptions: (patch: Partial<FarmTree['options']>) => void;
}): JSX.Element {
  const o = farm.options;
  const heterogeneous = Array.isArray(farm.worker);
  const ends = [
    { value: 'default', label: 'The farm’s own' },
    { value: 'off', label: 'None (expose the workers)' },
    ...model.nodes.map((node) => ({
      value: `node:${node.id}`,
      label: `${node.id} · tq.${node.kind}`,
    })),
  ];

  const endValue = (slot: Tree | false | null): string => {
    const state = optionOf(slot);
    if (state === 'custom' && isTree(slot) && slot.type === 'ref') return `node:${slot.id}`;
    if (state === 'custom') return 'default';
    return state;
  };

  const setEnd = (which: 'emitter' | 'collector', value: string): void => {
    if (value === 'default') onOptions({ [which]: null });
    else if (value === 'off') onOptions({ [which]: false });
    else onOptions({ [which]: { type: 'ref', id: value.slice('node:'.length) } });
  };

  return (
    <>
      <Section title="Workers">
        <NumberField
          label="How many"
          value={heterogeneous ? (farm.worker as Tree[]).length : farm.workers}
          min={1}
          max={4096}
          disabled={heterogeneous}
          onChange={(value) => onWorkers(value ?? 1)}
          hint={
            heterogeneous
              ? 'A heterogeneous farm has one worker per callable; its count is the list.'
              : 'Copies of the worker running at once.'
          }
          error={firstError(problems, /workers must be/)}
        />
        <TextField
          label="Name"
          value={o.name ?? ''}
          placeholder={farm.worker && !heterogeneous ? 'the worker’s name' : 'farm'}
          onChange={(value) => onOptions({ name: value === '' ? null : value })}
          hint="Names the farm’s nodes in reports: work.0, work.emitter."
        />
      </Section>

      <Section title="Emitting">
        <SelectField<EmitPolicy>
          label="Emit policy"
          value={o.emit}
          options={EMIT_POLICIES.map((policy) => ({ value: policy, label: EMIT_LABEL[policy] }))}
          onChange={(value) => onOptions({ emit: value })}
          error={firstError(problems, /emit=|key=/)}
        />
        <TextField
          label="Key"
          mono
          value={
            o.key && o.key.type === 'inline'
              ? o.key.source
              : o.key && o.key.type === 'ref'
                ? o.key.id
                : ''
          }
          placeholder="lambda item: item.user"
          onChange={(value) =>
            onOptions({
              key: value.trim() === '' ? null : { type: 'inline', source: value },
              ...(value.trim() === '' ? {} : { emit: 'key' }),
            })
          }
          hint="Items with the same key go to the same worker."
        />
        <NumberField
          label="Prefetch"
          value={o.prefetch}
          min={1}
          disabled={o.emit !== 'on_demand'}
          onChange={(value) => onOptions({ prefetch: value ?? 1 })}
          hint="How many items an idle worker is given at once, with emit on demand."
          error={firstError(problems, /prefetch/)}
        />
        <SelectField
          label="Emitter"
          value={endValue(o.emitter)}
          options={ends}
          onChange={(value) => setEnd('emitter', value)}
          hint="A node of this flow can route items itself, or the farm can have no emitter at all."
        />
      </Section>

      <Section title="Collecting">
        <ToggleField
          label="Ordered"
          checked={o.ordered}
          onChange={(value) => onOptions({ ordered: value, ...(value ? { collect: null } : {}) })}
          hint="Output order is input order. Costs a tag on every item."
        />
        <SelectField<CollectPolicy | ''>
          label="Collect policy"
          value={o.collect ?? ''}
          options={[
            { value: '', label: 'Default for this farm' },
            ...COLLECT_POLICIES.map((policy) => ({ value: policy, label: COLLECT_LABEL[policy] })),
          ]}
          onChange={(value) => onOptions({ collect: value === '' ? null : value })}
          error={firstError(problems, /collect=/)}
        />
        <SelectField
          label="Collector"
          value={endValue(o.collector)}
          options={ends}
          onChange={(value) => setEnd('collector', value)}
        />
      </Section>

      <Section title="Runtime">
        <SelectField<Runtime | ''>
          label="Where the workers run"
          value={o.runtime ?? ''}
          options={[
            { value: '', label: 'With the rest of the flow' },
            ...RUNTIMES.map((runtime) => ({ value: runtime, label: RUNTIME_LABEL[runtime] })),
          ]}
          onChange={(value) => onOptions({ runtime: value === '' ? null : value })}
          error={firstError(problems, /runtime/)}
        />
        <NumberField
          label="Capacity"
          value={o.capacity}
          min={1}
          onChange={(value) => onOptions({ capacity: value })}
          hint="Items an edge into this farm holds before the sender waits. Empty: the run’s default."
          error={firstError(problems, /capacity/)}
        />
        <NumberField
          label="Window"
          value={o.window}
          min={1}
          onChange={(value) => onOptions({ window: value })}
          hint="Items in flight inside the farm at once. Empty: unbounded."
          error={firstError(problems, /window/)}
        />
      </Section>
    </>
  );
}

/* -------------------------------------------------------------- build()'s parameters */

/** What a parameter of each kind starts out as: the literal, and the annotation. */
const PARAM_SHAPE: Record<ParamFieldType, { default: string; annotation: string }> = {
  number: { default: '0', annotation: 'int' },
  boolean: { default: 'False', annotation: 'bool' },
  text: { default: '""', annotation: 'str' },
  code: { default: 'None', annotation: '' },
};

const PARAM_TYPES: readonly { value: ParamFieldType; label: string }[] = [
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'True or False' },
  { value: 'text', label: 'Text' },
  { value: 'code', label: 'Anything else' },
];

/**
 * The parameters of `build()`, which belong to the flow and not to any card, so they sit
 * on the start card -- the one place on the canvas that stands for "what goes in".
 *
 * A parameter is three things a person can change: its name, the kind of value it takes
 * and the default the file records. Retyping it rewrites the default and the annotation
 * together, because a `str` parameter whose default is `0` is a file that no longer says
 * what it means; the literal is then editable on its own for anyone who wants `0.5`.
 */
function ParameterFields({ model }: { model: FlowModel }): JSX.Element {
  const addParam = useFlowStore((state) => state.addParam);
  return (
    <Section title="Parameters">
      {model.params.length === 0 ? (
        <p className={styles.note}>
          None. A parameter becomes a keyword of <code>build()</code> and a field in the Run
          popover, so a flow can be run with a different threshold without editing it.
        </p>
      ) : null}
      {model.params.map((param, index) => (
        // Keyed by position, not by name: a row that remounted on every keystroke of a
        // rename would take the focus away with it.
        <ParameterRow key={index} param={param} params={model.params} />
      ))}
      <div className={styles.paramActions}>
        <Button size="sm" variant="secondary" onClick={() => addParam()}>
          <Icon name="plus" size={13} />
          Add a parameter
        </Button>
      </div>
    </Section>
  );
}

function ParameterRow({
  param,
  params,
}: {
  param: FlowParam;
  params: readonly FlowParam[];
}): JSX.Element {
  const renameParam = useFlowStore((state) => state.renameParam);
  const setParam = useFlowStore((state) => state.setParam);
  const removeParam = useFlowStore((state) => state.removeParam);
  /* The name is held here while it is typed and committed when the field is left: a
   * rename on every keystroke would put `t`, `th`, `thr` into the file and into the undo
   * stack on the way to `threshold`. When the model's name changes under it -- an undo,
   * a row removed above this one -- the draft follows, adjusted during the render that
   * brought the new name rather than in an effect after it. */
  const [name, setName] = useState(param.name);
  const [known, setKnown] = useState(param.name);
  if (known !== param.name) {
    setKnown(param.name);
    setName(param.name);
  }
  const nameError = paramNameError(name, params, param.name);
  const literalError = pythonLiteral(param.default).ok
    ? undefined
    : 'Not a literal Python can read; the flow will open in code-only mode.';

  function commitName(): void {
    if (nameError === null && name.trim() !== param.name) renameParam(param.name, name.trim());
  }

  return (
    <div className={styles.param} role="group" aria-label={`Parameter ${param.name}`}>
      {/* `blur` bubbles, so the wrapper is where the rename is committed; Enter does the
          same without leaving the field. */}
      <div
        onBlur={commitName}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          commitName();
        }}
      >
        <TextField
          label="Name"
          mono
          value={name}
          onChange={setName}
          {...(nameError === null ? {} : { error: nameError })}
        />
      </div>
      <SelectField<ParamFieldType>
        label="Takes"
        value={paramFieldType(param)}
        options={PARAM_TYPES}
        onChange={(type) => {
          const shape = PARAM_SHAPE[type];
          setParam(param.name, {
            default: shape.default,
            annotation: shape.annotation || null,
          });
        }}
        hint="Which field the Run popover shows for it."
      />
      <TextField
        label="Default"
        mono
        value={param.default}
        placeholder="None"
        onChange={(value) => setParam(param.name, { default: value })}
        {...(literalError === undefined
          ? { hint: 'A Python literal, written as it will be in the file.' }
          : { error: literalError })}
      />
      <div className={styles.paramActions}>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => removeParam(param.name)}
          aria-label={`Remove the parameter ${param.name}`}
        >
          <Icon name="close" size={13} />
          Remove
        </Button>
      </div>
    </div>
  );
}
