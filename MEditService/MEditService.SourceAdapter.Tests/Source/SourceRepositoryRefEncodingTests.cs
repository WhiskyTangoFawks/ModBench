using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryRefEncodingTests
{
    [Theory]
    [InlineData("Invented Plugin With Spaces.esp")]
    [InlineData("[ARRETH] FGEP-DE.esp")]
    [InlineData("SomePlugin.lock")]
    [InlineData(".hidden..esp")]
    public void TheBinaryLastWritten_IsAnsweredForAPluginWhoseNameGitRefNamesForbid(string plugin)
    {
        using var modFolder = new ScratchDirectory("medit-refencoding-");
        var repository = SourceModOver(modFolder, plugin);
        var address = new PluginAddress(plugin, "TestMod");

        repository.WriteBinary(address, "DEADBEEF", () => { }).Value();

        Assert.Equal(["DEADBEEF"], repository.LastWrittenBinarySha256s(address).Value());
    }

    [Fact]
    public void ASpaceName_AndTheUnderscoreNameAnUnderscoreReplacementWouldMergeItWith_RecordTheirOwnBinaries()
    {
        using var modFolder = new ScratchDirectory("medit-refencoding-");
        PluginBaselines.Init(modFolder, [.. FilesOf("A B.esp"), .. FilesOf("A_B.esp")]);
        var repository = TestAdapters.Source().OverFolder(TestMod.In(modFolder), GameRelease.Fallout4);
        var spaced = new PluginAddress("A B.esp", "TestMod");
        var underscored = new PluginAddress("A_B.esp", "TestMod");

        repository.WriteBinary(spaced, "SPACED", () => { }).Value();
        repository.WriteBinary(underscored, "UNDERSCORED", () => { }).Value();

        Assert.Equal(["SPACED"], repository.LastWrittenBinarySha256s(spaced).Value());
        Assert.Equal(["UNDERSCORED"], repository.LastWrittenBinarySha256s(underscored).Value());
    }

    [Fact]
    public void AnEmptyPluginName_IsADefect()
    {
        using var modFolder = new ScratchDirectory("medit-refencoding-");
        var repository = SourceModOver(modFolder, "Test.esp");

        Assert.Throws<ArgumentException>(() => repository.WriteBinary(new PluginAddress("", "TestMod"), "DEADBEEF", () => { }).Value());
    }

    private static TreeFile[] FilesOf(string plugin) =>
        [new TreeFile($"plugin-source/{plugin}/npc_/{plugin}/000001.json", "{}"u8.ToArray())];

    private static ISourceRepository SourceModOver(ScratchDirectory modFolder, string plugin)
    {
        PluginBaselines.Init(modFolder, FilesOf(plugin));
        return TestAdapters.Source().OverFolder(TestMod.In(modFolder), GameRelease.Fallout4);
    }
}
