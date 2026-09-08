using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.RealData;

/// <summary>The real cut-down plugin loaded twice from one folder: once before Track, so the binary
/// overlay is what got ingested, and once after, so the source tree Track wrote is.</summary>
public sealed class SourceParityFixture : IDisposable
{
    public const string Origin = "FixtureMod";

    public string ModFolder { get; } = Directory.CreateTempSubdirectory("medit-source-parity-").FullName;
    public IndexProjector FromBinary { get; }
    public IndexProjector FromSource { get; }
    public PluginKey Plugin { get; } = new(CutDownPluginFixture.PluginFileName, Origin);

    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-source-parity-game-").FullName;

    public SourceParityFixture()
    {
        var pluginPath = Path.Combine(ModFolder, CutDownPluginFixture.PluginFileName);
        File.Copy(CutDownPluginFixture.PluginPath, pluginPath);

        FromBinary = NewLoadOrder(pluginPath);

        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(FromBinary.LoadOrder!, Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();

        FromSource = NewLoadOrder(pluginPath);
    }

    private IndexProjector NewLoadOrder(string pluginPath)
    {
        var index = new IndexProjector(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        index.Reconcile(
            _gameDirectory,
            [new LoadOrderEntry(CutDownPluginFixture.PluginFileName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);
        return index;
    }

    public void Dispose()
    {
        FromSource.Dispose();
        FromBinary.Dispose();
        TryDelete(ModFolder);
        TryDelete(_gameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* scratch, best-effort */ }
    }
}
