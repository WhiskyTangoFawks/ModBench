import React from 'react';
import { flagNames, flagsValue } from './modelValue';
import { DIMMED_OPACITY } from './gridStyles';
import type { TemplateReading } from './recordRows';
import type { FieldMetadata } from './types';

interface FlagCellProps {
  value: unknown;
  meta: FieldMetadata;
  // The flags now set, as the member spells them. Optional: a caller with nowhere to
  // write renders read-only rather than crashing.
  onCommit?: (v: unknown) => void;
  // The row's collapse state (the grid's chevron/double-click gesture, owned by the row —
  // all columns collapse together): collapsed shows the compact set-name summary, xEdit's own
  // at-rest render.
  collapsed?: boolean;
  // The flags the game fills from a template: each reads from its template, dimmed, in place of its
  // check box, and a toggle of another flag leaves it as the document has it (editor-fields.md, Templated fields).
  templated?: Readonly<Record<string, TemplateReading>>;
}

/** A `flags` member's checkbox list (xedit.md, divergence 5). There is no text state and nothing
 *  to open, so F2 is inert. */
export function FlagCell({ value, meta, onCommit, collapsed, templated = {} }: FlagCellProps) {
  // Absent means default: no names set.
  const names = flagNames(value, meta);

  if (collapsed) {
    const own = names.filter(name => !templated[name]);
    const fromTemplate = meta.enumMembers.filter(({ value: name }) => templated[name]).map(({ value: name }) => `${name} ${templated[name]?.reading}`);
    return <span>{[...own, ...fromTemplate].join(', ')}</span>;
  }

  // editor.md, Columns, story 4: a cell that cannot be written reads as one that can, and a click on
  // it changes nothing. A name the metadata does not list stays where the document put it.
  const toggle = (name: string) => {
    if (onCommit) onCommit(flagsValue(names.includes(name) ? names.filter(n => n !== name) : [...names, name], meta));
  };

  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {meta.enumMembers.map(({ value: name }) => templated[name] ? (
        <span key={name} title={templated[name].tooltip} style={{ opacity: DIMMED_OPACITY }}>{name} <span>{templated[name].reading}</span></span>
      ) : (
        <label key={name} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <input
            type="checkbox"
            className="vscode-checkbox"
            checked={names.includes(name)}
            onChange={() => toggle(name)}
          />
          {name}
        </label>
      ))}
    </span>
  );
}
