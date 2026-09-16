using MEditService.Codec.Schema;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
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

    // One store file per launch, so each side's rows can be read back from disk on their own.
    public string BinaryInstanceRoot { get; } = Directory.CreateTempSubdirectory("medit-source-parity-binary-").FullName;
    public string SourceInstanceRoot { get; } = Directory.CreateTempSubdirectory("medit-source-parity-source-").FullName;
    public PluginCopyKey Plugin { get; } = new(CutDownPluginFixture.PluginFileName, Origin);

    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-source-parity-game-").FullName;

    public SourceParityFixture()
    {
        var holder = new LoadOrderHolder();
        var pluginPath = Path.Combine(ModFolder, CutDownPluginFixture.PluginFileName);
        File.Copy(CutDownPluginFixture.PluginPath, pluginPath);

        FromBinary = NewLoadOrder(holder, pluginPath, BinaryInstanceRoot);

        new TrackService(NullLogger<TrackService>.Instance, MutagenPluginAdapter.Instance)
            .TrackAsync(FromBinary, holder, Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();

        FromSource = NewLoadOrder(holder, pluginPath, SourceInstanceRoot);
    }

    private IndexProjector NewLoadOrder(LoadOrderHolder holder, string pluginPath, string instanceRoot)
    {
        var index = Indexes.Open(holder);
        index.Reconcile(holder,
            _gameDirectory,
            [new LoadOrderEntry(CutDownPluginFixture.PluginFileName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4,
            instanceRoot);
        return index;
    }

    public void Dispose()
    {
        FromSource.Dispose();
        FromBinary.Dispose();
        TryDelete(ModFolder);
        TryDelete(_gameDirectory);
        TryDelete(BinaryInstanceRoot);
        TryDelete(SourceInstanceRoot);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* scratch, best-effort */ }
    }
}
