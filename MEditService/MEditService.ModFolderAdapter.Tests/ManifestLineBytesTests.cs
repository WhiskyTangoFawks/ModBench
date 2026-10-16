namespace MEditService.ModFolderAdapter.Tests;

public sealed class ManifestLineBytesTests
{
    private static readonly Manifest Mod = new(
        [new ManifestSource("First.7z", 1, "H1"), new ManifestSource("Second.7z", 1, "H2")],
        [new ManifestSource("Data/Game.esm", 1, "HG")],
        []);

    public static TheoryData<FileProvider, FileBytes> Cases => new()
    {
        { new FileProvider.FirstInstallationFile(), new FileBytes.InInstallationFile("First.7z", "a.nif") },
        { new FileProvider.InstallationFileEntry("Second.7z", "x/a.nif"), new FileBytes.InInstallationFile("Second.7z", "x/a.nif") },
        { new FileProvider.GameFile("Data/Game.esm"), new FileBytes.InGameFile("Data/Game.esm") },
        { new FileProvider.Source("remote", "abc"), new FileBytes.AtCommit("remote", "abc", "a.nif") },
        { new FileProvider.NoProvider(), new FileBytes.Unnamed() },
    };

    [Theory]
    [MemberData(nameof(Cases))]
    public void ALine_NamesTheBytesItsProviderFixes(FileProvider provider, FileBytes expected) =>
        Assert.Equal(expected, Mod.BytesOf(new ManifestFile("a.nif", provider)));

    [Theory]
    [InlineData("First.7z", "A.nif", true)]
    [InlineData("First.7z", "x/a.nif", false)]
    [InlineData("Second.7z", "a.nif", false)]
    public void TheFirstInstallationFileHoldingTheLineAtItsPath_IsTheShortProvider(string name, string entryPath, bool isShort)
    {
        var provider = FileProvider.Holding(new FileBytes.InInstallationFile(name, entryPath), "First.7z", "a.nif");

        Assert.Equal(isShort, provider is FileProvider.FirstInstallationFile);
        Assert.Equal(new FileBytes.InInstallationFile(name, isShort ? "a.nif" : entryPath), Mod.BytesOf(new ManifestFile("a.nif", provider)));
    }

    [Fact]
    public void TheFirstInstallationFileOfAManifestWithNone_NamesNoInstallationFile() =>
        Assert.Equal(new FileBytes.NoInstallationFile(),
            new Manifest([], [], []).BytesOf(new ManifestFile("a.nif", new FileProvider.FirstInstallationFile())));
}
