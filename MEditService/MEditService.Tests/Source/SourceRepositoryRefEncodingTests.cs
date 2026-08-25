using MEditService.Core.Source;

namespace MEditService.Tests.Source;

/// <summary>
/// #433: <c>refs/medit/last-compile/&lt;plugin&gt;</c> is built by interpolating the plugin's raw
/// filename, and git ref names forbid spaces, <c>[</c>/<c>]</c> and several other characters that
/// almost every real Fallout 4 plugin filename contains — this is the regression coverage the issue
/// asks for "at the layer this is cheapest to catch": <see cref="SourceRepository"/>'s own unit
/// tests, against real-world-shaped names, not just the higher-level Track/Compile suites whose
/// fixtures happened to use ref-safe names.
/// </summary>
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
            var files = new[] { new PristineFile($"{plugin}.source/npc_/{plugin}/000001.json", "{}"u8.ToArray()) };
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
            var files = new[] { new PristineFile($"{plugin}.source/npc_/{plugin}/000001.json", "{}"u8.ToArray()) };
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
        var relativePath = $"{plugin}.source/npc_/{plugin}/000001.json";
        try
        {
            var files = new[] { new PristineFile(relativePath, "{\"old\":true}"u8.ToArray()) };
            var trailers = new TrackProvenance(null, null, new Dictionary<string, string> { [plugin] = "OLDBIN" });
            SourceRepository.Track(modFolder, SourcePreset.Edits, files, trailers);

            var newFiles = new[] { new PristineFile(relativePath, "{\"new\":true}"u8.ToArray()) };
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
