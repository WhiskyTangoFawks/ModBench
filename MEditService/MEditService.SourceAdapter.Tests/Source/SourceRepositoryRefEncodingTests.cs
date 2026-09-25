using MEditService.Codec.Serialization;
using MEditService.SourceAdapter;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>Git ref names forbid spaces and brackets, which almost every real Fallout 4 plugin
/// filename contains; the Track/Compile suites' fixtures happen to use ref-safe names.</summary>
public sealed class SourceRepositoryRefEncodingTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-refencoding-").FullName;

    [Fact]
    public void Track_Succeeds_ForASpaceNamedPlugin()
    {
        var modFolder = NewModFolder();
        try
        {
            const string plugin = "LitR - Settings Holotapes Sorting.esp";
            PluginBaselines.Track(
                modFolder, SourcePreset.Edits, [new TreeFile($"source/{plugin}/npc_/{plugin}/000001.json", "{}"u8.ToArray())]);

            Assert.Equal("Track " + plugin, GitProbeSubject(modFolder));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Theory]
    [InlineData("LitR - Settings Holotapes Sorting.esp")]
    [InlineData("[ARRETH] FGEP-DE.esp")]
    public void ParkCompileSnapshot_ThenParkedCompileBinarySha256_RoundTrips_ForARefUnsafeName(string plugin)
    {
        var modFolder = NewModFolder();
        try
        {
            PluginBaselines.Track(
                modFolder, SourcePreset.Edits, [new TreeFile($"source/{plugin}/npc_/{plugin}/000001.json", "{}"u8.ToArray())]);

            SourceRepository.ParkCompileSnapshot(modFolder, plugin, atRef: null, binarySha256: "DEADBEEF");

            Assert.Equal("DEADBEEF", SourceRepository.ParkedCompileBinarySha256(modFolder, plugin));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void CommitBaselinesToMain_Succeeds_ForASpaceNamedPlugin()
    {
        var modFolder = NewModFolder();
        const string plugin = "LitR - Settings Holotapes Sorting.esp";
        var relativePath = $"source/{plugin}/npc_/{plugin}/000001.json";
        try
        {
            SourceRepository.Track(
                modFolder, SourcePreset.Edits,
                [([new TreeFile(relativePath, "{\"old\":true}"u8.ToArray())], new BaselineTrailers(plugin, null, null, "OLDBIN"))]);

            PluginBaselines.CommitToMain(
                modFolder,
                [([new TreeFile(relativePath, "{\"new\":true}"u8.ToArray())], new BaselineTrailers(plugin, null, null, "NEWBIN"))]);

            Assert.Equal("NEWBIN", SourceRepository.ParkedCompileBinarySha256(modFolder, plugin));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    private static string GitProbeSubject(string modFolder) =>
        GitProbe.Run(Path.Combine(modFolder, ".git"), modFolder, "log", "-1", "--format=%s", "main").Trim();
}
