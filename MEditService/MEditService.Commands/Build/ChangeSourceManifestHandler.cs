using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>A change to a source mod's manifest: the output folder's new name, and the paths in the mod folder to exclude
/// from its build or include again.</summary>
public sealed record SourceManifestChange(string? Output, IReadOnlyList<string> Exclude, IReadOnlyList<string> Include);

/// <summary>The manifest's half of rename and of exclude or include, written uncommitted in the mod's repository, so the
/// folder Modbench writes already equals the next build's output (mods.md, A source mod, story 2).</summary>
public sealed class ChangeSourceManifestHandler
{
    private readonly IModFolderRepository _modFolders;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal ChangeSourceManifestHandler(IModFolderRepository modFolders) => _modFolders = modFolders;

    public SourceManifestChangeResult Change(string sourceFolder, SourceManifestChange change)
    {
        if (change.Output is { } named && !Manifest.IsFolderName(named))
            return new(SourceManifestRefusal.OutsideTheMod, $"The output '{named}' is not a folder name.");
        if (change.Exclude.Concat(change.Include).FirstOrDefault(path => !Manifest.IsPathInTheFolder(path)) is { } outside)
            return new(SourceManifestRefusal.OutsideTheMod, $"'{outside}' is not a path in the mod folder.");

        if (!_modFolders.ReadSourceManifest(sourceFolder).Holds(out var held, out var why))
            return new(SourceManifestRefusal.Unreadable, $"The source mod in '{sourceFolder}' was not changed: {why}.");
        if (held is not { } manifest) return new(SourceManifestRefusal.Unreadable, $"'{sourceFolder}' holds no manifest.");

        List<string> excluded = [.. manifest.Exclude.Where(kept => !change.Include.Contains(kept, StringComparer.OrdinalIgnoreCase))];
        excluded.AddRange(change.Exclude.Where(added => !excluded.Contains(added, StringComparer.OrdinalIgnoreCase)));
        try
        {
            _modFolders.WriteSourceManifest(sourceFolder, manifest with { Output = change.Output ?? manifest.Output, Exclude = excluded });
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return new(SourceManifestRefusal.WriteFailed, $"The manifest in '{sourceFolder}' could not be written: {e.Message}");
        }
        return new();
    }
}

/// <summary>Whether the manifest changed, or why it was left as it was.</summary>
public sealed record SourceManifestChangeResult(SourceManifestRefusal? Refusal = null, string? Message = null);

/// <summary>Why a change to a source mod's manifest wrote nothing (ADR-0019).</summary>
public enum SourceManifestRefusal
{
    /// <summary>The source folder holds no manifest, or one that cannot be read.</summary>
    Unreadable,

    OutsideTheMod,

    /// <summary>The file system refused the write.</summary>
    WriteFailed,
}
