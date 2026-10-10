namespace MEditService.SourceAdapter;

/// <summary>What a write changes in one mod folder's plugin source, written nowhere: moves, then deletions of
/// a file or folder, then each document's new text at its moved path. Paths are relative to the mod folder.</summary>
public sealed record SourceChanges(
    IReadOnlyList<SourceMove> Moves, IReadOnlyList<string> Deletions, IReadOnlyList<DocumentChange> Documents)
{
    public static SourceChanges None { get; } = new([], [], []);

    internal SourceChanges Then(SourceChanges next) =>
        new([.. Moves, .. next.Moves], [.. Deletions, .. next.Deletions], [.. Documents, .. next.Documents]);

    /// <summary>These changes with every path made absolute under <paramref name="modFolder"/>.</summary>
    public SourceChanges Under(string modFolder) =>
        new(
            [.. Moves.Select(move => new SourceMove(Path.Combine(modFolder, move.From), Path.Combine(modFolder, move.To)))],
            [.. Deletions.Select(deletion => Path.Combine(modFolder, deletion))],
            [.. Documents.Select(document => document with { Path = Path.Combine(modFolder, document.Path) })]);
}

public sealed record SourceMove(string From, string To);

public sealed record DocumentChange(string Path, string Text);
