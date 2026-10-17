namespace MEditService.ModFolderAdapter;

/// <summary>A mod's version and installation file as a mod manager's metadata or a manifest says, the installation file by
/// name and its page on its host, in the Instance adapter's text (ADR-0013).</summary>
public sealed record ModMetadata(string? Version, MetadataInstallationFile? InstallationFile = null)
{
    public static ModMetadata Of(Manifest manifest) =>
        new(manifest.Version, manifest.Package is ManifestPackage.InstallationFile file ? new MetadataInstallationFile(file.Name, file.Page) : null);

    /// <summary>Whether restoring <paramref name="manifest"/>'s metadata replaces a value this one holds: another version,
    /// another installation file, or another page for the same one. A value either side lacks replaces nothing.</summary>
    public bool IsOverwrittenBy(ModMetadata manifest) =>
        (manifest.Version is { } version && Version is { } held && held != version) || InstallationFileDiffersFrom(manifest.InstallationFile);

    /// <summary>Whether updating the manifest from this metadata would write another version or installation file.</summary>
    internal bool DiffersFrom(ModMetadata manifest) => Version != manifest.Version || InstallationFile != manifest.InstallationFile;

    private bool InstallationFileDiffersFrom(MetadataInstallationFile? says) =>
        InstallationFile is { } held && says is not null
        && (held.Name != says.Name || (held.Page is { } heldPage && says.Page is { } page && heldPage != page));
}

public sealed record MetadataInstallationFile(string Name, string? Page);
