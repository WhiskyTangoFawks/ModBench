export interface PluginConditions {
  readonly tracked: boolean;
  readonly editable: boolean;
}

/** The contextValue of a row that stands for a record, which the manifest's `when` clauses parse:
 *  the kind, then whether its plugin is tracked and editable, then whether it holds children. */
export function conditionedContextValue(kind: string, conditions: PluginConditions, isContainer = false): string {
  return `${kind} ${conditions.tracked ? 'tracked' : 'untracked'}${conditions.editable ? ' editable' : ''}${isContainer ? ' container' : ''}`;
}
