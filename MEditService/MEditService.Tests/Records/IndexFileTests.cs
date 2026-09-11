using MEditService.Core.Records;

namespace MEditService.Tests.Records;

// ADR-0009: one index file per MO2 instance, inside the instance root. `origin` is a mod folder
// name unique only within an instance and every mirror table is keyed (plugin, origin), so the
// instance is the only honest scope.
public class IndexFileTests
{
    private static readonly string Instance = Path.Combine(Path.GetTempPath(), "medit-index-file-tests");

    // The instance root is MO2's working directory, but `mods/`, `overwrite/`, `profiles/` and
    // `downloads/` are content it manages: a reinstall, a profile delete or a download sweep would
    // take an index under any of them with it.
    [Fact]
    public void For_LivesInTheInstanceRoot_BesideTheContentMO2Manages_NeverInsideIt()
    {
        Assert.Equal(Path.Combine(Instance, "modbench", "index.duckdb"), IndexFile.For(Instance));
    }

    // Profiles within one instance share the file — that is what keeps a profile switch cheap — so
    // trailing separators and relative segments must not mint a second file for one instance.
    [Fact]
    public void For_IsTheSameFile_ForTheSameInstanceSpeltDifferently()
    {
        var spelledOtherwise = Path.Combine(Instance, "mods", "..") + Path.DirectorySeparatorChar;

        Assert.Equal(IndexFile.For(Instance), IndexFile.For(spelledOtherwise));
    }

    // Two instances on one game have their own same-named mod folders holding different bytes, so
    // they must never share a store.
    [Fact]
    public void For_IsADifferentFile_ForADifferentInstance()
    {
        Assert.NotEqual(
            IndexFile.For(Path.Combine(Path.GetTempPath(), "instance-a")),
            IndexFile.For(Path.Combine(Path.GetTempPath(), "instance-b")));
    }
}
