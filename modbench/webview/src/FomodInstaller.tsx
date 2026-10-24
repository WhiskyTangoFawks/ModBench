// mods-fomod.md: the FOMOD installer's page. It draws the installer as the engine sends it, and sends back each click.

import React, { useEffect, useState } from 'react';
import { fomodHost } from './vscode';
import { listenToHost } from './nativeBridge';
import {
  FOMOD_MOVE, FOMOD_READY, effectiveGroupType, groupsNeedingPick, hasPrevious, isLastVisible, isOptionLocked, isPicked, optionsAfterClick, parseFomodShown,
  type FomodGroup, type FomodMove, type FomodOption, type FomodState, type FomodStep,
} from '../../src/wire/fomodPage';

const send = (move: FomodMove): void => fomodHost.postMessage({ type: FOMOD_MOVE, move });

const TYPE_TOOLTIPS: Partial<Record<FomodOption['type'], string>> = {
  Required: 'This component is required',
  Recommended: 'It is recommended you enable this component',
  NotUsable: 'This component is not usable in combination with other installed plugins',
  CouldBeUsable: 'You may be experiencing instability in combination with other installed plugins',
  Optional: 'Optional component',
};

const tooltipOf = (group: FomodGroup, option: FomodOption): string =>
  (effectiveGroupType(group) === 'SelectAll' ? 'All components in this group are required' : TYPE_TOOLTIPS[option.type] ?? '');

function OptionControl({ step, group, option }: { step: FomodStep; group: FomodGroup; option: FomodOption }) {
  const oneOnly = effectiveGroupType(group) === 'SelectExactlyOne' || effectiveGroupType(group) === 'SelectAtMostOne';
  return (
    <label title={tooltipOf(group, option)} style={{ display: 'block' }}>
      <input
        type={oneOnly ? 'radio' : 'checkbox'}
        name={`${step.id}/${group.id}`}
        checked={isPicked(group, option)}
        disabled={isOptionLocked(group, option)}
        onChange={() => send({ kind: 'select', stepId: step.id, groupId: group.id, optionIds: optionsAfterClick(group, option) })}
      />
      {option.name}
      {option.type === 'CouldBeUsable' && <span className="codicon codicon-warning" aria-label="could be unstable" />}
    </label>
  );
}

function GroupControls({ step, group }: { step: FomodStep; group: FomodGroup }) {
  const picked = group.options.some((option) => isPicked(group, option));
  return (
    <fieldset>
      <legend>{group.name}</legend>
      {group.options.map((option) => <OptionControl key={option.id} step={step} group={group} option={option} />)}
      {effectiveGroupType(group) === 'SelectAtMostOne' && (
        <label style={{ display: 'block' }}>
          <input
            type="radio" name={`${step.id}/${group.id}`} checked={!picked}
            onChange={() => send({ kind: 'select', stepId: step.id, groupId: group.id, optionIds: [] })}
          />
          None
        </label>
      )}
    </fieldset>
  );
}

function Steps({ state }: { state: FomodState }) {
  const step = state.steps[state.current];
  const waiting = step === undefined ? [] : groupsNeedingPick(step);
  const stepId = step?.id ?? 0;
  const last = isLastVisible(state.steps, state.current);
  return (
    <>
      <div>
        {step?.optionalFileGroups?.group.map((group) => <GroupControls key={group.id} step={step} group={group} />)}
      </div>
      <footer style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button disabled={!hasPrevious(state.steps, state.current)} onClick={() => send({ kind: 'continue', forward: false, stepId })}>Back</button>
        <button
          disabled={waiting.length > 0}
          title={waiting.length > 0 ? `Group(s) need a selection: ${waiting.map(({ name }) => name).join(', ')}` : undefined}
          onClick={() => send({ kind: 'continue', forward: true, stepId })}
        >
          {last ? 'Install' : 'Next'}
        </button>
        <button onClick={() => send({ kind: 'manual' })}>Manual</button>
        <button onClick={() => send({ kind: 'cancel' })}>Cancel</button>
      </footer>
    </>
  );
}

export function FomodInstallerView() {
  const [state, setState] = useState<FomodState | undefined>(undefined);

  useEffect(() => {
    const stopListening = listenToHost((data) => {
      const shown = parseFomodShown(data);
      if (shown) setState(shown.state);
    });
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') send({ kind: 'cancel' });
    };
    window.addEventListener('keydown', escape);
    fomodHost.postMessage({ type: FOMOD_READY });
    return () => {
      stopListening();
      window.removeEventListener('keydown', escape);
    };
  }, []);

  if (state === undefined) return null;
  return (
    <>
      <header><h1>{state.module}</h1></header>
      <Steps state={state} />
    </>
  );
}
