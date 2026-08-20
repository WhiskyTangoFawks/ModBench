using MEditService.Core.Edits;
using MEditService.Core.Ledger;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>
/// #416 S2/S3: masters are derived from content (ADR-0038), and written in the session's *current*
/// load order — never Mutagen's alphabetical default, and never the plugin's own prior header.
/// </summary>
public sealed class PluginCompileServiceMastersTests : IDisposable
{
    private const string PluginName = "MastersHost.esp";
    private const string BravoName = "Bravo.esm";
    private const string CharlieName = "Charlie.esm";
    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-masters-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-masters-game-").FullName;
    private readonly SessionManager _sessions;
    private readonly PluginKey _plugin = new(PluginName, "MastersMod");
    private readonly FormKey _npc;
    private readonly FormKey _bravoKeyword;
    private readonly FormKey _charlieKeyword;

    // Charlie.esm loads *before* Bravo.esm — deliberately not alphabetical, so an order assertion
    // can't pass by coincidence (mutation review, #416 review's own "name the rival" ask for this
    // green-on-arrival slice).
    public PluginCompileServiceMastersTests()
    {
        var bravoPath = Path.Combine(_gameDirectory, BravoName);
        var bravoMod = new Fallout4Mod(ModKey.FromFileName(BravoName), Fallout4Release.Fallout4);
        var bravoKeyword = bravoMod.Keywords.AddNew("BravoKeyword");
        bravoMod.WriteToBinary(bravoPath);

        var charliePath = Path.Combine(_gameDirectory, CharlieName);
        var charlieMod = new Fallout4Mod(ModKey.FromFileName(CharlieName), Fallout4Release.Fallout4);
        var charlieKeyword = charlieMod.Keywords.AddNew("CharlieKeyword");
        charlieMod.WriteToBinary(charliePath);

        var pluginPath = Path.Combine(_modFolder, PluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew("HostNpc");
        npc.Keywords = [];
        npc.Keywords.Add(new FormLink<IKeywordGetter>(bravoKeyword.FormKey));
        npc.Keywords.Add(new FormLink<IKeywordGetter>(charlieKeyword.FormKey));
        mod.WriteToBinary(pluginPath, new Mutagen.Bethesda.Plugins.Binary.Parameters.BinaryWriteParameters
        {
            MastersListContent = Mutagen.Bethesda.Plugins.Binary.Parameters.MastersListContentOption.Iterate,
        });
        (_npc, _bravoKeyword, _charlieKeyword) = (npc.FormKey, bravoKeyword.FormKey, charlieKeyword.FormKey);

        _sessions = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ISessionManager)_sessions).LoadExplicit(
            _gameDirectory,
            [
                new ExplicitPluginInput(CharlieName, charliePath, "Data", true),
                new ExplicitPluginInput(BravoName, bravoPath, "Data", true),
                new ExplicitPluginInput(PluginName, pluginPath, _plugin.Origin!, true),
            ],
            GameRelease.Fallout4);

        new TrackService(SharedSchemaReflector.Instance, NullLogger<TrackService>.Instance)
            .TrackAsync(_sessions.Session!, _plugin.Origin!, LedgerPreset.Edits)
            .GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        _sessions.Dispose();
        TryDelete(_modFolder);
        TryDelete(_gameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* scratch, best-effort */ }
    }

    private PluginCompileService CompileService() =>
        new(_sessions, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

    [Fact]
    public void Compile_WritesMasters_InCurrentSessionLoadOrder_NotAlphabetical()
    {
        var result = CompileService().Compile(_plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(_modFolder, PluginName);
        using var overlayDisposable = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(PluginName), pluginPath), GameRelease.Fallout4);
        var overlay = (IFallout4ModGetter)overlayDisposable;

        var masterNames = overlay.MasterReferences.Select(m => m.Master.FileName.String).ToList();
        Assert.Equal([CharlieName, BravoName], masterNames);
    }
}
