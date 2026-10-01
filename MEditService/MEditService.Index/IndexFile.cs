namespace MEditService.Index;

/// <summary>ADR-0009 invariant 3.</summary>
internal static class IndexFile
{
    /// <summary>The index file for one instance. Pure — it creates nothing;
    /// <see cref="DuckDbRecordIndex"/> creates the directory when it opens.</summary>
    public static string For(string instanceRoot) =>
        // Canonicalized so that trailing separators and relative segments cannot mint a second file
        // for one instance — a profile switch that spells the root differently must find the file
        // the last one left.
        Path.Combine(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(instanceRoot)), "modbench", "index.duckdb");
}
