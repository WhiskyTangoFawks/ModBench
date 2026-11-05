using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Meta;

namespace MEditService.Codec.Schema;

/// <summary>A header flag a new plugin may be created with, spelled as Mutagen's <c>IModFlags</c> does.</summary>
public enum HeaderBit
{
    Master,
    Small,
    Medium,
}

/// <summary>The header flag combinations xEdit offers a new file of an extension (wbLoadOrder.pas), each
/// keeping the flags its extension implies, for the styles Mutagen's GameConstants gives the release.</summary>
public static class CreatablePluginFlags
{
    public static IEnumerable<IReadOnlyList<string>> Names(IEnumerable<IReadOnlyList<HeaderBit>> combinations) =>
        combinations.Select(combination => (IReadOnlyList<string>)[.. combination.Select(bit => bit.ToString())]);

    public static IReadOnlyList<IReadOnlyList<HeaderBit>> Of(GameRelease release, ModType type)
    {
        var constants = GameConstants.Get(release);
        List<HeaderBit> styles = [];
        if (constants.SmallMasterFlag is not null) styles.Add(HeaderBit.Small);
        if (constants.MediumMasterFlag is not null) styles.Add(HeaderBit.Medium);
        return type switch
        {
            ModType.Plugin => [[], [HeaderBit.Master], .. styles.SelectMany(style => new[] { new[] { style }, [HeaderBit.Master, style] })],
            ModType.Master => [[HeaderBit.Master], .. styles.Select(style => new[] { HeaderBit.Master, style })],
            ModType.Light => [[HeaderBit.Master, HeaderBit.Small]],
            _ => throw new ArgumentOutOfRangeException(nameof(type), type, null),
        };
    }
}
