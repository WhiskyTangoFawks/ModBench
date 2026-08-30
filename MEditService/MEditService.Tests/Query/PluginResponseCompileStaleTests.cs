using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Source;

namespace MEditService.Tests.Query;

/// <summary>
/// #449: <see cref="PluginResponse.FromMetadata"/> wires <see cref="Core.Source.ModFolders.CompileFreshnessOf"/>
/// onto the wire — the seam a stale/never-updated implementation of that delegation would leave every
/// plugin reporting <c>CompileStale: false</c> regardless of real git state.
/// </summary>
public sealed class PluginResponseCompileStaleTests
{
    private const string Plugin = "Test.esp";
    private const string RelPath = "source/Test.esp/npc_/Test.esp/000001.json";

    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-pluginresponse-compilestale-").FullName;

    private static PluginMetadata MetadataFor(string modFolder, string origin) =>
        new(Plugin, Path.Combine(modFolder, Plugin), 0, false, false, [], 0, false, origin, Enabled: true, Winning: true);

    [Fact]
    public void FromMetadata_ForATrackedPluginEditedSinceItsLastCompile_ReportsCompileStaleTrue()
    {
        var modFolder = NewModFolder();
        try
        {
            var files = new[] { new PristineFile(RelPath, "{}"u8.ToArray()) };
            var trailers = new TrackProvenance(null, null, new Dictionary<string, string> { [Plugin] = "AAAA" });
            SourceRepository.Track(modFolder, SourcePreset.Edits, files, trailers);
            File.WriteAllText(Path.Combine(modFolder, RelPath), "{\"edited\":true}");

            var response = PluginResponse.FromMetadata(MetadataFor(modFolder, "SomeMod"));

            Assert.True(response.CompileStale);
            Assert.NotNull(response.LastCompiledAt);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void FromMetadata_ForATrackedPluginWithNoChangesSinceItsLastCompile_ReportsCompileStaleFalse()
    {
        var modFolder = NewModFolder();
        try
        {
            var files = new[] { new PristineFile(RelPath, "{}"u8.ToArray()) };
            var trailers = new TrackProvenance(null, null, new Dictionary<string, string> { [Plugin] = "AAAA" });
            SourceRepository.Track(modFolder, SourcePreset.Edits, files, trailers);

            var response = PluginResponse.FromMetadata(MetadataFor(modFolder, "SomeMod"));

            Assert.False(response.CompileStale);
            Assert.NotNull(response.LastCompiledAt);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void FromMetadata_ForAnUntrackedPlugin_NeverReportsCompileStale()
    {
        var modFolder = NewModFolder();
        try
        {
            Directory.CreateDirectory(modFolder);
            File.WriteAllText(Path.Combine(modFolder, Plugin), "not really a plugin");

            var response = PluginResponse.FromMetadata(MetadataFor(modFolder, "SomeMod"));

            Assert.False(response.CompileStale);
            Assert.Null(response.LastCompiledAt);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void FromMetadata_ForAPluginWithNoModFolder_NeverReportsCompileStale()
    {
        // A vanilla/DLC master resolved from the game's Data directory — PluginOrigin.DataDirectory,
        // the same "no mod folder at all" case IsEditable/IsTracked already degrade over.
        var metadata = new PluginMetadata("Fallout4.esm", "/data/Fallout4.esm", 0, false, true, [], 0, true, PluginOrigin.DataDirectory, Enabled: true, Winning: true);

        var response = PluginResponse.FromMetadata(metadata);

        Assert.False(response.CompileStale);
        Assert.Null(response.LastCompiledAt);
    }
}
