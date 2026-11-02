namespace MEditService.SourceAdapter;

/// <summary>What a build step copies from a source folder, as its working tree says. Uncommitted: its working tree holds
/// changes no commit holds. Unpushed: its remote, as last fetched, lacks HEAD.</summary>
public sealed record SourceToBuild(IReadOnlyList<FileToCopy> Files, bool Uncommitted = false, bool Unpushed = false)
{
    internal static SourceToBuild In(string sourceFolder, IReadOnlyList<string> read)
    {
        var files = SourceRepositoryLayout.FilesAt(sourceFolder, read);
        if (TwinsIn(files.Select(file => file.Path)) is { } twins)
            throw SourceStopException.Unreadable($"'{sourceFolder}' holds {twins}.");
        var remote = Submodules.RemoteOf(sourceFolder);
        return new SourceToBuild(files, remote?.Uncommitted ?? false, remote?.Unpushed ?? false);
    }

    private static string? TwinsIn(IEnumerable<string> paths) =>
        paths.GroupBy(path => path, StringComparer.OrdinalIgnoreCase).FirstOrDefault(same => same.Count() > 1) is { } twins
            ? $"{string.Join(" and ", twins.Select(twin => $"'{twin}'"))}, which differ only in case: one mod folder cannot hold both on Windows"
            : null;
}

/// <summary>A source mod's repository as the instance repository holds it: the folder git checks it out in, the commit the
/// instance repository pins, and the branch it follows, if any.</summary>
public sealed record Submodule(string Folder, string Pin, string? Branch);

/// <summary>The commit a submodule's repository is at, and why the clone that made it was left detached at the pin.</summary>
public sealed record SubmoduleHead(string Commit, string? LeftDetached = null);
