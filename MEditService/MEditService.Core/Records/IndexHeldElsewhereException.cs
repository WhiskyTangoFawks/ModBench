namespace MEditService.Core.Records;

/// <summary>
/// #588 / ADR-0001 point 6: the instance's index file is open in another process — a second
/// Modbench window on the same MO2 instance. A DuckDB file admits one writer and Modbench runs one
/// service per VS Code window, so the second load is refused by name: no read-only mode (a second
/// mode every index-writing path would have to detect), no waiting (a hang with no signal), never
/// a second file (silent divergence). Distinct from a file DuckDB cannot make sense of, which is
/// rebuilt — deleting a file another process holds open succeeds on POSIX and would destroy that
/// window's live index. <see cref="DuckDbRecordIndex.IsAnotherWriter"/> is the classifier;
/// <c>PUT /load-order</c> answers it 423 Locked with this message.
/// </summary>
public sealed class IndexHeldElsewhereException : Exception
{
    // RCS1194: the three standard constructors for well-behaved rethrow callers; the index throws
    // through the path-based one below, which is the only one that produces the actionable message.
    public IndexHeldElsewhereException()
    {
    }

    public IndexHeldElsewhereException(string message) : base(message)
    {
    }

    public IndexHeldElsewhereException(string message, Exception innerException) : base(message, innerException)
    {
    }

    internal IndexHeldElsewhereException(string indexPath, Exception inner, bool _)
        : base($"This instance's index is open in another Modbench window ({indexPath}). Close mEdit there first, or open a different instance here.", inner)
    {
        IndexPath = indexPath;
    }

    /// <summary>The held file — <see cref="IndexFile.For"/> of the instance.</summary>
    public string IndexPath { get; } = "";

    /// <summary>The refusal for one instance's file, wrapping DuckDB's own lock error.</summary>
    public static IndexHeldElsewhereException For(string indexPath, Exception duckDbError) => new(indexPath, duckDbError, true);
}
