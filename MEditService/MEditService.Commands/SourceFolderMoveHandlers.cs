using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>The first step of moving a source mod's source folder as its mod is renamed: the moves VS Code applies.</summary>
public sealed class SourceFolderMoveChangesHandler
{
    private readonly ISourceAdapter _source;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal SourceFolderMoveChangesHandler(ISourceAdapter source) => _source = source;

    /// <summary>The source folder's move, and each of <paramref name="files"/> it holds, written nowhere (ADR-0001).</summary>
    public Answer<SourceChanges, SourceFolderMoveRefused> Changes(string sourceFolder, string movedTo, IReadOnlyList<SourceMove> files)
    {
        if (!_source.ChangesToMoveSourceFolder(sourceFolder, movedTo, files).Holds(out var changes, out var failure)) return SourceFolderMoveRefused.Of(failure);
        if (changes is null)
        {
            return new SourceFolderMoveRefused(
                SourceFolderMoveRefusal.FolderTaken, $"'{movedTo}', or a name one of its files moves to, is taken, so '{sourceFolder}' was not moved.");
        }
        return changes;
    }
}

/// <summary>The second step of moving a source folder: what git holds of it follows, once VS Code has moved it.</summary>
public sealed class FollowSourceFolderMoveHandler
{
    private readonly ISourceAdapter _source;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal FollowSourceFolderMoveHandler(ISourceAdapter source) => _source = source;

    public SourceFolderMoveRefused? Follow(string sourceFolder, string movedTo) =>
        _source.FollowSourceFolderMove(sourceFolder, movedTo) is { } failure ? SourceFolderMoveRefused.Of(failure) : null;
}

public sealed record SourceFolderMoveRefused(SourceFolderMoveRefusal Refusal, string Message)
{
    internal static SourceFolderMoveRefused Of(SourceFailure failure) =>
        new(failure is SourceFailure.GitUnavailable ? SourceFolderMoveRefusal.GitUnavailable : SourceFolderMoveRefusal.WriteFailed, failure.Reason);
}

/// <summary>Why a step of moving a source folder wrote nothing (ADR-0019).</summary>
public enum SourceFolderMoveRefusal
{
    /// <summary>A folder or file is already where the move puts one.</summary>
    FolderTaken,

    /// <summary>git is not on PATH (ADR-0007).</summary>
    GitUnavailable,

    /// <summary>git or the file system refused the write.</summary>
    WriteFailed,
}
