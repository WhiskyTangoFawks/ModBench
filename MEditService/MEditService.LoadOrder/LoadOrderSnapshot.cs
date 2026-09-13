using Mutagen.Bethesda;

namespace MEditService.LoadOrder;

/// <summary>One registered plugin copy (ADR-0013): a physical file, its <c>plugins.txt</c> slot —
/// null when no line names it — and the booleans Mod Management resolves for it. IsForced: loaded
/// regardless of that list.</summary>
public sealed record RegisteredCopy(
    string Name, string Origin, string Path, int? Slot, bool Enabled, bool Winning, bool IsForced = false)
{
    public PluginKey Key => new(Name, Origin);

    public Registration Registration => new(Slot, Enabled, Winning);

    /// <summary>Read-only for editing: a forced master (ADR-0012 — the game's own files are never
    /// a write target), or a copy the load order does not name, where editing changes nothing.
    /// </summary>
    public bool IsImmutable => IsForced || !Registration.InLoadOrder;

    public static RegisteredCopy Of(LoadOrderEntry entry, int slotOffset = 0) =>
        new(entry.Name, entry.Origin, entry.Path,
            entry.Slot is { } slot ? slotOffset + slot : null, entry.Enabled, entry.Winning);
}

/// <summary>ADR-0013 invariant 4: the load order is state, sent by Mod Management, held in the
/// shared kernel with ADR-0013's rules, read by both sides. Immutable — nothing here opens, holds or
/// disposes a plugin file.</summary>
public sealed class LoadOrderSnapshot : IEquatable<LoadOrderSnapshot>
{
    /// <summary>No snapshot has arrived.</summary>
    public static readonly LoadOrderSnapshot Empty = new(string.Empty, null, default, []);

    public string DataFolderPath { get; }

    /// <summary>ADR-0009: the MO2 instance root the index file is keyed on, because <c>origin</c> is
    /// a mod folder name and so is unique only within one instance.</summary>
    public string? InstanceRoot { get; }

    public GameRelease GameRelease { get; }

    /// <summary>Every physical copy in the instance, in the order it was given (ADR-0013: losing
    /// and unlisted copies are registered like any other).</summary>
    public IReadOnlyList<RegisteredCopy> Copies { get; }

    public LoadOrderSnapshot(
        string dataFolderPath, string? instanceRoot, GameRelease gameRelease, IReadOnlyList<RegisteredCopy> copies)
    {
        DataFolderPath = dataFolderPath;
        InstanceRoot = instanceRoot;
        GameRelease = gameRelease;
        // Copied, not aliased: a caller keeping its list would otherwise mutate this value.
        Copies = [.. copies];
    }

    /// <summary>ADR-0013: participation is derived, never stored — enabled, winning, and named by a
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
    /// registered under the same identity (ADR-0007: a created plugin is a member at once).</summary>
    public LoadOrderSnapshot With(RegisteredCopy copy) =>
        new(DataFolderPath, InstanceRoot, GameRelease, [.. Copies.Where(c => !SameKey(c, copy.Key)), copy]);

    /// <summary>This load order without the copy registered under <paramref name="key"/>, unchanged
    /// when none is (ADR-0007: a create that could not write its file takes its registration back).
    /// </summary>
    public LoadOrderSnapshot Without(PluginKey key) =>
        new(DataFolderPath, InstanceRoot, GameRelease, [.. Copies.Where(c => !SameKey(c, key))]);

    /// <summary>The folder holding the plugin's file, or null for a master resolved from the game's
    /// own Data directory (Track does not apply there) or a plugin no copy here names.</summary>
    public string? ModFolderOf(PluginKey plugin) =>
        Copy(plugin) is { } copy ? ModFolderOf(copy.Origin, copy.Path) : null;

    /// <summary>The same rule for a caller already holding a copy's origin and path.</summary>
    public static string? ModFolderOf(string origin, string pluginPath) =>
        string.Equals(origin, PluginOrigin.DataDirectory, StringComparison.OrdinalIgnoreCase)
            ? null
            : Path.GetDirectoryName(pluginPath);

    /// <summary>The mod's own display name: its folder's leaf, for a caller naming it in a
    /// user-facing message without reaching for the path itself.</summary>
    public static string ModNameOf(string modFolder) =>
        Path.GetFileName(modFolder.TrimEnd(Path.DirectorySeparatorChar));

    /// <summary>The folder every copy under one origin shares, for a gesture the mod folder is the
    /// unit of. Null when no registered copy carries the origin.</summary>
    public string? ModFolderOfOrigin(string origin) =>
        Copies.FirstOrDefault(c => c.Origin.Equals(origin, StringComparison.OrdinalIgnoreCase)) is { } copy
            ? ModFolderOf(copy.Origin, copy.Path)
            : null;

    /// <summary>Every copy the mod holds, for a gesture the mod is the unit of — Absorb and
    /// Keep.</summary>
    public IReadOnlyList<RegisteredCopy> CopiesOfOrigin(string origin) =>
        [.. Copies.Where(c => c.Origin.Equals(origin, StringComparison.OrdinalIgnoreCase))];

    /// <summary>ADR-0012: origin is required, not optional — the load order can register two copies
    /// of one filename, so the filename alone does not say which.</summary>
    public RegisteredCopy? Copy(PluginKey key) => Copies.FirstOrDefault(c => SameKey(c, key));

    private static bool SameKey(RegisteredCopy copy, PluginKey key) =>
        copy.Name.Equals(key.Name, StringComparison.OrdinalIgnoreCase)
        && copy.Origin.Equals(key.Origin, StringComparison.OrdinalIgnoreCase);

    // Structural, not a record's default: Copies is interface-typed, and its reference equality would
    // make two values built from one snapshot unequal.
    public bool Equals(LoadOrderSnapshot? other) =>
        other is not null
        && GameRelease == other.GameRelease
        && string.Equals(DataFolderPath, other.DataFolderPath, StringComparison.OrdinalIgnoreCase)
        && string.Equals(InstanceRoot, other.InstanceRoot, StringComparison.OrdinalIgnoreCase)
        && Copies.SequenceEqual(other.Copies);

    public override bool Equals(object? obj) => Equals(obj as LoadOrderSnapshot);

    // The same comparer Equals uses for each half, or two equal values could hash apart.
    public override int GetHashCode() => HashCode.Combine(
        StringComparer.OrdinalIgnoreCase.GetHashCode(DataFolderPath),
        InstanceRoot is null ? 0 : StringComparer.OrdinalIgnoreCase.GetHashCode(InstanceRoot),
        GameRelease,
        Copies.Count);
}
