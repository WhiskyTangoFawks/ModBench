using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryRefEncodingTests
{
    [Fact]
    public void Track_Succeeds_ForAPluginNameWithSpacesWhichGitRefNamesForbid()
    {
        using var modFolder = new ScratchDirectory("medit-refencoding-");
        const string plugin = "Invented Plugin With Spaces.esp";
        PluginBaselines.Track(
            modFolder, [new TreeFile($"plugin-source/{plugin}/npc_/{plugin}/000001.json", "{}"u8.ToArray())]);

        Assert.Equal("Track " + Path.GetFileName(modFolder), GitProbeSubject(modFolder));
    }

    [Theory]
    [InlineData("Invented Plugin With Spaces.esp")]
    [InlineData("[ARRETH] FGEP-DE.esp")]
    [InlineData("SomePlugin.lock")]
    [InlineData(".hidden..esp")]
    public void WriteBinary_ThenLastWrittenBinarySha256s_RoundTrips_ForANameWhichGitRefNamesForbid(string plugin)
    {
        using var modFolder = new ScratchDirectory("medit-refencoding-");
        var repository = TrackedOver(modFolder, plugin);
        var address = new PluginAddress(plugin, "TestMod");

        repository.WriteBinary(address, "DEADBEEF", () => { }).Value();

        Assert.Equal(["DEADBEEF"], repository.LastWrittenBinarySha256s(address).Value());
    }

    [Fact]
    public void ASpaceName_AndTheUnderscoreNameAnUnderscoreReplacementWouldMergeItWith_RecordTheirOwnBinaries()
    {
        using var modFolder = new ScratchDirectory("medit-refencoding-");
        PluginBaselines.Track(modFolder, [.. FilesOf("A B.esp"), .. FilesOf("A_B.esp")]);
        var repository = SourceRepository.Over(TestMod.In(modFolder), GameRelease.Fallout4);
        var spaced = new PluginAddress("A B.esp", "TestMod");
        var underscored = new PluginAddress("A_B.esp", "TestMod");

        repository.WriteBinary(spaced, "SPACED", () => { }).Value();
        repository.WriteBinary(underscored, "UNDERSCORED", () => { }).Value();

        Assert.Equal(["SPACED"], repository.LastWrittenBinarySha256s(spaced).Value());
        Assert.Equal(["UNDERSCORED"], repository.LastWrittenBinarySha256s(underscored).Value());
    }

    [Fact]
    public void WriteBinary_Throws_ForAnEmptyPluginName()
    {
        using var modFolder = new ScratchDirectory("medit-refencoding-");
        var repository = TrackedOver(modFolder, "Test.esp");

        Assert.Throws<ArgumentException>(() => repository.WriteBinary(new PluginAddress("", "TestMod"), "DEADBEEF", () => { }).Value());
    }

    private static TreeFile[] FilesOf(string plugin) =>
        [new TreeFile($"plugin-source/{plugin}/npc_/{plugin}/000001.json", "{}"u8.ToArray())];

    private static SourceRepository TrackedOver(ScratchDirectory modFolder, string plugin)
    {
        PluginBaselines.Track(modFolder, FilesOf(plugin));
        return SourceRepository.Over(TestMod.In(modFolder), GameRelease.Fallout4);
    }

    private static string GitProbeSubject(string modFolder) =>
        GitProbe.Run(Path.Combine(modFolder, ".git"), modFolder, "log", "-1", "--format=%s", "main").Trim();
}
