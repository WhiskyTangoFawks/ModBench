namespace MEditService.SourceAdapter;

/// <summary>What a write changes in one mod folder's plugin source, written nowhere: each move, then
/// each document's new text at its path once moved. Paths are relative to the mod folder.</summary>
public sealed record SourceChanges(IReadOnlyList<SourceMove> Moves, IReadOnlyList<DocumentChange> Documents)
{
    public static SourceChanges None { get; } = new([], []);

    public SourceChanges Then(SourceChanges next) => new([.. Moves, .. next.Moves], [.. Documents, .. next.Documents]);

    /// <summary>These changes with every path made absolute under <paramref name="repository"/>'s mod folder.</summary>
    public SourceChanges Under(SourceRepository repository)
    {
        var modFolder = repository.ModFolder;
        return new(
            [.. Moves.Select(move => new SourceMove(Path.Combine(modFolder, move.From), Path.Combine(modFolder, move.To)))],
            [.. Documents.Select(document => document with { Path = Path.Combine(modFolder, document.Path) })]);
    }
}

public sealed record SourceMove(string From, string To);

public sealed record DocumentChange(string Path, string Text);
