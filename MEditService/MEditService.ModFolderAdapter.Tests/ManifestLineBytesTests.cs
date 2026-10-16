namespace MEditService.ModFolderAdapter.Tests;

public sealed class ManifestLineBytesTests
{
    private static readonly Manifest Installed = new(new ManifestPackage.InstallationFile("First.7z", 1, "H1"), []);

    private static FileBytes BytesOf(Manifest manifest, PackageEntry entry) => manifest.BytesOf(new ManifestFile("a.nif", entry));

    [Fact]
    public void ALineHeldAtItsOwnPath_NamesThatPathInTheInstallationFile() =>
        Assert.Equal(new FileBytes.InInstallationFile("First.7z", "a.nif"), BytesOf(Installed, new PackageEntry.Held()));

    [Fact]
    public void ALineHeldAtAnotherPath_NamesThatPathInTheInstallationFile() =>
        Assert.Equal(new FileBytes.InInstallationFile("First.7z", "x/a.nif"), BytesOf(Installed, new PackageEntry.HeldAt("x/a.nif")));

    [Fact]
    public void ALineOfASourceMod_NamesItsPathAtTheCommit() =>
        Assert.Equal(
            new FileBytes.AtCommit("abc", "a.nif"),
            BytesOf(new Manifest(new ManifestPackage.SourceMod("remote", "abc"), []), new PackageEntry.Held()));

    [Fact]
    public void ALineItsPackageDoesNotHold_NamesNoBytes() =>
        Assert.IsType<FileBytes.NotHeld>(BytesOf(Installed, new PackageEntry.NotHeld()));

    [Fact]
    public void ALineHeldByAManifestWithNoPackage_NamesNoInstallationFile() =>
        Assert.IsType<FileBytes.NoInstallationFile>(BytesOf(new Manifest(null, []), new PackageEntry.Held()));

    [Theory]
    [InlineData("A.nif", true)]
    [InlineData("x/a.nif", false)]
    public void APackagePath_IsTheFilesOwnOnlyWhenItDiffersByNoMoreThanCase(string packagePath, bool isOwn) =>
        Assert.Equal(isOwn, PackageEntry.At("a.nif", packagePath) is PackageEntry.Held);
}
