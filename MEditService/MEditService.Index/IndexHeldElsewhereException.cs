namespace MEditService.Index;

/// <summary>The instance's index file is open in another process (ADR-0009 point 5). Refused by
/// name rather than read-only, waited on, or given a second file; distinct from a corrupt file,
/// which is rebuilt.</summary>
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
