import { Refusal } from '../drivingLib/refusal';
import type { PluginsShown } from '../drivingLib/pluginsShown';

export const LIST_SORTING_RULES = {
  name: 'list_sorting_rules',
  of: (view: PluginsShown) => {
    const notJudged = view.sortingNotJudged();
    if (notJudged !== undefined) throw new Refusal(`The sorting rules are not judged yet: ${notJudged}`);
    const moves = view.suggestedMoves();
    return {
      rules: view.brokenRules().map((broken) => {
        const { reason, level, plugins } = broken;
        const move = moves.find(({ rule }) => rule === broken);
        return {
          rule: reason, level, plugins: plugins.map(({ filename, origin }) => ({ name: filename, origin })),
          ...move && { suggestedMove: { plugin: move.mover, side: move.drop.kind, beside: move.drop.name } },
        };
      }),
    };
  },
};
