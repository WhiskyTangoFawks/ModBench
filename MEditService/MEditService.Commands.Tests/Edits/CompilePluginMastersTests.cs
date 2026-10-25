using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompilePluginMastersTests : TestInstance
{
    private const string PluginName = "MastersHost.esp";
    private const string BravoName = "Bravo.esm";
    private const string CharlieName = "Charlie.esm";
    private const string DeltaName = "Delta.esm";

    private readonly PluginAddress _plugin;
    private readonly FormKey _npc;
    private readonly FormKey _deltaKeyword;

    public CompilePluginMastersTests()
    {
        var charlie = Master(CharlieName, "CharlieKeyword");
        var bravo = Master(BravoName, "BravoKeyword");
        _deltaKeyword = Master(DeltaName, "DeltaKeyword");

        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        mod.ModHeader.MasterReferences.AddRange([
            new MasterReference { Master = ModKey.FromFileName(BravoName) },
            new MasterReference { Master = ModKey.FromFileName(CharlieName) },
        ]);
        var npc = mod.Npcs.AddNew("HostNpc");
        npc.Keywords = [new FormLink<IKeywordGetter>(bravo), new FormLink<IKeywordGetter>(charlie)];
        _npc = npc.FormKey;
        _plugin = Add(mod, "MastersMod");
    }

    private FormKey Master(string name, string keywordEditorId)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
        var keyword = mod.Keywords.AddNew(keywordEditorId).FormKey;
        Add(mod, PluginOrigin.DataDirectory, compiledPlugin: false);
        return keyword;
    }

    private string BinaryPath => Path.Combine(ModFolderOf(_plugin), PluginName);

    [Fact]
    public async Task Compile_WhenTheLoadOrderLacksAMasterTheSourceReferences_IsRefusedNamingIt_AndLeavesTheBinary()
    {
        var binary = File.ReadAllBytes(BinaryPath);
        var withoutBravo = SnapshotPlugins.Snapshot(DataFolder, instanceRoot: null, GameRelease.Fallout4, Entries.Where(entry => entry.Name != BravoName));

        var answer = (await CompileServices.Over(withoutBravo).CompileAsync([_plugin])).Value();

        var refused = Assert.Single(answer.Refused);
        Assert.Equal(
            (CompileRefusal.MasterNotInLoadOrder, $"{PluginName} could not be compiled: it references {BravoName}, which the load order does not hold"),
            (refused.Refusal, refused.Message));
        Assert.Equal(binary, File.ReadAllBytes(BinaryPath));
    }

    [Fact]
    public async Task Compile_WritesMasters_InCurrentLoadOrder_NotAlphabetical()
    {
        using var compiled = await this.CompiledAsync(_plugin);

        Assert.Equal([CharlieName, BravoName], compiled.MasterReferences.Select(m => m.Master.FileName.String));
    }

    public static TheoryData<string, Action<CompilePluginMastersTests>> EditsReachingDelta => new()
    {
        {
            "an override of its record",
            test => SourceEdits.Write(
                test.RepositoryOf(test._plugin).Require(), test._plugin,
                new Keyword(test._deltaKeyword, Fallout4Release.Fallout4) { EditorID = "DeltaKeyword" },
                "kywd", GameRelease.Fallout4)
        },
        {
            "a link to its record",
            test => SourceEdits.Rewrite<Npc>(
                test.RepositoryOf(test._plugin).Require(), test._plugin,
                new RecordIdentity(test._npc.ToString(), "npc_", "HostNpc"), GameRelease.Fallout4,
                npc => npc.Keywords.Require().Add(new FormLink<IKeywordGetter>(test._deltaKeyword)))
        },
    };

    [Theory]
    [MemberData(nameof(EditsReachingDelta))]
    public async Task Compile_AfterAnEditReachingAPluginNoMasterNamed_AddsItAsAMaster_InLoadOrder(string _, Action<CompilePluginMastersTests> edit)
    {
        edit(this);

        using var compiled = await this.CompiledAsync(_plugin);

        Assert.Equal([CharlieName, BravoName, DeltaName], compiled.MasterReferences.Select(m => m.Master.FileName.String));
    }
}
