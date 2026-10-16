namespace MEditService.ModFolderAdapter.Tests;

public sealed class ManifestLineBytesTests
{
    private static readonly Manifest Mod = new(
        [new ManifestSource("First.7z", 1, "H1"), new ManifestSource("Second.7z", 1, "H2")],
        [new ManifestSource("Data/Game.esm", 1, "HG")],
        []);

    private static FileBytes BytesOf(FileProvider provider) => Mod.BytesOf(new ManifestFile("a.nif", provider));

    public static TheoryData<FileProvider, FileBytes> Placed => new()
    {
        { new FileProvider.FirstInstallationFile(), new FileBytes.InInstallationFile("First.7z", "a.nif") },
        { new FileProvider.InstallationFileEntry("Second.7z", "x/a.nif"), new FileBytes.InInstallationFile("Second.7z", "x/a.nif") },
        { new FileProvider.GameFile("Data/Game.esm"), new FileBytes.InGameFile("Data/Game.esm") },
        { new FileProvider.Source("remote", "abc"), new FileBytes.AtCommit("remote", "abc", "a.nif") },
    };

    [Theory]
    [MemberData(nameof(Placed))]
    public void ALine_NamesTheBytesItsProviderFixes(FileProvider provider, FileBytes expected) =>
        Assert.Equal(expected, BytesOf(provider));

    [Fact]
    public void ALineWithNoProvider_NamesNoBytes() =>
        Assert.IsType<FileBytes.Unnamed>(BytesOf(new FileProvider.NoProvider()));

    [Fact]
    public void TheFirstInstallationFileOfAManifestWithNone_NamesNoInstallationFile() =>
        Assert.IsType<FileBytes.NoInstallationFile>(
            new Manifest([], [], []).BytesOf(new ManifestFile("a.nif", new FileProvider.FirstInstallationFile())));

    [Theory]
    [InlineData("First.7z", "A.nif", true)]
    [InlineData("First.7z", "x/a.nif", false)]
    [InlineData("Second.7z", "a.nif", false)]
    public void TheFirstInstallationFileHoldingTheLineAtItsPath_IsWhatTheShortLineNames(string name, string entryPath, bool isShort) =>
        Assert.Equal(isShort, new FileBytes.InInstallationFile(name, entryPath).IsWhatFirstInstallationFileNamesAt("First.7z", "a.nif"));
}
