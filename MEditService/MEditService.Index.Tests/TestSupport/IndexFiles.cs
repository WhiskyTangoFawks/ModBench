using MEditService.TestSupport;
using MEditService.TestSupport.TestSupport;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>The one store file a reconcile over an instance leaves on disk (ADR-0009), found rather
/// than computed: where the Index keeps it is the Index's own.</summary>
internal static class IndexFiles
{
    internal static string In(string instanceRoot) =>
        Directory.GetFiles(instanceRoot, "*.duckdb", SearchOption.AllDirectories).Single();
}
