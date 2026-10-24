// mods-fomod.md: the FOMOD installer's page. It draws the installer as the engine sends it, and sends back each click.

import React, { useEffect, useRef, useState } from 'react';
import { fomodHost } from './vscode';
import { listenToHost } from './nativeBridge';
import { FOMOD_MOVE, FOMOD_READY, parseFomodShown, type FomodGroup, type FomodMove, type FomodOption, type FomodState, type FomodStep } from '../../src/wire/fomodPage';
import { effectiveGroupType, groupsNeedingPick, hasPrevious, isLastVisible, isOptionLocked, isPicked, optionsAfterClick } from './fomodRules';

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

const keyOf = (step: FomodStep, group: FomodGroup, option: FomodOption): string => `${step.id}/${group.id}/${option.id}`;

type Look = (key: string) => void;

function OptionControl({ step, group, option, look }: { step: FomodStep; group: FomodGroup; option: FomodOption; look: Look }) {
  const oneOnly = effectiveGroupType(group) === 'SelectExactlyOne' || effectiveGroupType(group) === 'SelectAtMostOne';
  return (
    <label
      title={tooltipOf(group, option)} style={{ display: 'block' }}
      onMouseEnter={() => look(keyOf(step, group, option))} onFocus={() => look(keyOf(step, group, option))}
    >
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

function GroupControls({ step, group, look }: { step: FomodStep; group: FomodGroup; look: Look }) {
  const picked = group.options.some((option) => isPicked(group, option));
  return (
    <fieldset>
      <legend>{group.name}</legend>
      {group.options.map((option) => <OptionControl key={option.id} step={step} group={group} option={option} look={look} />)}
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

function Description({ option, enlarge }: { option: FomodOption | undefined; enlarge: (image: Enlarged) => void }) {
  if (option === undefined) return null;
  return (
    <aside>
      {option.image !== '' && <img src={option.image} alt={option.name} style={{ maxWidth: '100%', cursor: 'zoom-in' }} onClick={() => enlarge({ src: option.image, name: option.name })} />}
      <p>{option.description}</p>
    </aside>
  );
}

function Steps({ state, enlarge }: { state: FomodState; enlarge: (image: Enlarged) => void }) {
  const [looked, look] = useState<string | undefined>(undefined);
  const step = state.steps[state.current];
  const described = step?.optionalFileGroups?.group
    .flatMap((group) => group.options.map((option) => ({ key: keyOf(step, group, option), option })))
    .find(({ key }) => key === looked)?.option;
  const waiting = step === undefined ? [] : groupsNeedingPick(step);
  const stepId = step?.id ?? 0;
  const last = isLastVisible(state.steps, state.current);
  return (
    <>
      <div style={{ display: 'flex', gap: 16 }}>
        <div>
          {step?.optionalFileGroups?.group.map((group) => <GroupControls key={group.id} step={step} group={group} look={look} />)}
        </div>
        <Description option={described} enlarge={enlarge} />
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

interface Enlarged {
  readonly src: string;
  readonly name: string;
}

const isWebAddress = (text: string): boolean => /^https?:\/\//i.test(text);

function Header({ state }: { state: FomodState }) {
  const about = [
    state.author !== '' && <span key="author">Author: {state.author}</span>,
    state.version !== '' && <span key="version">Version: {state.version}</span>,
    state.website !== '' && (
      <span key="website">
        Website: {isWebAddress(state.website) ? <a href={state.website}>{state.website}</a> : state.website}
      </span>
    ),
  ].filter((field) => field !== false);
  return (
    <header>
      {state.image !== '' && <img src={state.image} alt={state.module} style={{ maxWidth: '100%' }} />}
      <h1>{state.module}</h1>
      {about.length > 0 && <div style={{ display: 'flex', gap: 16 }}>{about}</div>}
    </header>
  );
}

export function FomodInstallerView() {
  const [state, setState] = useState<FomodState | undefined>(undefined);
  const [enlarged, setEnlarged] = useState<Enlarged | undefined>(undefined);
  const enlargedRef = useRef(enlarged);
  enlargedRef.current = enlarged;

  useEffect(() => {
    const stopListening = listenToHost((data) => {
      const shown = parseFomodShown(data);
      if (shown) setState(shown.state);
    });
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (enlargedRef.current === undefined) send({ kind: 'cancel' });
      else setEnlarged(undefined);
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
      <Header state={state} />
      <Steps state={state} enlarge={setEnlarged} />
      {enlarged !== undefined && (
        <div
          role="dialog" aria-label={enlarged.name} onClick={() => setEnlarged(undefined)}
          style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(0, 0, 0, 0.8)', cursor: 'zoom-out' }}
        >
          <img src={enlarged.src} alt={enlarged.name} style={{ maxWidth: '95%', maxHeight: '95%' }} />
        </div>
      )}
    </>
  );
}
