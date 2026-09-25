using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

/// <summary>Masters are derived from content (ADR-0008) and written in the current load order,
/// never Mutagen's alphabetical default or the plugin's own prior header.</summary>
public sealed class PluginCompileServiceMastersTests : IDisposable
{
    private const string PluginName = "MastersHost.esp";
    private const string BravoName = "Bravo.esm";
    private const string CharlieName = "Charlie.esm";
    private const string DeltaName = "Delta.esm";
    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-masters-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-masters-game-").FullName;
    private readonly LoadOrderSnapshot _loadOrder;
    private readonly PluginCopyKey _plugin = new(PluginName, "MastersMod");
    private readonly FormKey _npc;
    private readonly FormKey _bravoKeyword;
    private readonly FormKey _charlieKeyword;
    // Loaded alongside the others but never referenced at Track time —
    // "a cross-plugin reference edit updates the declaring plugin's masters without user action"
    // needs a plugin that provably was *not* already a master before the edit introduces it.
    private readonly FormKey _deltaKeyword;

    // A record in a loaded plugin that is not a Keyword, so a Keywords entry naming it is resolvable
    // and wrong-typed — the diagnostic axis a link into another plugin can only reach this way.
    private readonly FormKey _bravoRace;

    // Charlie.esm loads *before* Bravo.esm — deliberately not alphabetical, so an order assertion
    // can't pass by coincidence.
    public PluginCompileServiceMastersTests()
    {
        var bravoPath = Path.Combine(_gameDirectory, BravoName);
        var bravoMod = new Fallout4Mod(ModKey.FromFileName(BravoName), Fallout4Release.Fallout4);
        var bravoKeyword = bravoMod.Keywords.AddNew("BravoKeyword");
        _bravoRace = bravoMod.Races.AddNew("BravoRace").FormKey;
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

        _loadOrder = new LoadOrderSnapshot(
            _gameDirectory, instanceRoot: null, GameRelease.Fallout4,
            SnapshotCopies.Of([
                new LoadOrderEntry(CharlieName, charliePath, "Data", Slot: 0, Enabled: true, Winning: true),
                new LoadOrderEntry(BravoName, bravoPath, "Data", Slot: 1, Enabled: true, Winning: true),
                new LoadOrderEntry(DeltaName, deltaPath, "Data", Slot: 2, Enabled: true, Winning: true),
                new LoadOrderEntry(PluginName, pluginPath, _plugin.Origin, Slot: 3, Enabled: true, Winning: true),
            ]));

        new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
            .TrackModAsync(_loadOrder, _plugin.Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();
    }

    public void Dispose()
    {
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
        CompileServices.Over(_loadOrder);

    // The set the Index's masters read computed from its references table, now derived by running the
    // collector over the same records (ADR-0008).
    [Fact]
    public async Task Compile_ReportsTheEffectiveMasters_InLoadOrder()
    {
        var result = await CompileService().CompileAsync(_plugin, new CompileSource.WorkingTree());

        Assert.True(result.Succeeded, result.RefusalReason);
        Assert.Equal([CharlieName, BravoName], result.Masters);
    }

    // Compile sees one plugin's records, so a link into a plugin the load order holds is one it
    // cannot answer for; claiming it unresolved would fill the Problems panel with every valid link.
    [Fact]
    public async Task Compile_ForALinkIntoAPluginTheLoadOrderHolds_ReportsNoUnresolvedDiagnostic()
    {
        var result = await CompileService().CompileAsync(_plugin, new CompileSource.WorkingTree());

        Assert.True(result.Succeeded, result.RefusalReason);
        Assert.DoesNotContain(
            result.Diagnostics, d => d.Message.Contains("Could not be resolved", StringComparison.Ordinal));
    }

    // The other half of the Index's masters rule: a plugin whose record this one overrides is a
    // master whether or not anything here references it (ADR-0008).
    [Fact]
    public async Task Compile_ForAnOverrideOfAnotherPluginsRecord_NamesThatPluginAsAMaster()
    {
        SourceEdits.Write(
            SourceRepository.Open(_modFolder, GameRelease.Fallout4).Require(), _plugin,
            new Keyword(_deltaKeyword, Fallout4Release.Fallout4) { EditorID = "DeltaKeyword" },
            "kywd", GameRelease.Fallout4);

        var result = await CompileService().CompileAsync(_plugin, new CompileSource.WorkingTree());

        Assert.True(result.Succeeded, result.RefusalReason);
        Assert.Equal([CharlieName, BravoName, DeltaName], result.Masters);
    }

    // The Index answered this from its global lookup; the link cache answers it from the copy the
    // load order loads, so what the author sees in the Problems panel is unchanged.
    [Fact]
    public async Task Compile_ForALinkIntoAnotherPluginNamingTheWrongRecordType_ReportsIt()
    {
        SourceEdits.Rewrite<Npc>(
            SourceRepository.Open(_modFolder, GameRelease.Fallout4).Require(), _plugin,
            new RecordIdentity(_npc.ToString(), "npc_", "HostNpc"), GameRelease.Fallout4,
            npc => npc.Keywords.Require().Add(new FormLink<IKeywordGetter>(_bravoRace)));

        var result = await CompileService().CompileAsync(_plugin, new CompileSource.WorkingTree());

        Assert.True(result.Succeeded, result.RefusalReason);
        var diagnostic = Assert.Single(
            result.Diagnostics, d => d.Message.Contains("race reference", StringComparison.Ordinal));
        Assert.Equal(_npc.ToString(), diagnostic.FormKey);
        Assert.Equal("Keywords: [2]: Found a race reference, expected: kywd", diagnostic.Message);
    }

    [Fact]
    public async Task Compile_WritesMasters_InCurrentLoadOrder_NotAlphabetical()
    {
        var result = await CompileService().CompileAsync(_plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(_modFolder, PluginName);
        using var overlayDisposable = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(PluginName), pluginPath), GameRelease.Fallout4);
        var overlay = (IFallout4ModGetter)overlayDisposable;

        var masterNames = overlay.MasterReferences.Select(m => m.Master.FileName.String).ToList();
        Assert.Equal([CharlieName, BravoName], masterNames);
    }

    // Written into the tracked source after Track rather than pre-baked into the baseline. DeltaName
    // is loaded but never referenced at Track time, so it provably is not yet a master.
    [Fact]
    public async Task Compile_AfterAnEditIntroducesAReferenceToAnUnreferencedPlugin_AddsItAsAMaster()
    {
        SourceEdits.Rewrite<Npc>(
            SourceRepository.Open(_modFolder, GameRelease.Fallout4).Require(), _plugin,
            new RecordIdentity(_npc.ToString(), "npc_", "HostNpc"), GameRelease.Fallout4,
            npc => npc.Keywords.Require().Add(new FormLink<IKeywordGetter>(_deltaKeyword)));

        var result = await CompileService().CompileAsync(_plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(_modFolder, PluginName);
        using var overlayDisposable = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(PluginName), pluginPath), GameRelease.Fallout4);
        var overlay = (IFallout4ModGetter)overlayDisposable;

        var masterNames = overlay.MasterReferences.Select(m => m.Master.FileName.String).ToList();
        Assert.Contains(DeltaName, masterNames);
        // Load order (Charlie, Bravo, Delta all precede MastersHost), not the order the edit listed
        // FormKeys in: the same ADR-0008 claim, against a master this edit makes effective.
        Assert.Equal([CharlieName, BravoName, DeltaName], masterNames);
    }
}
