namespace MEditService.Core.Records;

/// <summary>
/// ADR-0001 point 6: the instance's index file is open in another process — a second
/// Modbench window on the same MO2 instance. A DuckDB file admits one writer and Modbench runs one
/// service per VS Code window, so the second load is refused by name: no read-only mode (a second
/// mode every index-writing path would have to detect), no waiting (a hang with no signal), never
/// a second file (silent divergence). Distinct from a file DuckDB cannot make sense of, which is
/// rebuilt — deleting a file another process holds open succeeds on POSIX and would destroy that
/// window's live index. <see cref="IndexStore.IsAnotherWriter"/> is the classifier;
/// <c>PUT /load-order</c> answers it 423 Locked with this message.
/// </summary>
public sealed class IndexHeldElsewhereException : Exception
{
    // RCS1194: the three standard constructors for well-behaved rethrow callers. The index throws
    // through For, the only path that produces the actionable message and the path it names.
    public IndexHeldElsewhereException()
    {
    }

    public IndexHeldElsewhereException(string message) : base(message)
    {
    }

    public IndexHeldElsewhereException(string message, Exception innerException) : base(message, innerException)
    {
    }

    /// <summary>The held file — <see cref="IndexFile.For"/> of the instance. Null only on the
    /// standard constructors, which nothing in the index uses.</summary>
    public string? IndexPath { get; init; }

    /// <summary>The refusal for one instance's file, wrapping DuckDB's own lock error.</summary>
    public static IndexHeldElsewhereException For(string indexPath, Exception duckDbError) =>
        new($"This instance's index is open in another Modbench window ({indexPath}). Close mEdit there first, or open a different instance here.", duckDbError)
        { IndexPath = indexPath };
}
