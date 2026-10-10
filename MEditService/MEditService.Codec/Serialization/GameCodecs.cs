using System.Collections.Frozen;
using Mutagen.Bethesda;

namespace MEditService.Codec.Serialization;

/// <summary>The game projects the composition root registers, one per game category.</summary>
public static class GameCodecs
{
    private static FrozenDictionary<GameCategory, IGameCodec> _registered = FrozenDictionary<GameCategory, IGameCodec>.Empty;

    public static void Register(IReadOnlyDictionary<GameCategory, IGameCodec> games) =>
        _registered = games.ToFrozenDictionary();

    public static IGameCodec For(GameRelease release) => For(release.ToCategory());

    public static IGameCodec For(GameCategory category) =>
        _registered.TryGetValue(category, out var game)
            ? game
            : throw new NotSupportedException(
                $"No codec project for {category} is registered, so none of its plugins can be read or written.");
}
