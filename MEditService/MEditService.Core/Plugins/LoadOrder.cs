using MEditService.Core.Records;
using Mutagen.Bethesda;

namespace MEditService.Core.Plugins;

/// <summary>One registered plugin copy (ADR-0044): a physical file, its <c>plugins.txt</c> slot —
/// null when no line names it — and the booleans Mod Management resolves for it. IsForced: loaded
/// regardless of that list.</summary>
public sealed record RegisteredCopy(
    string Name, string Origin, string Path, int? Slot, bool Enabled, bool Winning, bool IsForced = false)
{
    public PluginKey Key => new(Name, Origin);

    public Registration Registration => new(Slot, Enabled, Winning);
}

/// <summary>ADR-0046 invariant 11: the load order is state, sent by Mod Management, held in the
/// shared kernel with ADR-0044's rules, read by both sides. Immutable — nothing here opens, holds or
/// disposes a plugin file.</summary>
public sealed class LoadOrder : IEquatable<LoadOrder>
{
    /// <summary>No snapshot has arrived.</summary>
    public static readonly LoadOrder Empty = new(string.Empty, null, default, []);

    public string DataFolderPath { get; }

    /// <summary>ADR-0001: the MO2 instance root the index file is keyed on, because <c>origin</c> is
    /// a mod folder name and so is unique only within one instance.</summary>
    public string? InstanceRoot { get; }

    public GameRelease GameRelease { get; }

    /// <summary>Every physical copy in the instance, forced masters first (ADR-0044: losing and
    /// unlisted copies are registered like any other).</summary>
    public IReadOnlyList<RegisteredCopy> Copies { get; }

    public LoadOrder(
        string dataFolderPath, string? instanceRoot, GameRelease gameRelease, IReadOnlyList<RegisteredCopy> copies)
    {
        DataFolderPath = dataFolderPath;
        InstanceRoot = instanceRoot;
        GameRelease = gameRelease;
        // Copied, not aliased: a caller keeping its list would otherwise mutate this value.
        Copies = [.. copies];
    }

    /// <summary>The snapshot as it reaches the boundary: forced masters are prepended and every
    /// snapshot slot offset past them, so the value carries the registrations the Index does.</summary>
    public static LoadOrder From(
        string gameDirectory, string? instanceRoot, GameRelease gameRelease, IReadOnlyList<LoadOrderEntry> entries) =>
        new(gameDirectory, instanceRoot, gameRelease, HeldPlugins.Resolve(gameDirectory, gameRelease, entries));

    /// <summary>The held copies as the value: what the Index projects its live view back into, for
    /// every caller that reads the load order rather than opening a copy.</summary>
    public static LoadOrder From(ILoadOrder held) =>
        new(held.DataFolderPath, held.InstanceRoot, held.GameRelease,
            [.. held.Plugins.Select(p => new RegisteredCopy(
                p.Name, p.Origin, p.Path, p.LoadOrderIndex, p.Enabled, p.Winning, p.IsForced))]);

    /// <summary>ADR-0044: participation is derived, never stored — enabled, winning, and named by a
    /// <c>plugins.txt</c> line. Only a participating copy competes for winner or counts in a
    /// conflict.</summary>
    public bool Participates(PluginKey key) => Copy(key)?.Registration.Participates ?? false;

    /// <summary>The copy the Mod override order resolves <paramref name="name"/> to, or null when no
    /// registered copy of that name wins.</summary>
    public RegisteredCopy? WinningCopy(string name) =>
        Copies.FirstOrDefault(c => c.Winning && c.Name.Equals(name, StringComparison.OrdinalIgnoreCase));

    /// <summary>The participating copies in slot order — the load order the game actually has.</summary>
    public IReadOnlyList<RegisteredCopy> Participating =>
        [.. Copies.Where(c => c.Registration.Participates).OrderBy(c => c.Slot!.Value)];

    /// <summary>The three facts one copy is registered with, or null when it is not registered.</summary>
    public Registration? Registration(PluginKey key) => Copy(key)?.Registration;

    /// <summary>This load order with one more registered copy, replacing any copy already
    /// registered under the same identity (ADR-0041: a created plugin is a member at once).</summary>
    public LoadOrder With(RegisteredCopy copy) =>
        new(DataFolderPath, InstanceRoot, GameRelease, [.. Copies.Where(c => !SameKey(c, copy.Key)), copy]);

    /// <summary>ADR-0036: origin is required, not optional — the load order can register two copies
    /// of one filename, so the filename alone does not say which.</summary>
    public RegisteredCopy? Copy(PluginKey key) => Copies.FirstOrDefault(c => SameKey(c, key));

    private static bool SameKey(RegisteredCopy copy, PluginKey key) =>
        copy.Name.Equals(key.Name, StringComparison.OrdinalIgnoreCase)
        && copy.Origin.Equals(key.Origin, StringComparison.OrdinalIgnoreCase);

    // Structural, not a record's default: Copies is interface-typed, and its reference equality would
    // make two values built from one snapshot unequal.
    public bool Equals(LoadOrder? other) =>
        other is not null
        && GameRelease == other.GameRelease
        && string.Equals(DataFolderPath, other.DataFolderPath, StringComparison.OrdinalIgnoreCase)
        && string.Equals(InstanceRoot, other.InstanceRoot, StringComparison.OrdinalIgnoreCase)
        && Copies.SequenceEqual(other.Copies);

    public override bool Equals(object? obj) => Equals(obj as LoadOrder);

    // The same comparer Equals uses for each half, or two equal values could hash apart.
    public override int GetHashCode() => HashCode.Combine(
        StringComparer.OrdinalIgnoreCase.GetHashCode(DataFolderPath),
        InstanceRoot is null ? 0 : StringComparer.OrdinalIgnoreCase.GetHashCode(InstanceRoot),
        GameRelease,
        Copies.Count);
}
