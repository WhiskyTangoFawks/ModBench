using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>A mod by its folder, with its metadata files, which no line names, the metadata the mod manager holds or why
/// it could not read it, when asked, and a source mod's source folder.</summary>
public sealed record ModByFolder(
    string Name, string Folder, IReadOnlyList<string> MetadataFiles, string? SourceFolder, ModMetadata? Metadata = null, string? MetadataUnreadable = null)
{
    /// <summary>The mod's folder against its manifest, and its metadata against the manifest's (modlist-repository.md, Status).</summary>
    public ModStatus StatusIn(IModFolderRepository repository, string statCache) =>
        MetadataUnreadable is { } why
            ? new(Name, NoManifest: false, [], [], [], [], [], new ModUnreadable(Manifest: false, $"its metadata could not be read: {why}"))
            : repository.Status(Folder, Name, MetadataFiles.ToHashSet(StringComparer.Ordinal), statCache, Metadata, SourceFolder);
}
