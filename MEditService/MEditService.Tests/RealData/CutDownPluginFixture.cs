using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.RealData;

/// <summary>The committed cut-down Fallout 4 plugin: real game data without the 316 MB master, so
/// the fixture is hermetic. Regenerate with <see cref="CutDownPluginGenerator"/> when the schema or
/// curation changes.</summary>
public sealed class CutDownPluginFixture : IDisposable
{
    public const string PluginFileName = "mEditTestSubset.esm";

    public static string PluginPath =>
        Path.Combine(AppContext.BaseDirectory, "TestData", PluginFileName);

    internal DuckDbRecordIndex Repo { get; }

    private readonly IModDisposeGetter _overlay;

    public CutDownPluginFixture()
    {
        var reflector = SharedSchemaReflector.Instance;
        var ddl = new TableDdlBuilder(reflector);

        _overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(PluginFileName), PluginPath), GameRelease.Fallout4);

        Repo = new DuckDbRecordIndex(reflector, ddl, NullLogger.Instance);
        Repo.Initialize(GameRelease.Fallout4);
        Repo.IndexMod(_overlay, Registration.Participating(0), new PluginKey(_overlay.ModKey.FileName.ToString(), "Data"));
        Repo.UpdateWinners();
    }

    public void Dispose()
    {
        Repo.Dispose();
        _overlay.Dispose();
    }
}
