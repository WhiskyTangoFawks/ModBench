using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>A mod's version and installation files as a mod manager's metadata or a manifest says, each installation file
/// by name and where it comes from, in the Instance adapter's text (ADR-0013).</summary>
public sealed record ModMetadata(string? Version, IReadOnlyList<MetadataInstallationFile> InstallationFiles)
{
    public static ModMetadata Of(Manifest manifest) =>
        new(manifest.Version, [.. manifest.InstallationFiles.Select(file => new MetadataInstallationFile(file.Name, file.Source))]);

    /// <summary>Whether writing <paramref name="manifest"/>'s metadata over this one replaces a value this one holds. A value
    /// either side lacks replaces nothing.</summary>
    public bool DiffersFrom(ModMetadata manifest) =>
        (manifest.Version is { } version && Version is { } held && held != version)
        || (manifest.InstallationFiles is [var first, ..] && InstallationFiles.Any(file => !file.Agrees(first)));
}

public sealed record MetadataInstallationFile(string Name, string? Source)
{
    internal bool Agrees(MetadataInstallationFile other) =>
        Name == other.Name && (Source is null || other.Source is null || Source == other.Source);
}
