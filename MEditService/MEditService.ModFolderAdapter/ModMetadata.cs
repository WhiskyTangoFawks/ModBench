namespace MEditService.ModFolderAdapter;

/// <summary>A mod's version and installation files as a mod manager's metadata or a manifest says, each installation file
/// by name and where it comes from, in the Instance adapter's text (ADR-0013).</summary>
public sealed record ModMetadata(string? Version, IReadOnlyList<MetadataInstallationFile> InstallationFiles)
{
    public static ModMetadata Of(Manifest manifest) =>
        new(manifest.Version, [.. manifest.InstallationFiles.Select(file => new MetadataInstallationFile(file.Name, file.Source))]);

    /// <summary>Whether writing <paramref name="manifest"/>'s metadata replaces a value this one holds: another version,
    /// another source for a file both name, or files none of which the manifest names. A value either side lacks replaces
    /// nothing.</summary>
    internal bool DiffersFrom(ModMetadata manifest) =>
        (manifest.Version is { } version && Version is { } held && held != version) || InstallationFilesDifferFrom(manifest.InstallationFiles);

    private bool InstallationFilesDifferFrom(IReadOnlyList<MetadataInstallationFile> manifestFiles)
    {
        if (InstallationFiles.Count == 0 || manifestFiles.Count == 0) return false;
        var named = InstallationFiles.Select(file => (Held: file, Manifest: manifestFiles.FirstOrDefault(other => other.Name == file.Name))).ToList();
        return named.All(pair => pair.Manifest is null)
            || named.Any(pair => pair.Manifest is { } other && pair.Held.Source is { } heldSource && other.Source is { } source && heldSource != source);
    }
}

public sealed record MetadataInstallationFile(string Name, string? Source);
