using System.Text;
using MEditService.Commands.Build;
using MEditService.Commands.Tests.TestSupport;
using MEditService.ModFolderAdapter;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Build;

public sealed class ChangeSourceManifestHandlerTests : IDisposable
{
    private readonly ScratchDirectory _source = new("medit-source-manifest-");
    private readonly ModFolderRepository _folders = new(TimeProvider.System);
    private readonly ChangeSourceManifestHandler _handler;

    public ChangeSourceManifestHandlerTests() => _handler = TestEditService.ChangeSourceManifestHandler(_folders);

    public void Dispose() => _source.Dispose();

    private static readonly Manifest Built = new(
        [new ManifestPackage.SourceRepository("Mod", IsSubmodule: true)], [new ManifestFile("Mod.esp", new PackageEntry.Held())], "1.0")
    {
        Output = "Old Name",
        Archives = [new ManifestArchive("Mod - Main.ba2", ["meshes/a.nif"])],
    };

    [Fact]
    public void ANewOutput_NamesTheFolder_KeepingAllElseItSays()
    {
        _folders.WriteSourceManifest(_source, Built);

        Assert.Equal(new SourceManifestChangeResult(), _handler.Change(_source, new SourceManifestChange("New Name", [], [])));

        var renamed = _folders.ReadSourceManifest(_source).Value();
        Assert.Equal(("New Name", Built.Packages[0], Built.Version), (renamed?.Output, renamed?.Packages[0], renamed?.Version));
        Assert.Equal(Built.Files, renamed?.Files);
        Assert.Equal(["Mod - Main.ba2"], renamed?.Archives.Select(archive => archive.Path));
    }

    [Theory]
    [InlineData(new string[0], new[] { "textures/b.dds", "meshes" }, new string[0], new[] { "meshes", "textures/b.dds" })]
    [InlineData(new[] { "textures/b.dds" }, new[] { "Textures/B.dds", "a.esp", "Z.esp" }, new string[0], new[] { "a.esp", "textures/b.dds", "Z.esp" })]
    [InlineData(new[] { "a.esp", "textures/b.dds" }, new string[0], new[] { "Textures/B.dds" }, new[] { "a.esp" })]
    [InlineData(new[] { "a.esp" }, new string[0], new[] { "a.esp", "never.esp" }, new string[0])]
    public void AnExclusion_IsAddedOrRemovedByPathWithoutCase(string[] before, string[] exclude, string[] include, string[] after)
    {
        _folders.WriteSourceManifest(_source, Built with { Exclude = before });

        Assert.Equal(new SourceManifestChangeResult(), _handler.Change(_source, new SourceManifestChange(null, exclude, include)));

        Assert.Equal(after, _folders.ReadSourceManifest(_source).Value()?.Exclude);
    }

    private static readonly ManifestPackage.InstallationFile Pack = new("Pack-1.0.zip", 10, "hash");

    private (string Path, string PackagePath) TakenFileLine()
    {
        var manifest = _folders.ReadSourceManifest(_source).Value();
        var line = Assert.Single(manifest?.Files ?? []);
        return (line.Path, Assert.IsType<FileBytes.InInstallationFile>(manifest?.BytesOf(line)).Path);
    }

    [Theory]
    [InlineData("textures/a.txt", "textures/a.txt.excluded")]
    [InlineData("textures", "textures.excluded/a.txt")]
    public void AnExclusion_MovesTheLineOfATakenFile_ToWhereTheFolderNowHoldsIt(string excluded, string lineAt)
    {
        _folders.WriteSourceManifest(_source, new Manifest([Pack], [ManifestFile.At("textures/a.txt", new FileBytes.InInstallationFile(Pack.Name, "textures/a.txt"))]) { Output = "Old Name" });

        Assert.Equal(new SourceManifestChangeResult(), _handler.Change(_source, new SourceManifestChange(null, [excluded], [], ".excluded")));

        var line = TakenFileLine();
        Assert.Equal((lineAt, "textures/a.txt"), line);
    }

    [Fact]
    public void AnInclusion_MovesTheLineOfATakenFileBack_ToItsOwnPath()
    {
        _folders.WriteSourceManifest(_source, new Manifest([Pack], [ManifestFile.At("textures/a.txt.excluded", new FileBytes.InInstallationFile(Pack.Name, "textures/a.txt"))])
        {
            Output = "Old Name",
            Exclude = ["textures/a.txt"],
        });

        Assert.Equal(new SourceManifestChangeResult(), _handler.Change(_source, new SourceManifestChange(null, [], ["textures/a.txt"], ".excluded")));

        var line = TakenFileLine();
        Assert.Equal(("textures/a.txt", "textures/a.txt"), line);
    }

    [Fact]
    public void AnExclusionAndAnInclusion_MoveTheLineOfABuiltFile_WithTheFolder()
    {
        var built = new Manifest([new ManifestPackage.SourceRepository("Mod", IsSubmodule: false)], [new ManifestFile("textures/a.dds", new PackageEntry.Held())]) { Output = "Old Name" };
        _folders.WriteSourceManifest(_source, built);

        _handler.Change(_source, new SourceManifestChange(null, ["textures/a.dds"], [], ".excluded"));
        var excluded = _folders.ReadSourceManifest(_source).Value()?.Files.Select(line => line.Path).Single();
        _handler.Change(_source, new SourceManifestChange(null, [], ["textures/a.dds"], ".excluded"));
        var included = _folders.ReadSourceManifest(_source).Value()?.Files.Select(line => line.Path).Single();

        Assert.Equal(("textures/a.dds.excluded", "textures/a.dds"), (excluded, included));
    }

    [Fact]
    public void ARepositoryWithNoManifest_IsRefusedAsUnreadable_AndGetsNone()
    {
        var changed = _handler.Change(_source, new SourceManifestChange("Other", [], []));

        Assert.Equal(SourceManifestRefusal.Unreadable, changed.Refusal);
        Assert.Contains(_source.Path, changed.Message, StringComparison.Ordinal);
        Assert.Empty(Directory.GetFiles(_source));
    }

    [Fact]
    public void AManifestThatDoesNotRead_IsRefusedAsUnreadable_AndLeftAsItWas()
    {
        const string before = "{\"output\": ";
        var path = Path.Combine(_source, "Mod.manifest.json");
        File.WriteAllText(path, before);

        var changed = _handler.Change(_source, new SourceManifestChange("Other", [], []));

        Assert.Equal(SourceManifestRefusal.Unreadable, changed.Refusal);
        Assert.Contains(_source.Path, changed.Message, StringComparison.Ordinal);
        Assert.Equal(before, File.ReadAllText(path, Encoding.UTF8));
    }

    [Theory]
    [InlineData("Sub/Name", new string[0], new string[0])]
    [InlineData("..", new string[0], new string[0])]
    [InlineData(null, new[] { "../outside.dds" }, new string[0])]
    [InlineData(null, new[] { "textures\\a.dds" }, new string[0])]
    [InlineData(null, new string[0], new[] { "/rooted.esp" })]
    public void AChangeOutsideTheMod_IsRefusedAsOutsideTheMod_AndTheManifestLeftAsItWas(string? output, string[] exclude, string[] include)
    {
        _folders.WriteSourceManifest(_source, Built);
        var before = File.ReadAllText(Path.Combine(_source, "Old Name.manifest.json"));

        var changed = _handler.Change(_source, new SourceManifestChange(output, exclude, include));

        Assert.Equal(SourceManifestRefusal.OutsideTheMod, changed.Refusal);
        Assert.Equal(before, File.ReadAllText(Path.Combine(_source, "Old Name.manifest.json")));
    }

    [PosixFact]
    public void AManifestTheDiskWillNotLetBeWritten_IsRefusedAsWriteFailed_AndLeftAsItWas()
    {
        _folders.WriteSourceManifest(_source, Built);
        FileModes.Set(_source, "555");
        SourceManifestChangeResult changed;
        try
        {
            changed = _handler.Change(_source, new SourceManifestChange("New Name", [], []));
        }
        finally
        {
            FileModes.Set(_source, "755");
        }

        Assert.Equal(SourceManifestRefusal.WriteFailed, changed.Refusal);
        Assert.Equal(["Old Name.manifest.json"], Directory.GetFiles(_source).Select(Path.GetFileName));
    }
}
