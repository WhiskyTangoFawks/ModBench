using System.Text.Json.Serialization;

namespace MEditService.Commands.Build;

/// <summary>A mod to update the manifest of, with its installation files in the mod manager's order, the first its package,
/// its version, its metadata files, which no line names, and whether its build writes its manifest.</summary>
public sealed record ModToUpdate(
    string Name, string Folder, IReadOnlyList<InstallationFile> InstallationFiles, IReadOnlyList<string> MetadataFiles, bool IsSourceMod,
    string? Version);

/// <summary>The instance's facts beyond its mods: the folder of the stat cache.</summary>
public sealed record InstanceToUpdate(string StatCache);

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum UpdateManifestRefusal
{
    None,

    /// <summary>An installation file of the mod is not in the downloads folder.</summary>
    InstallationFileMissing,

    ModFolderMissing,

    /// <summary>A file of the mod could not be read.</summary>
    ModFilesUnreadable,

    /// <summary>The mod's manifest could not be written.</summary>
    NotWritten,

    /// <summary>A source mod whose folder differs from what its build wrote, or that its build wrote no manifest for
    /// (modlist-repository.md, Update manifest, story 5).</summary>
    LeftToItsBuild,
}

/// <summary>A mod whose manifest is as its folder says. ManifestWritten is false when the manifest was already so.
/// NotInPackage names each file the mod's package does not hold. StatCacheNotWritten is why the stat cache could not be written, or null.</summary>
public sealed record UpdatedMod(bool ManifestWritten, IReadOnlyList<string> NotInPackage, string? StatCacheNotWritten);
