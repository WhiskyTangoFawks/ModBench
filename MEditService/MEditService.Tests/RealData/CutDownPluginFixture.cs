using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.RealData;

/// <summary>
/// Loads and indexes the committed cut-down Fallout 4 plugin
/// (<see cref="PluginFileName"/>) — a small slice of real game data used to exercise the
/// indexing pipeline (worldspace/cell/placement/VMAD) against authentic records without the
/// 316 MB master. The file is checked in and copied to the output directory, so this fixture is
/// hermetic and needs no game install.
///
/// Regenerate the plugin with <see cref="CutDownPluginGenerator"/> when the schema or curation
/// changes.
/// </summary>
public sealed class CutDownPluginFixture : IDisposable
{
    public const string PluginFileName = "mEditTestSubset.esm";

    public static string PluginPath =>
        Path.Combine(AppContext.BaseDirectory, "TestData", PluginFileName);

    public DuckDbRecordRepository Repo { get; }

    private readonly IModDisposeGetter _overlay;

    public CutDownPluginFixture()
    {
        var reflector = new SchemaReflector();
        var ddl = new TableDdlBuilder(reflector);

        _overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(PluginFileName), PluginPath), GameRelease.Fallout4);

        Repo = new DuckDbRecordRepository(reflector, ddl, NullLogger.Instance);
        Repo.Initialize(GameRelease.Fallout4);
        Repo.Index(_overlay, 0);
        Repo.UpdateWinners();
    }

    public void Dispose()
    {
        Repo.Dispose();
        _overlay.Dispose();
    }
}
