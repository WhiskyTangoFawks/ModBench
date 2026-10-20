using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompilePluginMastersTests : IDisposable
{
    private const string PluginName = "MastersHost.esp";
    private const string BravoName = "Bravo.esm";
    private const string CharlieName = "Charlie.esm";
    private const string DeltaName = "Delta.esm";
    private readonly ScratchDirectory _modFolder = new("medit-masters-");
    private readonly ScratchDirectory _dataFolder = new("medit-masters-data-");
    private readonly List<LoadOrderEntry> _entries;
    private readonly LoadOrderSnapshot _loadOrder;
    private readonly PluginAddress _plugin = new(PluginName, "MastersMod");
    private readonly FormKey _npc;
    private readonly FormKey _bravoKeyword;
    private readonly FormKey _charlieKeyword;
    private readonly FormKey _deltaKeyword;

    private readonly FormKey _bravoRace;

    public CompilePluginMastersTests()
    {
        var bravoPath = Path.Combine(_dataFolder, BravoName);
        var bravoMod = new Fallout4Mod(ModKey.FromFileName(BravoName), Fallout4Release.Fallout4);
        var bravoKeyword = bravoMod.Keywords.AddNew("BravoKeyword");
        _bravoRace = bravoMod.Races.AddNew("BravoRace").FormKey;
        bravoMod.WriteToBinary(bravoPath);

        var charliePath = Path.Combine(_dataFolder, CharlieName);
        var charlieMod = new Fallout4Mod(ModKey.FromFileName(CharlieName), Fallout4Release.Fallout4);
        var charlieKeyword = charlieMod.Keywords.AddNew("CharlieKeyword");
        charlieMod.WriteToBinary(charliePath);

        var deltaPath = Path.Combine(_dataFolder, DeltaName);
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

        _entries =
        [
            new LoadOrderEntry(CharlieName, charliePath, PluginOrigin.DataDirectory, Line: 0, Enabled: true, Winning: true),
            new LoadOrderEntry(BravoName, bravoPath, PluginOrigin.DataDirectory, Line: 1, Enabled: true, Winning: true),
            new LoadOrderEntry(DeltaName, deltaPath, PluginOrigin.DataDirectory, Line: 2, Enabled: true, Winning: true),
            new LoadOrderEntry(PluginName, pluginPath, _plugin.Origin, Line: 3, Enabled: true, Winning: true),
        ];
        _loadOrder = SnapshotPlugins.Snapshot(_dataFolder, instanceRoot: null, GameRelease.Fallout4, _entries);

        DecompileAndCommitEveryPluginOf.ModAsync(_loadOrder, _plugin.Origin)
            .GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        _modFolder.Dispose();
        _dataFolder.Dispose();
    }

    private CompilePluginHandler CompileService() =>
        CompileServices.Over(_loadOrder);

    [Fact]
    public async Task Compile_ForALinkIntoAPluginTheLoadOrderHolds_ReportsNoUnresolvedDiagnostic()
    {
        var answer = (await CompileService().CompileAsync([_plugin])).Value();

        Assert.Empty(answer.Refused);
        var diagnostics = Assert.Single(answer.Applied).Diagnostics;
        Assert.DoesNotContain(
            diagnostics, d => d.Message.Contains("Could not be resolved", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Compile_WhenTheLoadOrderLacksAMasterTheSourceReferences_IsRefusedNamingIt_AndLeavesTheBinary()
    {
        var binary = File.ReadAllBytes(Path.Combine(_modFolder, PluginName));
        var withoutBravo = SnapshotPlugins.Snapshot(_dataFolder, instanceRoot: null, GameRelease.Fallout4, _entries.Where(entry => entry.Name != BravoName));

        var answer = (await CompileServices.Over(withoutBravo).CompileAsync([_plugin])).Value();

        var refused = Assert.Single(answer.Refused);
        Assert.Equal(
            (CompileRefusal.MasterNotInLoadOrder, $"{PluginName} could not be compiled: it references {BravoName}, which the load order does not hold"),
            (refused.Refusal, refused.Message));
        Assert.Equal(binary, File.ReadAllBytes(Path.Combine(_modFolder, PluginName)));
    }

    [Fact]
    public async Task Compile_ForAnOverrideOfAnotherPluginsRecord_NamesThatPluginAsAMaster()
    {
        SourceEdits.Write(
            TestAdapters.Source().Open(TestMod.Of(_plugin, _modFolder), GameRelease.Fallout4).Require(), _plugin,
            new Keyword(_deltaKeyword, Fallout4Release.Fallout4) { EditorID = "DeltaKeyword" },
            "kywd", GameRelease.Fallout4);

        var answer = (await CompileService().CompileAsync([_plugin])).Value();

        Assert.Empty(answer.Refused);
        Assert.Single(answer.Applied);

        using var overlayDisposable = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(PluginName), Path.Combine(_modFolder, PluginName)), GameRelease.Fallout4);
        var overlay = (IFallout4ModGetter)overlayDisposable;
        Assert.Equal(
            [CharlieName, BravoName, DeltaName], overlay.MasterReferences.Select(m => m.Master.FileName.String));
    }

    [Fact]
    public async Task Compile_ForALinkIntoAnotherPluginNamingTheWrongRecordType_ReportsIt()
    {
        SourceEdits.Rewrite<Npc>(
            TestAdapters.Source().Open(TestMod.Of(_plugin, _modFolder), GameRelease.Fallout4).Require(), _plugin,
            new RecordIdentity(_npc.ToString(), "npc_", "HostNpc"), GameRelease.Fallout4,
            npc => npc.Keywords.Require().Add(new FormLink<IKeywordGetter>(_bravoRace)));

        var answer = (await CompileService().CompileAsync([_plugin])).Value();

        Assert.Empty(answer.Refused);
        var diagnostics = Assert.Single(answer.Applied).Diagnostics;
        var diagnostic = Assert.Single(
            diagnostics, d => d.Message.Contains("RACE reference", StringComparison.Ordinal));
        Assert.Equal(_npc.ToString(), diagnostic.FormKey);
        Assert.Equal("Keywords: [2]: Found a RACE reference, expected: KYWD", diagnostic.Message);
    }

    [Fact]
    public async Task Compile_WritesMasters_InCurrentLoadOrder_NotAlphabetical()
    {
        var answer = (await CompileService().CompileAsync([_plugin])).Value();
        Assert.Empty(answer.Refused);
        Assert.Single(answer.Applied);

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
            TestAdapters.Source().Open(TestMod.Of(_plugin, _modFolder), GameRelease.Fallout4).Require(), _plugin,
            new RecordIdentity(_npc.ToString(), "npc_", "HostNpc"), GameRelease.Fallout4,
            npc => npc.Keywords.Require().Add(new FormLink<IKeywordGetter>(_deltaKeyword)));

        var answer = (await CompileService().CompileAsync([_plugin])).Value();
        Assert.Empty(answer.Refused);
        Assert.Single(answer.Applied);

        var pluginPath = Path.Combine(_modFolder, PluginName);
        using var overlayDisposable = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(PluginName), pluginPath), GameRelease.Fallout4);
        var overlay = (IFallout4ModGetter)overlayDisposable;

        var masterNames = overlay.MasterReferences.Select(m => m.Master.FileName.String).ToList();
        Assert.Contains(DeltaName, masterNames);
        Assert.Equal([CharlieName, BravoName, DeltaName], masterNames);
    }
}
