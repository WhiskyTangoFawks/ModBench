using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>The real cut-down plugin indexed twice from one folder: once before the tree exists, so
/// the binary overlay is what got ingested, and once after, so the source tree is.</summary>
public sealed class SourceParityFixture : IDisposable
{
    public const string Origin = "FixtureMod";

    public string ModFolder { get; } = Directory.CreateTempSubdirectory("medit-source-parity-").FullName;

    internal Indexer FromBinary { get; }
    internal Indexer FromSource { get; }

    // One store file per launch, so each side's rows stand on their own.
    private readonly string _binaryInstanceRoot = Directory.CreateTempSubdirectory("medit-source-parity-binary-").FullName;
    private readonly string _sourceInstanceRoot = Directory.CreateTempSubdirectory("medit-source-parity-source-").FullName;

    public PluginAddress Plugin { get; } = new(RealDataPlugin.PluginFileName, Origin);

    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-source-parity-game-").FullName;

    public SourceParityFixture()
    {
        var pluginPath = Path.Combine(ModFolder, RealDataPlugin.PluginFileName);
        File.Copy(RealDataPlugin.PluginPath, pluginPath);

        FromBinary = NewIndex(pluginPath, _binaryInstanceRoot);
        TrackedMods.Track(pluginPath, _gameDirectory);
        FromSource = NewIndex(pluginPath, _sourceInstanceRoot);
    }

    private Indexer NewIndex(string pluginPath, string instanceRoot) =>
        Indexes.Reconciled(
            _gameDirectory,
            [new LoadOrderEntry(RealDataPlugin.PluginFileName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)],
            instanceRoot);

    public void Dispose()
    {
        FromSource.Dispose();
        FromBinary.Dispose();
        TryDelete(ModFolder);
        TryDelete(_gameDirectory);
        TryDelete(_binaryInstanceRoot);
        TryDelete(_sourceInstanceRoot);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
