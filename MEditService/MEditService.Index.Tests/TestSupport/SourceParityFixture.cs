using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>The real cut-down plugin indexed twice from one folder: once before the tree exists, so
/// the binary overlay is what got ingested, and once after, so the source tree is.</summary>
public sealed class SourceParityFixture : IDisposable
{
    public const string Origin = "FixtureMod";

    private readonly ScratchDirectory _modFolder = new("medit-source-parity-");
    private readonly ScratchDirectory _binaryInstance = new("medit-source-parity-binary-");
    private readonly ScratchDirectory _sourceInstance = new("medit-source-parity-source-");
    private readonly ScratchDirectory _game = new("medit-source-parity-game-");

    public string ModFolder => _modFolder.Path;

    internal OpenedIndex FromBinary { get; }
    internal OpenedIndex FromSource { get; }

    // One store file per launch, so each side's rows stand on their own.
    public string BinaryInstanceRoot => _binaryInstance.Path;
    public string SourceInstanceRoot => _sourceInstance.Path;

    public PluginAddress Plugin { get; } = new(RealDataPlugin.PluginFileName, Origin);

    private string _gameDirectory => _game.Path;

    public SourceParityFixture()
    {
        var pluginPath = Path.Combine(ModFolder, RealDataPlugin.PluginFileName);
        File.Copy(RealDataPlugin.PluginPath, pluginPath);

        FromBinary = NewIndex(pluginPath, BinaryInstanceRoot);
        TrackedMods.Track(pluginPath, _gameDirectory);
        FromSource = NewIndex(pluginPath, SourceInstanceRoot);
    }

    private OpenedIndex NewIndex(string pluginPath, string instanceRoot) =>
        Indexes.Reconciled(
            _gameDirectory,
            [new LoadOrderEntry(RealDataPlugin.PluginFileName, pluginPath, Origin, Line: 0, Enabled: true, Winning: true)],
            instanceRoot);

    public void Dispose()
    {
        FromSource.Dispose();
        FromBinary.Dispose();
        _modFolder.Dispose();
        _game.Dispose();
        _binaryInstance.Dispose();
        _sourceInstance.Dispose();
    }
}
