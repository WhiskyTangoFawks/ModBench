using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>The snapshot's mods, and the folder of the stat cache (mod-status trace).</summary>
public sealed record SnapshotMods(IReadOnlyList<ModByFolder> Mods, string StatCache);

/// <summary>A mod by its folder, with its metadata files, which no line names, and when the request asks
/// about it, the metadata the mod manager holds or why it could not read it. A source mod names its source folder.</summary>
public sealed record ModByFolder(
    string Name, string Folder, IReadOnlyList<string> MetadataFiles, ModMetadata? Metadata = null, string? MetadataUnreadable = null,
    string? SourceFolder = null)
{
    /// <summary>The mod's folder against its manifest, and its metadata against the manifest's (modlist-source.md, Status).</summary>
    public ModStatus StatusIn(IModFolderRepository repository, string statCache) =>
        MetadataUnreadable is { } why
            ? new(Name, NoManifest: false, [], [], [], [], new ModUnreadable(Manifest: false, $"its metadata could not be read: {why}"))
            : repository.Status(Folder, Name, MetadataFiles.ToHashSet(StringComparer.Ordinal), statCache, Metadata);
}
