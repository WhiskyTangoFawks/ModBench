namespace MEditService.SourceAdapter;

/// <summary>What a write changes in one mod folder's plugin source, written nowhere: moves, then deletions of
/// a file or a folder, then each document's new text at its moved path. Paths are relative to the mod folder.</summary>
public sealed record SourceChanges(IReadOnlyList<SourceMove> Moves, IReadOnlyList<DocumentChange> Documents)
{
    internal IReadOnlyList<string> Deletions { get; init; } = [];

    public static SourceChanges None { get; } = new([], []);

    internal SourceChanges Then(SourceChanges next) =>
        new([.. Moves, .. next.Moves], [.. Documents, .. next.Documents]) { Deletions = [.. Deletions, .. next.Deletions] };

    /// <summary>These changes with every path made absolute under <paramref name="repository"/>'s mod folder.</summary>
    public SourceChanges Under(SourceRepository repository)
    {
        var modFolder = repository.ModFolder;
        return new(
            [.. Moves.Select(move => new SourceMove(Path.Combine(modFolder, move.From), Path.Combine(modFolder, move.To)))],
            [.. Documents.Select(document => document with { Path = Path.Combine(modFolder, document.Path) })])
        {
            Deletions = [.. Deletions.Select(deletion => Path.Combine(modFolder, deletion))],
        };
    }
}

/// <summary>Changes answered by the source adapter, made one after another.</summary>
public static class SourceChangesAnswers
{
    /// <summary><paramref name="first"/>'s changes, then <paramref name="next"/>'s, or the first failure of
    /// the two.</summary>
    public static SourceAnswer<SourceChanges> Then(this SourceAnswer<SourceChanges> first, SourceAnswer<SourceChanges> next) =>
        first.Then(made => next.Then(more => SourceAnswer.Of(made.Then(more))));
}

public sealed record SourceMove(string From, string To);

public sealed record DocumentChange(string Path, string Text);
