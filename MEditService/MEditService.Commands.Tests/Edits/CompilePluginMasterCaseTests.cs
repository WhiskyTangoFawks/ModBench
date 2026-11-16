using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompilePluginMasterCaseTests : TestInstance
{
    private const string LoadOrderSpelling = "Upper.esp";
    private const string SourceSpelling = "UPPER.ESP";

    private readonly PluginAddress _plugin;
    private readonly FormKey _npc;
    private readonly List<FormKey> _keywords = [];

    public CompilePluginMasterCaseTests()
    {
        var master = new Fallout4Mod(ModKey.FromFileName(LoadOrderSpelling), Fallout4Release.Fallout4);
        foreach (var editorId in new[] { "First", "Second" }) _keywords.Add(master.Keywords.AddNew(editorId).FormKey);
        Add(master, PluginOrigin.DataDirectory, compiledPlugin: false);

        var mod = new Fallout4Mod(ModKey.FromFileName("CaseHost.esp"), Fallout4Release.Fallout4);
        _npc = mod.Npcs.AddNew("HostNpc").FormKey;
        _plugin = Add(mod, "CaseMod");
    }

    [Fact]
    public async Task Compile_WhenTheSourceSpellsAMasterInTwoCases_WritesTheLoadOrdersSpelling_AndKeepsEveryReference()
    {
        SourceEdits.Rewrite<Npc>(
            RepositoryOf(_plugin).Require(), _plugin, new RecordIdentity(_npc.ToString(), "npc_", "HostNpc"), GameRelease.Fallout4,
            npc => npc.Keywords = [.. _keywords.Zip([SourceSpelling, LoadOrderSpelling], (key, spelling) =>
                new FormLink<IKeywordGetter>(new FormKey(ModKey.FromFileName(spelling), key.ID)))]);

        using var compiled = await this.CompiledAsync(_plugin);

        Assert.Equal([LoadOrderSpelling], compiled.MasterReferences.Select(m => m.Master.FileName.String));
        Assert.Equal(
            _keywords.Select(key => key.ID),
            compiled.Npcs.Single().Keywords.Require().Select(link => link.FormKey.ID));
    }
}
