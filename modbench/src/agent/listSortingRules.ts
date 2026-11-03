import type { PluginsShown } from '../drivingLib/pluginsShown';

export const LIST_SORTING_RULES = {
  name: 'list_sorting_rules',
  description: 'The broken sorting rules the Plugins view shows under Sorting rules, each in its words, with its level (error, warning or info) and the plugins it names. '
    + 'A rule a move keeps also has suggestedMove: the plugin to move, and the plugin beside which it goes, on which side, in load order. '
    + 'Pass a rule\'s words as the rule option of apply suggested move, with that plugin as its argument.',
  of: (view: PluginsShown) => {
    const moves = view.suggestedMoves();
    return {
      rules: view.brokenRules().map(({ reason, level, plugins }) => {
        const move = moves.find(({ rule }) => rule.reason === reason);
        return {
          rule: reason, level, plugins: plugins.map(({ filename, origin }) => ({ name: filename, origin })),
          ...move && { suggestedMove: { plugin: move.mover, side: move.drop.kind, beside: move.drop.name } },
        };
      }),
    };
  },
};
