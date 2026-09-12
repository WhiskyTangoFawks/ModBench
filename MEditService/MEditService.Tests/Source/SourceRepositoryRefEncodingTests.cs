using MEditService.Core.Serialization;
using MEditService.Core.Source;

namespace MEditService.Tests.Source;

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
            var files = new[] { new TreeFile($"source/{plugin}/npc_/{plugin}/000001.json", "{}"u8.ToArray()) };
            var trailers = new TrackProvenance(null, null, new Dictionary<string, string> { [plugin] = "AAAA" });

            SourceRepository.Track(modFolder, SourcePreset.Edits, files, trailers);
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
            var files = new[] { new TreeFile($"source/{plugin}/npc_/{plugin}/000001.json", "{}"u8.ToArray()) };
            var trailers = new TrackProvenance(null, null, new Dictionary<string, string> { [plugin] = "AAAA" });
            SourceRepository.Track(modFolder, SourcePreset.Edits, files, trailers);

            SourceRepository.ParkCompileSnapshot(modFolder, plugin, atRef: null, binarySha256: "DEADBEEF");

            Assert.Equal("DEADBEEF", SourceRepository.ParkedCompileBinarySha256(modFolder, plugin));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void CommitPristineToMain_Succeeds_ForASpaceNamedPlugin()
    {
        var modFolder = NewModFolder();
        const string plugin = "LitR - Settings Holotapes Sorting.esp";
        var relativePath = $"source/{plugin}/npc_/{plugin}/000001.json";
        try
        {
            var files = new[] { new TreeFile(relativePath, "{\"old\":true}"u8.ToArray()) };
            var trailers = new TrackProvenance(null, null, new Dictionary<string, string> { [plugin] = "OLDBIN" });
            SourceRepository.Track(modFolder, SourcePreset.Edits, files, trailers);

            var newFiles = new[] { new TreeFile(relativePath, "{\"new\":true}"u8.ToArray()) };
            var newTrailers = new TrackProvenance(null, null, new Dictionary<string, string> { [plugin] = "NEWBIN" });
            SourceRepository.CommitPristineToMain(modFolder, newFiles, newTrailers);

            Assert.Equal("NEWBIN", SourceRepository.ParkedCompileBinarySha256(modFolder, plugin));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
