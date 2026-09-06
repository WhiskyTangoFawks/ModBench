using MEditService.Core.Source;

namespace MEditService.Tests.Source;

// Without a memo each container's child re-enumerated its whole subtree, 25 of Compile's 42 seconds
// on the real fixture.
public class SourceUnitResolutionCacheTests
{
    [Fact]
    public void EntriesUnder_EnumeratesOncePerRoot_AndKeepsThatSnapshotForTheOperation()
    {
        var root = Directory.CreateTempSubdirectory("medit-unit-cache-").FullName;
        try
        {
            File.WriteAllText(Path.Combine(root, "a.json"), "{}");
            var cache = new SourceUnitResolutionCache();

            var first = cache.EntriesUnder(root);
            File.WriteAllText(Path.Combine(root, "b.json"), "{}");
            var second = cache.EntriesUnder(root);

            Assert.Single(first);
            Assert.Same(first, second);
            Assert.Equal(2, new SourceUnitResolutionCache().EntriesUnder(root).Length);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
