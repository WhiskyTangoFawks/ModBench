using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Schema;

/// <summary>A header flag a new plugin may be created with, named as Mutagen's <c>IModFlags</c> does.</summary>
public readonly record struct HeaderFlag
{
    public static readonly HeaderFlag Master = new("Master");
    public static readonly HeaderFlag Small = new("Small");
    public static readonly HeaderFlag Medium = new("Medium");

    internal static IReadOnlyList<HeaderFlag> All { get; } = [Master, Small, Medium];

    private HeaderFlag(string name) => Name = name;

    internal string Name { get; }

    public override string ToString() => Name;
}

/// <summary>The header flag combinations xEdit offers a new file of an extension (wbLoadOrder.pas), each
/// keeping the flags its extension implies. The game's project says which styles its release has.</summary>
public static class CreatablePluginFlags
{
    public static IReadOnlyList<IReadOnlyList<HeaderFlag>> Of(GameRelease release, ModType type) =>
        GameCodecs.For(release).NewPluginFlags(release, type);

    /// <summary>The combinations for an extension, for a release whose smaller styles are <paramref name="styles"/>.
    /// <paramref name="flaggedEsp"/> is whether xEdit offers the .esp any flag at all.</summary>
    public static IReadOnlyList<IReadOnlyList<HeaderFlag>> Offered(ModType type, IReadOnlyList<HeaderFlag> styles, bool flaggedEsp) =>
        type switch
        {
            ModType.Plugin when flaggedEsp => [[], [HeaderFlag.Master], .. styles.SelectMany(style => new[] { new[] { style }, [HeaderFlag.Master, style] })],
            ModType.Plugin => [[]],
            ModType.Master => [[HeaderFlag.Master], .. styles.Select(style => new[] { HeaderFlag.Master, style })],
            ModType.Light => [[HeaderFlag.Master, HeaderFlag.Small]],
            _ => throw new ArgumentOutOfRangeException(nameof(type), type, null),
        };

    public static IEnumerable<IReadOnlyList<string>> Names(IEnumerable<IReadOnlyList<HeaderFlag>> combinations) =>
        combinations.Select(combination => (IReadOnlyList<string>)[.. combination.Select(flag => flag.ToString())]);

    /// <summary>The flags the names spell, exactly, or null when any name is no flag.</summary>
    public static IReadOnlySet<HeaderFlag>? Parse(IEnumerable<string> names)
    {
        var flags = new HashSet<HeaderFlag>();
        foreach (var name in names)
        {
            var flag = HeaderFlag.All.FirstOrDefault(known => known.Name == name);
            if (flag.Name is null) return null;
            flags.Add(flag);
        }

        return flags;
    }
}
