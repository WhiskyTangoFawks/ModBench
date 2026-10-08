using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.Index;

/// <summary>Where an index was opened: the game, its Data folder and the instance whose file holds it.</summary>
internal readonly record struct IndexScope(GameRelease GameRelease, string DataFolderPath, string? InstanceRoot)
{
    internal static IndexScope Of(HeldPlugins held) => new(held.GameRelease, held.DataFolderPath, held.InstanceRoot);

    internal bool Matches(LoadOrderSnapshot snapshot) =>
        GameRelease == snapshot.GameRelease
        && SamePath(DataFolderPath, snapshot.DataFolderPath)
        && (InstanceRoot, snapshot.InstanceRoot) switch
        {
            (null, null) => true,
            ({ } a, { } b) => SamePath(a, b),
            _ => false,
        };

    private static bool SamePath(string a, string b) =>
        string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);
}
