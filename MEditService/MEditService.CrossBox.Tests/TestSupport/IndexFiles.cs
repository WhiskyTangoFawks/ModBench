namespace MEditService.Tests.TestSupport;

/// <summary>The one store file a reconcile over an instance leaves on disk (ADR-0009), found rather
/// than computed: where the Index keeps it is the Index's own.</summary>
internal static class IndexFiles
{
    internal static string In(string instanceRoot) =>
        Directory.GetFiles(instanceRoot, "*.duckdb", SearchOption.AllDirectories).Single();

    internal static string? InIfAny(string instanceRoot) =>
        Directory.Exists(instanceRoot)
            ? Directory.GetFiles(instanceRoot, "*.duckdb", SearchOption.AllDirectories).SingleOrDefault()
            : null;
}
