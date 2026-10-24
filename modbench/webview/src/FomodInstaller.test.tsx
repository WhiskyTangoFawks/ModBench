import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./vscode', () => ({ fomodHost: { postMessage: vi.fn() } }));

import { FomodInstallerView } from './FomodInstaller';
import { fomodHost } from './vscode';
import { FOMOD_MOVE, FOMOD_READY, FOMOD_STATE, type FomodGroup, type FomodOption, type FomodState, type FomodStep } from '../../src/wire/fomodPage';

const option = (id: number, name: string, over: Partial<FomodOption> = {}): FomodOption =>
  ({ id, selected: false, name, description: '', image: '', type: 'Optional', ...over });

const group = (id: number, name: string, type: FomodGroup['type'], ...options: FomodOption[]): FomodGroup => ({ id, name, type, options });

const step = (id: number, name: string, visible: boolean, ...groups: FomodGroup[]): FomodStep =>
  ({ id, name, visible, optionalFileGroups: { group: groups } });

const HEADER = { module: 'My Module', author: '', version: '', website: '', image: '' };

const show = (steps: FomodStep[], current = 0, header: Partial<FomodState> = {}): void => {
  const state: FomodState = { ...HEADER, ...header, steps, current };
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: { type: FOMOD_STATE, state } })); });
};

const sent = () => vi.mocked(fomodHost.postMessage).mock.calls.map(([message]) => message);

beforeEach(() => {
  vi.mocked(fomodHost.postMessage).mockClear();
  render(<FomodInstallerView />);
});

describe('the FOMOD installer page', () => {
  it('tells the host it is ready, and shows nothing until the installer sends a state', () => {
    expect(sent()).toEqual([{ type: FOMOD_READY }]);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the module\'s name, and Install alone for an installer with no step to see', () => {
    show([]);

    expect(screen.getByRole('heading', { name: 'My Module' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(sent().at(-1)).toEqual({ type: FOMOD_MOVE, move: { kind: 'continue', forward: true, stepId: 0 } });
  });

  it('reads Next until the last step it can see, and Install there', () => {
    const steps = [step(0, 'One', true), step(1, 'Two', false), step(2, 'Three', true)];

    show(steps, 0);
    expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument();

    show(steps, 2);
    expect(screen.getByRole('button', { name: 'Install' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
  });

  it('sends Back as a move back from the step it is on', () => {
    show([step(0, 'One', true), step(1, 'Two', true)], 1);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(sent().at(-1)).toEqual({ type: FOMOD_MOVE, move: { kind: 'continue', forward: false, stepId: 1 } });
  });

  it('shows a one-pick group as radio buttons and a many-pick group as check boxes, ticked as the engine has them', () => {
    show([step(0, 'One', true,
      group(0, 'Pick', 'SelectExactlyOne', option(0, 'A', { selected: true }), option(1, 'B')),
      group(1, 'Extras', 'SelectAny', option(0, 'C', { selected: true }), option(1, 'D')))]);

    expect(screen.getByRole('radio', { name: 'A' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'B' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'C' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'D' })).not.toBeChecked();
  });

  it('sends the group\'s whole selection when an option is clicked', () => {
    show([step(0, 'One', true,
      group(0, 'Pick', 'SelectExactlyOne', option(0, 'A', { selected: true }), option(1, 'B')),
      group(1, 'Extras', 'SelectAny', option(0, 'C', { selected: true }), option(1, 'D')))]);

    fireEvent.click(screen.getByRole('radio', { name: 'B' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'D' }));

    expect(sent().slice(1)).toEqual([
      { type: FOMOD_MOVE, move: { kind: 'select', stepId: 0, groupId: 0, optionIds: [1] } },
      { type: FOMOD_MOVE, move: { kind: 'select', stepId: 0, groupId: 1, optionIds: [0, 1] } },
    ]);
  });

  it('disables a required option, an unusable one, and every option of a group that takes all', () => {
    show([step(0, 'One', true,
      group(0, 'Mixed', 'SelectAny', option(0, 'Req', { type: 'Required' }), option(1, 'Nope', { type: 'NotUsable' }), option(2, 'Free')),
      group(1, 'All', 'SelectAll', option(0, 'X'), option(1, 'Y')))]);

    expect(['Req', 'Nope', 'X', 'Y', 'Free'].map((name) => screen.getByRole('checkbox', { name }).hasAttribute('disabled'))).toEqual([true, true, true, true, false]);
    expect(screen.getByRole('checkbox', { name: 'Req' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'X' })).toBeChecked();
  });

  it('shows a not usable option unticked though the engine selected it', () => {
    show([step(0, 'One', true, group(0, 'Any', 'SelectAny', option(0, 'Nope', { type: 'NotUsable', selected: true })))]);

    expect(screen.getByRole('checkbox', { name: 'Nope' })).not.toBeChecked();
  });

  it('disables every option of a one-pick group that holds a required option', () => {
    show([step(0, 'One', true, group(0, 'Pick', 'SelectExactlyOne', option(0, 'Req', { type: 'Required' }), option(1, 'Other')))]);

    expect(['Req', 'Other'].map((name) => screen.getByRole('radio', { name }).hasAttribute('disabled'))).toEqual([true, true]);
  });

  it('takes the lone option of a group that wants a pick as required', () => {
    show([step(0, 'One', true, group(0, 'Pick', 'SelectExactlyOne', option(0, 'Only')))]);

    expect(screen.getByRole('checkbox', { name: 'Only' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Only' })).toBeDisabled();
  });

  it('sends the selection without an option that is unticked', () => {
    show([step(0, 'One', true, group(0, 'Extras', 'SelectAny', option(0, 'C', { selected: true }), option(1, 'D', { selected: true })))]);

    fireEvent.click(screen.getByRole('checkbox', { name: 'C' }));

    expect(sent().at(-1)).toEqual({ type: FOMOD_MOVE, move: { kind: 'select', stepId: 0, groupId: 0, optionIds: [1] } });
  });

  it('offers Back only after a step it can see', () => {
    show([step(0, 'Hidden', false), step(1, 'One', true), step(2, 'Two', true)], 1);
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();

    show([step(0, 'Hidden', false), step(1, 'One', true), step(2, 'Two', true)], 2);
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
  });

  it('adds None to a group that takes at most one, ticked while no option is, and sends an empty selection for it', () => {
    show([step(0, 'One', true, group(0, 'Pick', 'SelectAtMostOne', option(0, 'A'), option(1, 'B')))]);

    expect(screen.getByRole('radio', { name: 'None' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'A' }));
    show([step(0, 'One', true, group(0, 'Pick', 'SelectAtMostOne', option(0, 'A', { selected: true }), option(1, 'B')))]);
    fireEvent.click(screen.getByRole('radio', { name: 'None' }));

    expect(sent().slice(1)).toEqual([
      { type: FOMOD_MOVE, move: { kind: 'select', stepId: 0, groupId: 0, optionIds: [0] } },
      { type: FOMOD_MOVE, move: { kind: 'select', stepId: 0, groupId: 0, optionIds: [] } },
    ]);
  });

  it('refuses Next, naming the group, while a group that needs a pick has none, and allows it once it has one', () => {
    show([step(0, 'One', true, group(0, 'Needs one', 'SelectAtLeastOne', option(0, 'A'), option(1, 'B')), group(1, 'Takes one', 'SelectExactlyOne', option(0, 'C'), option(1, 'D'))), step(1, 'Two', true)]);

    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toBeDisabled();
    expect(next).toHaveAttribute('title', expect.stringContaining('Needs one'));
    expect(next).toHaveAttribute('title', expect.not.stringContaining('Takes one'));

    show([step(0, 'One', true, group(0, 'Needs one', 'SelectAtLeastOne', option(0, 'A', { selected: true }), option(1, 'B'))), step(1, 'Two', true)]);
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it.each([
    ['Manual', () => fireEvent.click(screen.getByRole('button', { name: 'Manual' })), { kind: 'manual' }],
    ['Cancel', () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })), { kind: 'cancel' }],
    ['Esc', () => fireEvent.keyDown(window, { key: 'Escape' }), { kind: 'cancel' }],
  ])('sends %s', (_, act_, move) => {
    show([step(0, 'One', true)]);

    act_();

    expect(sent().at(-1)).toEqual({ type: FOMOD_MOVE, move });
  });

  describe('the header', () => {
    it('shows the author, the version and the header image the FOMOD gives', () => {
      show([], 0, { author: 'Ada', version: '1.2', image: 'img://header.png' });

      expect(screen.getByText(/Ada/)).toBeInTheDocument();
      expect(screen.getByText(/1\.2/)).toBeInTheDocument();
      expect(screen.getByRole('img', { name: 'My Module' })).toHaveAttribute('src', 'img://header.png');
    });

    it('shows a website as a link named Link, with the address as its tooltip, and a website that is no web address as text', () => {
      show([], 0, { website: 'https://example.com/mod' });
      expect(screen.getByRole('link', { name: 'Link' })).toHaveAttribute('href', 'https://example.com/mod');
      expect(screen.getByRole('link', { name: 'Link' })).toHaveAttribute('title', 'https://example.com/mod');

      show([], 0, { website: 'javascript:alert(1)' });
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(screen.getByText(/javascript:alert\(1\)/)).toBeInTheDocument();
    });

    it('shows no image and no field the FOMOD leaves out', () => {
      show([]);

      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      expect(screen.queryByText(/Author|Version|Website/)).not.toBeInTheDocument();
    });
  });

  describe('an option\'s description and image', () => {
    const described = () => show([step(0, 'One', true, group(0, 'Pick', 'SelectAny',
      option(0, 'A', { description: 'About A', image: 'img://a.png' }), option(1, 'B', { description: 'About B' })))]);

    it('shows the first option\'s description and image when a step opens, and the first of the next step when it opens', () => {
      described();
      expect(screen.getByText('About A')).toBeInTheDocument();

      fireEvent.focus(screen.getByRole('checkbox', { name: 'B' }));
      show([step(1, 'Two', true, group(0, 'Pick', 'SelectAny', option(0, 'C', { description: 'About C' })))], 0);

      expect(screen.getByText('About C')).toBeInTheDocument();
    });

    it('shows the first option again when the user comes back to a step', () => {
      const steps = [
        step(0, 'One', true, group(0, 'Pick', 'SelectAny', option(0, 'A', { description: 'About A' }), option(1, 'B', { description: 'About B' }))),
        step(1, 'Two', true),
      ];
      show(steps, 0);
      fireEvent.focus(screen.getByRole('checkbox', { name: 'B' }));

      show(steps, 1);
      show(steps, 0);

      expect(screen.getByText('About A')).toBeInTheDocument();
    });

    it('shows the description and image of the option under the pointer, and then of the one with focus', () => {
      described();

      fireEvent.mouseEnter(screen.getByText('A'));
      expect(screen.getByText('About A')).toBeInTheDocument();
      expect(screen.getByRole('img', { name: 'A' })).toHaveAttribute('src', 'img://a.png');

      fireEvent.focus(screen.getByRole('checkbox', { name: 'B' }));
      expect(screen.getByText('About B')).toBeInTheDocument();
      expect(screen.queryByText('About A')).not.toBeInTheDocument();
      expect(screen.queryByRole('img', { name: 'A' })).not.toBeInTheDocument();
    });

    it('opens the image larger on a click, and closes it on a click or Esc, which then does not cancel', () => {
      described();
      fireEvent.focus(screen.getByRole('checkbox', { name: 'A' }));

      fireEvent.click(screen.getByRole('img', { name: 'A' }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(sent()).toEqual([{ type: FOMOD_READY }]);

      fireEvent.click(screen.getByRole('img', { name: 'A' }));
      fireEvent.click(screen.getByRole('dialog'));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});
