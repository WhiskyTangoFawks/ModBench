using System.Text;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceToBuildTests : IDisposable
{
    private readonly ScratchDirectory _root = new("medit-source-to-build-");
    private readonly string _sourceFolder;

    public SourceToBuildTests() => _sourceFolder = Directory.CreateDirectory(Path.Combine(_root, TestMod.Name)).FullName;

    public void Dispose() => _root.Dispose();

    [Fact]
    public void AnInitializedSource_BuildsItsOutputFromTheBaseInitRecorded_ItsAssetsAndItsPlugins()
    {
        Assert.Null(TestAdapters.Source().Init(
            _sourceFolder, "The Output", [DoorTreeOf("B.esp"), DoorTreeOf("A.esp")],
            [new Asset("textures/Sub Folder/a.dds", () => new MemoryStream("texture"u8.ToArray()))],
            [new BaseFile("meshes/b.nif", "Mod-1.7z", "00 Core/meshes/b.nif"), new BaseFile("Mod.ba2", "Mod-1.7z", "Mod.ba2")]));

        var source = Built();

        Assert.Equal("The Output", source.Output);
        Assert.Equal(
            [new BaseFile("meshes/b.nif", "Mod-1.7z", "00 Core/meshes/b.nif"), new BaseFile("Mod.ba2", "Mod-1.7z", "Mod.ba2")],
            source.Base);
        Assert.Equal(["A.esp", "B.esp"], source.Plugins);
        var asset = Assert.Single(source.Assets);
        Assert.Equal("textures/Sub Folder/a.dds", asset.Path);
        using var opened = new StreamReader(asset.Open());
        Assert.Equal("texture", opened.ReadToEnd());
        Assert.Empty(source.Exclude);
        Assert.Empty(source.Archives);
    }

    [Fact]
    public void AConfiguration_NamesTheExclusionsAndEachArchiveToPackWithItsFiles()
    {
        WriteBuildJson("""
            {
              "output": "Mod",
              "exclude": ["textures/b.dds", "meshes"],
              "archives": { "Mod - Main.ba2": ["meshes/a.nif", "scripts/a.pex"], "Mod - Textures.ba2": ["textures/a.dds"] }
            }
            """);

        var source = Built();

        Assert.Equal(["textures/b.dds", "meshes"], source.Exclude);
        Assert.Equal(
            [("Mod - Main.ba2", new[] { "meshes/a.nif", "scripts/a.pex" }), ("Mod - Textures.ba2", new[] { "textures/a.dds" })],
            source.Archives.Select(archive => (archive.Path, archive.Files.ToArray())));
        Assert.Empty(source.Plugins);
        Assert.Empty(source.Assets);
    }

    [Fact]
    public void AFolderWithNoConfiguration_IsUnreadable_NamingIt()
    {
        var failure = TestAdapters.Source().SourceToBuild(_sourceFolder).Stopped();

        Assert.Equal($"'{_sourceFolder}' holds no build configuration.", Assert.IsType<SourceFailure.Unreadable>(failure).Reason);
    }

    [Theory]
    [InlineData("{\"exclude\": []}", "it names no output")]
    [InlineData("{\"output\": 1}", "it names no output")]
    [InlineData("{\"output\": \"../Other\"}", "its output '../Other' is not a folder name")]
    [InlineData("{\"output\": \"Mod\", \"exclude\": [\"../outside\"]}", "its 'exclude' names '../outside', which is not a path in the mod folder")]
    [InlineData("{\"output\": \"Mod\", \"base\": {\"Mod.7z\": {\"/etc/a\": \"a\"}}}", "its 'base' names '/etc/a', which is not a path in the mod folder")]
    [InlineData("{\"output\": \"Mod\", \"base\": {\"Mod.7z\": [\"a\"]}}", "its 'base' is not each installation file's paths with their entries")]
    [InlineData("{\"output\": \"Mod\", \"archives\": {\"a\\\\b.ba2\": []}}", "its 'archives' names 'a\\b.ba2', which is not a path in the mod folder")]
    [InlineData("{\"output\": \"Mod\", \"archives\": [\"Mod.ba2\"]}", "its 'archives' is not each archive's paths")]
    public void AConfigurationThatDoesNotSayWhatToBuild_IsUnreadable_SayingWhy(string configuration, string why)
    {
        WriteBuildJson(configuration);

        var failure = TestAdapters.Source().SourceToBuild(_sourceFolder).Stopped();

        Assert.Equal(
            $"The build configuration in '{_sourceFolder}' cannot be read: {why}.",
            Assert.IsType<SourceFailure.Unreadable>(failure).Reason);
    }

    [PosixFact]
    public void AssetsWhosePathsDifferOnlyInCase_AreUnreadable_NamingBoth()
    {
        WriteBuildJson("{\"output\": \"Mod\"}");
        WriteAsset("Scripts/a.pex");
        WriteAsset("scripts/A.pex");

        var failure = TestAdapters.Source().SourceToBuild(_sourceFolder).Stopped();

        Assert.Equal(
            $"'{Path.Combine(_sourceFolder, "assets")}' holds 'Scripts/a.pex' and 'scripts/A.pex', which differ only in case: one mod folder cannot hold both on Windows.",
            Assert.IsType<SourceFailure.Unreadable>(failure).Reason);
    }

    private void WriteAsset(string path)
    {
        var file = Path.Combine(_sourceFolder, "assets", path);
        Directory.CreateDirectory(Path.GetDirectoryName(file).Require());
        File.WriteAllText(file, path);
    }

    private SourceToBuild Built() => TestAdapters.Source().SourceToBuild(_sourceFolder).Value();

    private void WriteBuildJson(string text) =>
        File.WriteAllText(Path.Combine(_sourceFolder, "build.json"), text, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));

    private static (IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin) DoorTreeOf(string plugin) =>
        ([new TreeFile($"npc_/{plugin}/000001.json", "{}"u8.ToArray())], new DecompiledPlugin(plugin, null));
}
