using MEditService.Core.Records;

namespace MEditService.Tests.Records;

// #592 / ADR-0001: one index file per MO2 instance, inside the instance root. `origin` is a mod
// folder name (ADR-0036), unique only within an instance, and every mirror table is keyed
// (plugin, origin) — so the instance is the only scope an index can honestly live at.
public class IndexFileTests
{
    private static readonly string Instance = Path.Combine(Path.GetTempPath(), "medit-index-file-tests");

    // AC1 names the location, so the test pins it: inside the instance root, and — since the
    // instance root is MO2's own working directory but `mods/`, `overwrite/`, `profiles/` and
    // `downloads/` are content it manages — in none of those. A mod reinstall, a profile delete or
    // a download sweep would take an index under any of them with it, and a mod archiver would pick
    // it up as content.
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
    // they must never share a mirror — the whole point of #592.
    [Fact]
    public void For_IsADifferentFile_ForADifferentInstance()
    {
        Assert.NotEqual(
            IndexFile.For(Path.Combine(Path.GetTempPath(), "instance-a")),
            IndexFile.For(Path.Combine(Path.GetTempPath(), "instance-b")));
    }
}
