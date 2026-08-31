using MEditService.Core.Source;

namespace MEditService.Tests.Source;

// Compile's diagnostics pass resolves thousands of records against one unchanging tree, and
// without a memo each folder-split child re-enumerated its whole subtree (2,198 dialog responses ×
// ~2,600 files on the real fixture — 25 of Compile's 42 seconds). The cache is a snapshot for the
// life of one operation, deliberately: a listing taken once is what makes the pass O(tree) instead
// of O(records × tree), and the tree is not expected to move under a single compile.
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
