using MEditService.Core.Records;
using Mutagen.Bethesda;

namespace MEditService.Tests.Records;

// #585 / ADR-0001: one index file per game Data install, under the service's local app data —
// never in a mod folder and never in the game directory, both of which belong to MO2, the
// installers and the user.
public class IndexFileTests
{
    private static readonly string Root = Path.Combine(Path.GetTempPath(), "medit-index-file-tests");

    [Fact]
    public void PathFor_LivesUnderTheGivenRoot_AndNamesTheRelease()
    {
        var path = IndexFile.PathFor(Root, GameRelease.Fallout4, Path.Combine(Root, "game", "Data"));

        Assert.StartsWith(Path.Combine(Root, "index"), path, StringComparison.Ordinal);
        Assert.Contains("Fallout4", Path.GetFileName(path), StringComparison.Ordinal);
        Assert.EndsWith(".duckdb", path, StringComparison.Ordinal);
    }

    // The file is never inside the install it describes: a mod reinstall or a game verify would
    // sweep it away, and a mod archiver would pick it up as content.
    [Fact]
    public void PathFor_IsNeverInsideTheDataFolder()
    {
        var dataFolder = Path.Combine(Path.GetTempPath(), "some-game", "Data");
        var path = IndexFile.PathFor(Root, GameRelease.Fallout4, dataFolder);

        Assert.DoesNotContain(dataFolder, path, StringComparison.Ordinal);
    }

    // Every MO2 instance and profile on one install shares one file — that is what makes the
    // vanilla masters indexed once, ever, rather than once per profile. Keyed by the Data folder,
    // so trailing separators and relative segments must not mint a second file for one install.
    [Fact]
    public void PathFor_IsTheSameFile_ForTheSameInstallSpeltDifferently()
    {
        var dataFolder = Path.Combine(Path.GetTempPath(), "some-game", "Data");
        var spelledOtherwise = Path.Combine(Path.GetTempPath(), "some-game", "Mods", "..", "..", "some-game", "Data")
            + Path.DirectorySeparatorChar;

        Assert.Equal(
            IndexFile.PathFor(Root, GameRelease.Fallout4, dataFolder),
            IndexFile.PathFor(Root, GameRelease.Fallout4, spelledOtherwise));
    }

    // Two installs of one game — a Steam copy and a GOG copy, a sandbox beside the played install —
    // are two different sets of files and must not share one mirror.
    [Fact]
    public void PathFor_IsADifferentFile_ForADifferentInstall()
    {
        Assert.NotEqual(
            IndexFile.PathFor(Root, GameRelease.Fallout4, Path.Combine(Path.GetTempPath(), "steam", "Data")),
            IndexFile.PathFor(Root, GameRelease.Fallout4, Path.Combine(Path.GetTempPath(), "gog", "Data")));
    }

    [Fact]
    public void DefaultRoot_IsUnderLocalApplicationData()
    {
        Assert.StartsWith(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            IndexFile.DefaultRoot, StringComparison.Ordinal);
    }
}
