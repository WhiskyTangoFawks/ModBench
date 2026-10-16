using Mutagen.Bethesda;
using Mutagen.Bethesda.Strings;
// Where a judgement sees a plugin. One that is not active sits just before the active plugin with as
// many active plugins before it, as false orders before true.
using Place = (int ActivePluginsBefore, bool IsActive);

namespace MEditService.LoadOrder;

/// <summary>One plugin file in the instance (ADR-0013). <paramref name="Line"/>: the <c>plugins.txt</c> line
/// naming its filename, null when no line names it.</summary>
public sealed record RegisteredPlugin(string Name, string Origin, string Path, PluginProvider Provider, PluginLine? Line, PluginStrings Strings)
{
    public PluginAddress Key => new(Name, Origin);
}

/// <summary>A file at <paramref name="Path"/> with the stamp Mod Management read of it, which changes as its content
/// does (ADR-0003, ADR-0013).</summary>
public sealed record StampedFile(string Path, string Stamp)
{
    public bool Equals(StampedFile? other) =>
        other is not null && string.Equals(Path, other.Path, StringComparison.OrdinalIgnoreCase) && string.Equals(Stamp, other.Stamp, StringComparison.Ordinal);

    public override int GetHashCode() => HashCode.Combine(StringComparer.OrdinalIgnoreCase.GetHashCode(Path), Stamp);
}

internal static class StampedFiles
{
    /// <summary>The stamp handed with the file at <paramref name="path"/>, or null when none is at it.</summary>
    internal static string? StampIn(this IEnumerable<StampedFile> files, string path) =>
        files.FirstOrDefault(handed => string.Equals(handed.Path, path, StringComparison.OrdinalIgnoreCase))?.Stamp;
}

/// <summary>The strings files beside one copy of a plugin, loose, and the archives named for it in its folder,
/// in the order they are read. Mod Management finds them (ADR-0013).</summary>
public sealed record PluginStrings(IReadOnlyList<StampedFile> Archives, IReadOnlyList<StampedFile> StringsFiles)
{
    public static readonly PluginStrings None = new([], []);

    // Copied, not aliased: a caller keeping its list would otherwise mutate this value.
    public IReadOnlyList<StampedFile> Archives { get; } = [.. Archives];

    public IReadOnlyList<StampedFile> StringsFiles { get; } = [.. StringsFiles];

    /// <summary>The stamp handed with the file at <paramref name="path"/>, or null when none of these is at it.</summary>
    public string? StampOf(string path) => Archives.Concat(StringsFiles).StampIn(path);

    public bool Equals(PluginStrings? other) =>
        other is not null && Archives.SequenceEqual(other.Archives) && StringsFiles.SequenceEqual(other.StringsFiles);

    public override int GetHashCode() => HashCode.Combine(Archives.Count, StringsFiles.Count);
}

/// <summary>A <c>plugins.txt</c> line's place, and whether it names this copy of its filename: the copy Mod
/// Management resolves the name to (ADR-0013).</summary>
public readonly record struct PluginLine(int Place, bool NamesIt);

/// <summary>ADR-0013's snapshot. Immutable: nothing here opens, holds or disposes a
/// plugin file.</summary>
public sealed class LoadOrderSnapshot : IEquatable<LoadOrderSnapshot>
{
    /// <summary>No snapshot has arrived.</summary>
    internal static readonly LoadOrderSnapshot Empty = new(string.Empty, null, default, [], [], [], [], [], [], Language.English);

    private readonly Dictionary<PluginAddress, int> _loadOrderIndex;

    private readonly Dictionary<PluginAddress, Place> _places;

    public string DataFolderPath { get; }

    /// <summary>One index file per instance, inside the instance root (ADR-0010).</summary>
    public string? InstanceRoot { get; }

    public GameRelease GameRelease { get; }

    /// <summary>Every plugin file in the instance, in the order it was given.</summary>
    public IReadOnlyList<RegisteredPlugin> Plugins { get; }

    /// <summary>The plugins whose address another plugin's differs from only in case. Nothing can
    /// tell which of them the game loads, so they are in none of the other lists. Linux can hold such
    /// a pair; Windows cannot.</summary>
    public IReadOnlyList<RegisteredPlugin> CaseOnlyCollisions { get; }

    /// <summary>The active plugins, in load order (ADR-0013).</summary>
    public IReadOnlyList<RegisteredPlugin> Active { get; }

    /// <summary>The plugins Mod Management loads with no line: the game's own, a DLC's or a Creation
    /// Club plugin.</summary>
    public IReadOnlyList<RegisteredPlugin> LoadedWithNoLine { get; }

    /// <summary>The archive files the game loads, in the order it loads them, each at the path that wins
    /// (ADR-0013). A later archive's file replaces an earlier one's.</summary>
    public IReadOnlyList<StampedFile> Archives { get; }

    /// <summary>The loose strings files the game reads, each at the path that wins (ADR-0013). One beats
    /// every archive's copy.</summary>
    public IReadOnlyList<StampedFile> StringsFiles { get; }

    /// <summary>Where a new plugin can live, whether or not the place holds a plugin yet.</summary>
    public IReadOnlyList<PluginPlace> Places { get; }

    /// <summary>The language a translated text shows in.</summary>
    public Language StringsLanguage { get; }

    public LoadOrderSnapshot(
        string dataFolderPath, string? instanceRoot, GameRelease gameRelease, IReadOnlyList<RegisteredPlugin> plugins,
        IReadOnlyList<PluginAddress> active, IReadOnlyList<PluginAddress> loadedWithNoLine, IReadOnlyList<StampedFile> archives,
        IReadOnlyList<StampedFile> stringsFiles, IReadOnlyList<PluginPlace> places, Language stringsLanguage)
    {
        if (RefusalOf(plugins, active, loadedWithNoLine) is { } refusal) throw new ArgumentException(refusal);
        DataFolderPath = dataFolderPath;
        InstanceRoot = instanceRoot;
        GameRelease = gameRelease;
        CaseOnlyCollisions =
        [
            .. plugins.GroupBy(p => p.Key, PluginAddress.Comparer).Where(group => group.Count() > 1).SelectMany(group => group),
        ];
        var colliding = CaseOnlyCollisions.Select(p => p.Key).ToHashSet(PluginAddress.Comparer);
        // Copied, not aliased: a caller keeping its list would otherwise mutate this value.
        Plugins = [.. plugins.Where(p => !colliding.Contains(p.Key))];
        active = [.. active.Where(a => !colliding.Contains(a))];
        _loadOrderIndex = active.Select((address, index) => (address, index))
            .ToDictionary(a => a.address, a => a.index, PluginAddress.Comparer);
        Active = [.. active.Select(PluginRefusalOfVouchesFor)];
        LoadedWithNoLine = [.. loadedWithNoLine.Where(a => !colliding.Contains(a)).Select(PluginRefusalOfVouchesFor)];
        _places = PlacesOf(Plugins, Active, LoadedWithNoLine);
        Archives = [.. archives];
        StringsFiles = [.. stringsFiles];
        Places = [.. places];
        StringsLanguage = stringsLanguage;
    }

    // A plugin with no line that is not active has no place.
    private static Dictionary<PluginAddress, Place> PlacesOf(
        IReadOnlyList<RegisteredPlugin> plugins, IReadOnlyList<RegisteredPlugin> active, IReadOnlyList<RegisteredPlugin> loadedWithNoLine)
    {
        var places = active.Select((plugin, index) => (plugin.Key, Place: (index, true)))
            .ToDictionary(a => a.Key, a => (Place)a.Place, PluginAddress.Comparer);
        var activeLines = active.Select(plugin => loadedWithNoLine.Contains(plugin) ? int.MinValue : plugin.Line?.Place ?? int.MaxValue).ToList();
        foreach (var plugin in plugins)
        {
            if (plugin.Line is { Place: var line }) places.TryAdd(plugin.Key, (activeLines.Count(activeLine => activeLine <= line), false));
        }
        return places;
    }

    private RegisteredPlugin PluginRefusalOfVouchesFor(PluginAddress address) => Plugin(address)
        ?? throw new InvalidOperationException($"Expected RefusalOf to have refused {address.Name} from {address.Origin}.");

    /// <summary>Why these plugins and active plugins make no snapshot, or null when they do. The
    /// game loads one file per name, and a FormID or a winner is read by filename.</summary>
    public static string? RefusalOf(
        IReadOnlyList<RegisteredPlugin> plugins, IReadOnlyList<PluginAddress> active, IReadOnlyList<PluginAddress> loadedWithNoLine)
    {
        var sent = plugins.Select(p => p.Key).ToHashSet(PluginAddress.Comparer);
        string? StrayIn(IReadOnlyList<PluginAddress> named) =>
            named.Where(a => !sent.Contains(a)).Select(a => $"{a.Name} from {a.Origin}").FirstOrDefault();
        if (StrayIn(active) is { } stray) return $"The active plugin {stray} is not a plugin in the snapshot.";
        if (StrayIn(loadedWithNoLine) is { } unlined)
            return $"The plugin loaded with no line {unlined} is not a plugin in the snapshot.";

        var contested = active
            .GroupBy(a => a.Name, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault(g => g.Count() > 1);
        return contested is null
            ? null
            : $"The snapshot names more than one active {contested.Key}: " +
              $"{string.Join(", ", contested.Select(a => a.Origin))}. The game loads one file per name.";
    }

    /// <summary>The plugin's place among the active plugins, or null when it is not active.</summary>
    public int? LoadOrderIndex(PluginAddress address) =>
        _loadOrderIndex.TryGetValue(address, out var index) ? index : null;

    /// <summary>Whether <paramref name="plugin"/> loads before <paramref name="other"/>. A plugin that is
    /// not active is judged at its <c>plugins.txt</c> line; with none, null (commands.md § Principles).</summary>
    public bool? LoadsBefore(PluginAddress plugin, PluginAddress other) =>
        _places.TryGetValue(plugin, out var place) && _places.TryGetValue(other, out var otherPlace) ? place.CompareTo(otherPlace) < 0 : null;

    /// <summary>The copy of each filename a judgement reads, the active one or the one its line names, in the
    /// order <see cref="InJudgedOrder"/> gives.</summary>
    public IEnumerable<RegisteredPlugin> JudgedCopies() =>
        InJudgedOrder().Where(plugin => _loadOrderIndex.ContainsKey(plugin.Key) || plugin.Line is { NamesIt: true });

    /// <summary>Every plugin in the order <see cref="LoadsBefore"/> judges, those it does not judge last.</summary>
    public IEnumerable<RegisteredPlugin> InJudgedOrder() =>
        Plugins.Where(plugin => _places.ContainsKey(plugin.Key)).OrderBy(plugin => _places[plugin.Key])
            .Concat(Plugins.Where(plugin => !_places.ContainsKey(plugin.Key)));

    /// <summary>Whether the copy at <paramref name="path"/> is the one the game resolves its filename to, whose strings the
    /// game's lists hold: the copy its line names, or one loaded with no line.</summary>
    public bool ReadsTheGamesStrings(string path) =>
        Plugins.FirstOrDefault(p => string.Equals(p.Path, path, StringComparison.Ordinal)) is { } copy
        && (copy.Line is { NamesIt: true } || LoadedWithNoLine.Contains(copy));

    /// <summary>The stamp handed with the game's archive or loose strings file at <paramref name="path"/>, or null when the
    /// game reads none at it.</summary>
    public string? StampOf(string path) => Archives.Concat(StringsFiles).StampIn(path);

    /// <summary>What provides the plugin, or null for a plugin none registered here names.</summary>
    public PluginProvider? ProviderOf(PluginAddress plugin) => Plugin(plugin)?.Provider;

    /// <summary>By identity, origin and filename together (ADR-0012).</summary>
    public RegisteredPlugin? Plugin(PluginAddress address) =>
        Plugins.FirstOrDefault(c => PluginAddress.Comparer.Equals(c.Key, address));

    // Structural, not a record's default: the lists are interface-typed, and their reference
    // equality would make two values built from one snapshot unequal.
    public bool Equals(LoadOrderSnapshot? other) =>
        other is not null
        && GameRelease == other.GameRelease
        && string.Equals(DataFolderPath, other.DataFolderPath, StringComparison.OrdinalIgnoreCase)
        && string.Equals(InstanceRoot, other.InstanceRoot, StringComparison.OrdinalIgnoreCase)
        && Plugins.SequenceEqual(other.Plugins)
        && CaseOnlyCollisions.SequenceEqual(other.CaseOnlyCollisions)
        && Active.SequenceEqual(other.Active)
        && LoadedWithNoLine.SequenceEqual(other.LoadedWithNoLine)
        && Archives.SequenceEqual(other.Archives)
        && StringsFiles.SequenceEqual(other.StringsFiles)
        && Places.SequenceEqual(other.Places)
        && StringsLanguage == other.StringsLanguage;

    public override bool Equals(object? obj) => Equals(obj as LoadOrderSnapshot);

    // The same comparer Equals uses for each half, or two equal values could hash apart.
    public override int GetHashCode() => HashCode.Combine(
        StringComparer.OrdinalIgnoreCase.GetHashCode(DataFolderPath),
        InstanceRoot is null ? 0 : StringComparer.OrdinalIgnoreCase.GetHashCode(InstanceRoot),
        GameRelease,
        Plugins.Count,
        Active.Count);
}
