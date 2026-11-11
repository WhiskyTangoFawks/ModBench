import { Refusal } from '../drivingLib/refusal';
import type { PluginsShown } from '../drivingLib/pluginsShown';
import { FILTER, filterNarrows, fitting, holding } from './tooLarge';

export const LIST_SORTING_RULES = {
  name: 'list_sorting_rules',
  input: FILTER,
  of: (view: PluginsShown, { filter }: { filter?: string }) => {
    const notJudged = view.sortingNotJudged();
    if (notJudged !== undefined) throw new Refusal(`The sorting rules are not judged yet: ${notJudged}`);
    const moves = view.suggestedMoves();
    const held = holding(filter);
    return fitting({
      rules: view.brokenRules().filter(({ plugins }) => filter === undefined || plugins.some(({ filename }) => held(filename))).map((broken) => {
        const { reason, level, plugins } = broken;
        const move = moves.find(({ rule }) => rule === broken);
        return {
          rule: reason, level, plugins: plugins.map(({ filename, origin }) => ({ name: filename, origin })),
          ...move && { suggestedMove: { plugin: move.mover, side: move.drop.kind, beside: move.drop.name } },
        };
      }),
    }, (all) => filterNarrows({ rules: all.rules.length }, 'the rules that name a plugin whose name holds it'));
  },
};
