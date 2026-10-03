using MEditService.Codec.Serialization;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryRefEncodingTests
{
    [Fact]
    public void Track_Succeeds_ForAPluginNameWithSpacesWhichGitRefNamesForbid()
    {
        using var modFolder = new ScratchDirectory("medit-refencoding-");
        const string plugin = "LitR - Settings Holotapes Sorting.esp";
        PluginBaselines.Track(
            modFolder, SourcePreset.Edits, [new TreeFile($"plugin-source/{plugin}/npc_/{plugin}/000001.json", "{}"u8.ToArray())]);

        Assert.Equal("Track " + plugin, GitProbeSubject(modFolder));
    }

    [Theory]
    [InlineData("LitR - Settings Holotapes Sorting.esp")]
    [InlineData("[ARRETH] FGEP-DE.esp")]
    public void ParkCompileSnapshot_ThenParkedCompileBinarySha256s_RoundTrips_ForANameWithSpacesOrBracketsWhichGitRefNamesForbid(string plugin)
    {
        using var modFolder = new ScratchDirectory("medit-refencoding-");
        PluginBaselines.Track(
            modFolder, SourcePreset.Edits, [new TreeFile($"plugin-source/{plugin}/npc_/{plugin}/000001.json", "{}"u8.ToArray())]);

        SourceRepository.ParkCompileSnapshot(modFolder, plugin, binarySha256: "DEADBEEF");

        Assert.Equal(["DEADBEEF"], SourceRepository.ParkedCompileBinarySha256s(modFolder, plugin));
    }

    private static string GitProbeSubject(string modFolder) =>
        GitProbe.Run(Path.Combine(modFolder, ".git"), modFolder, "log", "-1", "--format=%s", "main").Trim();
}
