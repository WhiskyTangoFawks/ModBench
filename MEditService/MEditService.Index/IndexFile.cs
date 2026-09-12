namespace MEditService.Index;

/// <summary>One DuckDB file per MO2 instance, in the instance root (ADR-0009). Never under
/// <c>mods/</c>, <c>overwrite/</c> or <c>profiles/</c>: a reinstall, profile delete or archiver
/// would take it as content.</summary>
internal static class IndexFile
{
    /// <summary>The index file for one MO2 instance. Pure — it creates nothing;
    /// <see cref="DuckDbRecordIndex"/> creates the directory when it opens.</summary>
    public static string For(string instanceRoot) =>
        // Canonicalized so that trailing separators and relative segments cannot mint a second file
        // for one instance — a profile switch that spells the root differently must find the file
        // the last one left.
        Path.Combine(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(instanceRoot)), "modbench", "index.duckdb");
}
