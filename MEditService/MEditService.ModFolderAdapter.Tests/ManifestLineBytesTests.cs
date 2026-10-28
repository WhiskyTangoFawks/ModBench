namespace MEditService.ModFolderAdapter.Tests;

public sealed class ManifestLineBytesTests
{
    private static readonly Manifest Installed = new([new ManifestPackage.InstallationFile("First.7z", 1, "H1")], []);

    private static ManifestFile Line(PackageEntry entry) => new("a.nif", entry);

    public static TheoryData<string, Manifest, ManifestFile, FileBytes> NamingBytes => new()
    {
        { "a line held at its own path, in the installation file", Installed, Line(new PackageEntry.Held()), new FileBytes.InInstallationFile("First.7z", "a.nif") },
        {
            "a line held at another path, in the installation file", Installed,
            ManifestFile.At("a.nif", new FileBytes.InInstallationFile("First.7z", "x/a.nif")), new FileBytes.InInstallationFile("First.7z", "x/a.nif")
        },
        {
            "a line of a source mod, as its build writes it", new Manifest([new ManifestPackage.SourceRepository("Mod", IsSubmodule: true)], []),
            Line(new PackageEntry.Held()), new FileBytes.Built("a.nif")
        },
    };

    [Theory]
    [MemberData(nameof(NamingBytes))]
    public void ALine_NamesWhereItsBytesAre(string _, Manifest manifest, ManifestFile line, FileBytes bytes) =>
        Assert.Equal(bytes, manifest.BytesOf(line));

    public static TheoryData<string, Manifest, PackageEntry, Type> NamingNoBytes => new()
    {
        { "a line its package does not hold", Installed, new PackageEntry.NotHeld(), typeof(FileBytes.NotHeld) },
        { "a line its package holds with other bytes", Installed, new PackageEntry.OtherBytes(), typeof(FileBytes.OtherBytes) },
        { "a line held by a manifest with no package", new Manifest([], []), new PackageEntry.Held(), typeof(FileBytes.NoInstallationFile) },
    };

    [Theory]
    [MemberData(nameof(NamingNoBytes))]
    public void ALine_NamesWhyItHasNoBytes(string _, Manifest manifest, PackageEntry entry, Type why) =>
        Assert.IsType(why, manifest.BytesOf(Line(entry)));

    [Theory]
    [InlineData("A.nif", true)]
    [InlineData("x/a.nif", false)]
    public void APackagePath_IsTheFilesOwnOnlyWhenItDiffersByNoMoreThanCase(string packagePath, bool isOwn) =>
        Assert.Equal(isOwn, ManifestFile.At("a.nif", new FileBytes.InInstallationFile("First.7z", packagePath)).Entry is PackageEntry.Held);
}
