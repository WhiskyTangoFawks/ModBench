using MEditService.Core.Records;

namespace MEditService.Tests.Records;

// #592 / ADR-0001: one index file per MO2 instance, inside the instance root. `origin` is a mod
// folder name (ADR-0036), unique only within an instance, and every mirror table is keyed
// (plugin, origin) — so the instance is the only scope an index can honestly live at.
public class IndexFileTests
{
    private static readonly string Instance = Path.Combine(Path.GetTempPath(), "medit-index-file-tests");

    [Fact]
    public void For_LivesInsideTheInstanceRoot()
    {
        var path = IndexFile.For(Instance);

        Assert.StartsWith(Instance, path, StringComparison.Ordinal);
        Assert.EndsWith(".duckdb", path, StringComparison.Ordinal);
    }

    // The instance root is MO2's own working directory, but the four folders below are content it
    // manages: a mod reinstall, a profile delete or a download sweep would take the index with it,
    // and a mod archiver would pick it up as content.
    [Theory]
    [InlineData("mods")]
    [InlineData("overwrite")]
    [InlineData("profiles")]
    [InlineData("downloads")]
    public void For_IsNeverInsideAFolderMO2ManagesContentIn(string folder)
    {
        var path = IndexFile.For(Instance);

        Assert.DoesNotContain(
            Path.Combine(Instance, folder) + Path.DirectorySeparatorChar, path, StringComparison.OrdinalIgnoreCase);
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
