using System.Text.Json.Serialization;

namespace MEditService.Commands.Build;

/// <summary>A mod to update the manifest of, with its installation files in the mod manager's order, its version, the
/// files the repository commits, which no line names, and whether its build writes its manifest.</summary>
public sealed record ModToUpdate(
    string Name, string Folder, IReadOnlyList<InstallationFile> InstallationFiles, IReadOnlyList<string> MetadataFiles, bool IsSourceMod,
    string? Version);

/// <summary>The instance's facts beyond its mods: the game files the mods' files override, and the folder of the stat
/// cache.</summary>
public sealed record InstanceToUpdate(IReadOnlyList<OverriddenGameFile> GameFiles, string StatCache);

/// <summary>A game file a mod file overrides, by its forward-slash path under the game's data folder, as the
/// Instance adapter knows it (ADR-0013).</summary>
public sealed record OverriddenGameFile(string Path, long Size, string Hash);

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
    /// (modlist-source.md, Update manifest, story 5).</summary>
    LeftToItsBuild,
}

/// <summary>A mod whose manifest is as its folder says. ManifestWritten is false when the manifest was already so.
/// NoProvider names each file nothing provides. StatCacheNotWritten is why the stat cache could not be written, or null.</summary>
public sealed record UpdatedMod(bool ManifestWritten, IReadOnlyList<string> NoProvider, string? StatCacheNotWritten);
