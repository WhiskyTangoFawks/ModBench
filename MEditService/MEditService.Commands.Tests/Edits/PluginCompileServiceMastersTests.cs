using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

public sealed class PluginCompileServiceMastersTests : IDisposable
{
    private const string PluginName = "MastersHost.esp";
    private const string BravoName = "Bravo.esm";
    private const string CharlieName = "Charlie.esm";
    private const string DeltaName = "Delta.esm";
    private readonly ScratchDirectory _modFolder = new("medit-masters-");
    private readonly ScratchDirectory _gameDirectory = new("medit-masters-game-");
    private readonly LoadOrderSnapshot _loadOrder;
    private readonly PluginAddress _plugin = new(PluginName, "MastersMod");
    private readonly FormKey _npc;
    private readonly FormKey _bravoKeyword;
    private readonly FormKey _charlieKeyword;
    private readonly FormKey _deltaKeyword;

    private readonly FormKey _bravoRace;

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

        _loadOrder = SnapshotPlugins.Snapshot(
            _gameDirectory, instanceRoot: null, GameRelease.Fallout4,
            [
                new LoadOrderEntry(CharlieName, charliePath, "Data", Slot: 0, Enabled: true, Winning: true),
                new LoadOrderEntry(BravoName, bravoPath, "Data", Slot: 1, Enabled: true, Winning: true),
                new LoadOrderEntry(DeltaName, deltaPath, "Data", Slot: 2, Enabled: true, Winning: true),
                new LoadOrderEntry(PluginName, pluginPath, _plugin.Origin, Slot: 3, Enabled: true, Winning: true),
            ]);

        new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
            .TrackModAsync(_loadOrder, _plugin.Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        _modFolder.Dispose();
        _gameDirectory.Dispose();
    }

    private PluginCompileService CompileService() =>
        CompileServices.Over(_loadOrder);

    [Fact]
    public async Task Compile_ReportsTheEffectiveMasters_InLoadOrder()
    {
        var result = await CompileService().CompileAsync(_plugin);

        Assert.True(result.Succeeded, result.RefusalReason);
        Assert.Equal([CharlieName, BravoName], result.Masters);
    }

    [Fact]
    public async Task Compile_ForALinkIntoAPluginTheLoadOrderHolds_ReportsNoUnresolvedDiagnostic()
    {
        var result = await CompileService().CompileAsync(_plugin);

        Assert.True(result.Succeeded, result.RefusalReason);
        Assert.DoesNotContain(
            result.Diagnostics, d => d.Message.Contains("Could not be resolved", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Compile_ForAnOverrideOfAnotherPluginsRecord_NamesThatPluginAsAMaster()
    {
        SourceEdits.Write(
            SourceRepository.Open(_modFolder, GameRelease.Fallout4).Require(), _plugin,
            new Keyword(_deltaKeyword, Fallout4Release.Fallout4) { EditorID = "DeltaKeyword" },
            "kywd", GameRelease.Fallout4);

        var result = await CompileService().CompileAsync(_plugin);

        Assert.True(result.Succeeded, result.RefusalReason);
        Assert.Equal([CharlieName, BravoName, DeltaName], result.Masters);
    }

    [Fact]
    public async Task Compile_ForALinkIntoAnotherPluginNamingTheWrongRecordType_ReportsIt()
    {
        SourceEdits.Rewrite<Npc>(
            SourceRepository.Open(_modFolder, GameRelease.Fallout4).Require(), _plugin,
            new RecordIdentity(_npc.ToString(), "npc_", "HostNpc"), GameRelease.Fallout4,
            npc => npc.Keywords.Require().Add(new FormLink<IKeywordGetter>(_bravoRace)));

        var result = await CompileService().CompileAsync(_plugin);

        Assert.True(result.Succeeded, result.RefusalReason);
        var diagnostic = Assert.Single(
            result.Diagnostics, d => d.Message.Contains("race reference", StringComparison.Ordinal));
        Assert.Equal(_npc.ToString(), diagnostic.FormKey);
        Assert.Equal("Keywords: [2]: Found a race reference, expected: kywd", diagnostic.Message);
    }

    [Fact]
    public async Task Compile_WritesMasters_InCurrentLoadOrder_NotAlphabetical()
    {
        var result = await CompileService().CompileAsync(_plugin);
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(_modFolder, PluginName);
        using var overlayDisposable = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(PluginName), pluginPath), GameRelease.Fallout4);
        var overlay = (IFallout4ModGetter)overlayDisposable;

        var masterNames = overlay.MasterReferences.Select(m => m.Master.FileName.String).ToList();
        Assert.Equal([CharlieName, BravoName], masterNames);
    }

    [Fact]
    public async Task Compile_AfterAnEditIntroducesAReferenceToAnUnreferencedPlugin_AddsItAsAMaster()
    {
        SourceEdits.Rewrite<Npc>(
            SourceRepository.Open(_modFolder, GameRelease.Fallout4).Require(), _plugin,
            new RecordIdentity(_npc.ToString(), "npc_", "HostNpc"), GameRelease.Fallout4,
            npc => npc.Keywords.Require().Add(new FormLink<IKeywordGetter>(_deltaKeyword)));

        var result = await CompileService().CompileAsync(_plugin);
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(_modFolder, PluginName);
        using var overlayDisposable = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(PluginName), pluginPath), GameRelease.Fallout4);
        var overlay = (IFallout4ModGetter)overlayDisposable;

        var masterNames = overlay.MasterReferences.Select(m => m.Master.FileName.String).ToList();
        Assert.Contains(DeltaName, masterNames);
        Assert.Equal([CharlieName, BravoName, DeltaName], masterNames);
    }
}
