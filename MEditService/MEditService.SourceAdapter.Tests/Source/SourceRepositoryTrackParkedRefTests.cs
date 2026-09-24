using MEditService.Codec.Serialization;
using MEditService.SourceAdapter;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>Each plugin's parked ref points at its own baseline commit's SHA (no second commit object),
/// since that commit holds exactly the tree Track read from the binary (ADR-0003).</summary>
public sealed class SourceRepositoryTrackParkedRefTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-track-parkedref-").FullName;

    [Fact]
    public void Track_ParksEachPluginsLastCompileRef_AtItsOwnBaselineCommit()
    {
        var modFolder = NewModFolder();
        try
        {
            PluginBaselines.Track(
                modFolder, SourcePreset.Edits,
                [
                    new TreeFile("source/Test.esp/npc_/Test.esp/000001.json", "{}"u8.ToArray()),
                    new TreeFile("source/Other.esp/npc_/Other.esp/000002.json", "{}"u8.ToArray()),
                ]);

            var gitDir = Path.Combine(modFolder, ".git");
            Assert.Equal(
                GitProbe.Run(gitDir, modFolder, "rev-parse", "main~1").Trim(),
                GitProbe.Run(gitDir, modFolder, "rev-parse", "refs/medit/last-compile/Test.esp").Trim());
            Assert.Equal(
                GitProbe.Run(gitDir, modFolder, "rev-parse", "main").Trim(),
                GitProbe.Run(gitDir, modFolder, "rev-parse", "refs/medit/last-compile/Other.esp").Trim());
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
