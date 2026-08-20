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
    private const string DeltaName = "Delta.esm";
    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-masters-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-masters-game-").FullName;
    private readonly SessionManager _sessions;
    private readonly PluginKey _plugin = new(PluginName, "MastersMod");
    private readonly FormKey _npc;
    private readonly FormKey _bravoKeyword;
    private readonly FormKey _charlieKeyword;
    // Loaded alongside the others but never referenced at Track time — AC2's own fixture:
    // "a cross-plugin reference edit updates the declaring plugin's masters without user action"
    // needs a plugin that provably was *not* already a master before the edit introduces it.
    private readonly FormKey _deltaKeyword;

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

        var deltaPath = Path.Combine(_gameDirectory, DeltaName);
        var deltaMod = new Fallout4Mod(ModKey.FromFileName(DeltaName), Fallout4Release.Fallout4);
        var deltaKeyword = deltaMod.Keywords.AddNew("DeltaKeyword");
        deltaMod.WriteToBinary(deltaPath);
        _deltaKeyword = deltaKeyword.FormKey;

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
                new ExplicitPluginInput(DeltaName, deltaPath, "Data", true),
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

    // #416 review (AC2 gap): the literal scenario the AC names — "a cross-plugin reference edit
    // updates the declaring plugin's masters without user action" — exercised through the real edit
    // door (RecordEditService), not pre-baked into the tracked baseline. DeltaName is loaded but
    // never referenced at Track time, so it provably isn't a master before this edit runs.
    [Fact]
    public void Compile_AfterAnEditIntroducesAReferenceToAPreviouslyUnreferencedPlugin_AddsItAsAMaster()
    {
        var editResult = new RecordEditService(_sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance)
            .EditField(_plugin, _npc.ToString(), "keywords",
                System.Text.Json.JsonDocument.Parse(
                    System.Text.Json.JsonSerializer.Serialize(new[]
                    {
                        _bravoKeyword.ToString(), _charlieKeyword.ToString(), _deltaKeyword.ToString(),
                    })).RootElement);
        Assert.True(editResult.Applied, editResult.Message);

        var result = CompileService().Compile(_plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(_modFolder, PluginName);
        using var overlayDisposable = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(PluginName), pluginPath), GameRelease.Fallout4);
        var overlay = (IFallout4ModGetter)overlayDisposable;

        var masterNames = overlay.MasterReferences.Select(m => m.Master.FileName.String).ToList();
        Assert.Contains(DeltaName, masterNames);
        // Load order (Charlie, Bravo, Delta all precede MastersHost in that order), not the order
        // the edit happened to list FormKeys in — the same ADR-0038/#416 S2 claim, now checked
        // against a master this test's own edit is what makes effective at all.
        Assert.Equal([CharlieName, BravoName, DeltaName], masterNames);
    }
}
