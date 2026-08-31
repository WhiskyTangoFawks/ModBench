using Mutagen.Bethesda;

namespace MEditService.Core.Schema;

// The per-game condition-codec registry (ADR-0032) — the single source DuckDbRecordIndex
// (read-side indexing), PluginWriter (write-back), and RecordQueryService (the function catalog)
// all resolve a game's IConditionCodec through, so registering a new game is one line here
// rather than three separately-maintained copies. An absent game simply has no condition support.
public static class ConditionCodecRegistry
{
    private static readonly Dictionary<GameCategory, Func<IConditionCodec>> Codecs = new()
    {
        [GameCategory.Fallout4] = static () => new Fallout4ConditionCodec(),
    };

    public static IConditionCodec? For(GameCategory category) =>
        Codecs.TryGetValue(category, out var make) ? make() : null;
}
