using MEditService.Codec.Serialization;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryTrackParkedRefTests
{
    [Fact]
    public void Track_ParksEachPluginsLastCompileRef_AtItsOwnBaselineCommit()
    {
        using var modFolder = new ScratchDirectory("medit-track-parkedref-");
        PluginBaselines.Track(
            modFolder, SourcePreset.Edits,
            [
                new TreeFile("plugin-source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray()),
                new TreeFile("plugin-source/Other.esp/npc_/Other.esp/000002.json", "{}"u8.ToArray()),
            ]);

        var gitDir = Path.Combine(modFolder, ".git");
        Assert.Equal(
            GitProbe.Run(gitDir, modFolder, "rev-parse", "main~1").Trim(),
            GitProbe.Run(gitDir, modFolder, "rev-parse", "refs/medit/last-compile/Test.esp").Trim());
        Assert.Equal(
            GitProbe.Run(gitDir, modFolder, "rev-parse", "main").Trim(),
            GitProbe.Run(gitDir, modFolder, "rev-parse", "refs/medit/last-compile/Other.esp").Trim());
    }
}
