using MEditService.Core.Records;
using Mutagen.Bethesda;

namespace MEditService.Core.Plugins;

/// <summary>One registered plugin copy (ADR-0044): a physical file, its <c>plugins.txt</c> slot —
/// null when no line names it — and the two booleans Mod Management resolves for it.</summary>
public sealed record RegisteredCopy(string Name, string Origin, string Path, int? Slot, bool Enabled, bool Winning)
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
        Copies = copies;
    }

    /// <summary>The snapshot as it reaches the boundary: forced masters are prepended and every
    /// snapshot slot offset past them, so the value carries the registrations the Index does.</summary>
    public static LoadOrder From(
        string gameDirectory, string? instanceRoot, GameRelease gameRelease, IReadOnlyList<LoadOrderEntry> entries) =>
        new(gameDirectory, instanceRoot, gameRelease,
            [.. HeldPlugins.Resolve(gameDirectory, gameRelease, entries)
                .Select(r => new RegisteredCopy(
                    r.Name, r.Origin, r.Path, r.Registration.LoadOrderIndex, r.Registration.Enabled,
                    r.Registration.Winning))]);

    /// <summary>The copies a mirror holds, as the value — the bridge for callers still handed the
    /// held view rather than the snapshot.</summary>
    public static LoadOrder From(ILoadOrder held) =>
        new(held.DataFolderPath, held.InstanceRoot, held.GameRelease,
            [.. held.Plugins.Select(p => new RegisteredCopy(
                p.Name, p.Origin, p.Path, p.LoadOrderIndex, p.Enabled, p.Winning))]);

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

    /// <summary>ADR-0036: origin is required, not optional — the load order can register two copies
    /// of one filename, so the filename alone does not say which.</summary>
    public RegisteredCopy? Copy(PluginKey key) =>
        Copies.FirstOrDefault(c =>
            c.Name.Equals(key.Name, StringComparison.OrdinalIgnoreCase)
            && c.Origin.Equals(key.Origin, StringComparison.OrdinalIgnoreCase));

    // Structural, not a record's default: Copies is interface-typed, and its reference equality would
    // make two values built from one snapshot unequal.
    public bool Equals(LoadOrder? other) =>
        other is not null
        && GameRelease == other.GameRelease
        && string.Equals(DataFolderPath, other.DataFolderPath, StringComparison.OrdinalIgnoreCase)
        && string.Equals(InstanceRoot, other.InstanceRoot, StringComparison.OrdinalIgnoreCase)
        && Copies.SequenceEqual(other.Copies);

    public override bool Equals(object? obj) => Equals(obj as LoadOrder);

    public override int GetHashCode() => HashCode.Combine(DataFolderPath, InstanceRoot, GameRelease, Copies.Count);
}
