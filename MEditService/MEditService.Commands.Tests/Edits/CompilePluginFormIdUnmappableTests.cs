using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompilePluginFormIdUnmappableTests : TestInstance
{
    private const string MasterName = "Master.esm";
    private const string QuestEditorId = "LinkingQuest";
    private const string Origin = "LinkingMod";
    private static readonly FormKey MasterRecord = FormKey.Factory($"000800:{MasterName}");

    private readonly PluginAddress _plugin;
    private readonly FormKey _quest;

    public CompilePluginFormIdUnmappableTests()
    {
        Add(new Fallout4Mod(ModKey.FromFileName(MasterName), Fallout4Release.Fallout4), PluginOrigin.DataDirectory, tracked: false);
        var mod = new Fallout4Mod(ModKey.FromFileName("Linking.esp"), Fallout4Release.Fallout4);
        var quest = mod.Quests.AddNew(QuestEditorId);
        _quest = quest.FormKey;
        _plugin = Add(mod, Origin);
    }

    [Fact]
    public async Task Compile_OfASourceLinkingAMasterOnlyAStructListPropertyNames_IsRefusedNamingTheRecordAndTheMaster_LeavingTheModFolderHoldingTheSameFiles()
    {
        SourceEdits.Rewrite<Quest>(
            RepositoryOf(_plugin).Require(), _plugin, new RecordIdentity(_quest.ToString(), "qust", QuestEditorId),
            GameRelease.Fallout4, quest => quest.VirtualMachineAdapter = LinkingAdapter());

        var before = ModFolderFiles();

        var answer = await CompileHandler.CompileAsync([_plugin]);

        var refused = Assert.Single(answer.Refused);
        Assert.Equal(CompileRefusal.FormIdUnmappable, refused.Refusal);
        Assert.Contains(QuestEditorId, refused.Message, StringComparison.Ordinal);
        Assert.Contains(MasterName, refused.Message, StringComparison.Ordinal);
        Assert.Equal(before, ModFolderFiles());
    }

    private string[] ModFolderFiles() =>
        [.. Directory.EnumerateFileSystemEntries(FolderOf(Origin)).Order(StringComparer.Ordinal)];

    private static QuestAdapter LinkingAdapter()
    {
        var adapter = new QuestAdapter { Version = 6, ObjectFormat = 2 };
        var script = new ScriptEntry { Name = "Linker", Flags = ScriptEntry.Flag.Local };
        var structs = new ScriptStructListProperty { Name = "Links", Flags = ScriptProperty.Flag.Edited };
        var instance = new ScriptEntryStructs();
        var link = new ScriptObjectProperty { Name = "Target", Flags = ScriptProperty.Flag.Edited };
        link.Object.SetTo(MasterRecord);
        instance.Members.Add(link);
        structs.Structs.Add(instance);
        script.Properties.Add(structs);
        adapter.Scripts.Add(script);
        return adapter;
    }
}
