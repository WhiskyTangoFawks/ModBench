namespace MEditService.SourceAdapter;

/// <summary>What a write changes in one mod folder's plugin source, written nowhere: each move, then
/// each document's new text at its path once moved. Paths are relative to the mod folder.</summary>
public sealed record SourceChanges(IReadOnlyList<SourceMove> Moves, IReadOnlyList<DocumentChange> Documents)
{
    public static SourceChanges None { get; } = new([], []);

    public SourceChanges Then(SourceChanges next) => new([.. Moves, .. next.Moves], [.. Documents, .. next.Documents]);
}

public sealed record SourceMove(string From, string To);

public sealed record DocumentChange(string Path, string Text);
