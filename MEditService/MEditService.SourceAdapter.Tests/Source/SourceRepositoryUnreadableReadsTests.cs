using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryUnreadableReadsTests : IDisposable
{
    private const string PluginName = "Unreadable.esp";
    private static readonly PluginAddress Plugin = new(PluginName, TestMod.Name);
    private static readonly GameRelease Release = GameRelease.Fallout4;

    private readonly ScratchDirectory _modFolder = new("medit-unreadable-reads-");
    private readonly Fallout4Mod _mod = new(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

    public void Dispose() => _modFolder.Dispose();

    private static string Root => PluginSourceRoot.For(PluginName);

    private ISourceRepository SourceMod(params TreeFile[] files)
    {
        PluginBaselines.Init(_modFolder, files);
        return TestAdapters.OpenSourceMod(_modFolder, Release);
    }

    private string Unreadable(string relativePath)
    {
        FileModes.Set(Path.Combine(_modFolder, relativePath), "000");
        return relativePath;
    }

    private (string Path, byte[] Text) QuestWithATopic(out DialogTopic topic)
    {
        topic = new DialogTopic(_mod) { EditorID = "Topic" };
        var quest = new Quest(_mod) { EditorID = "Quest" };
        quest.DialogTopics.Add(topic);
        return (
            Path.Combine(Root, "Quests", $"Quest - {quest.FormKey.ID:X6}_{PluginName}.json"),
            Encoding.UTF8.GetBytes(RecordTextCodec.SerializeToText(quest, Release)));
    }

    private static byte[] NpcText(string editorId) =>
        Encoding.UTF8.GetBytes($"{{\"FormKey\": \"000850:{PluginName}\", \"EditorID\": \"{editorId}\"}}");

    private static void AssertStoppedNaming(string relativePath, SourceFailure stopped) =>
        Assert.Contains(relativePath, Assert.IsType<SourceFailure.Inaccessible>(stopped).Reason);

    [PosixTheory]
    [InlineData("Hidden - 000850_Unreadable.esp.json")]
    [InlineData("RenamedByHand.json")]
    public void ARecordByFormKey_WhoseDocumentIsUnreadable_NamedForItOrNot_StopsNamingIt(string leaf)
    {
        var npc = Path.Combine(Root, "Npcs", leaf);
        var repository = SourceMod(new TreeFile(npc, NpcText("Hidden")));

        AssertStoppedNaming(Unreadable(npc), repository.RecordByFormKey(Plugin, $"000850:{PluginName}").Stopped());
    }

    [PosixFact]
    public void AnEmbeddedChildByFormKey_WhoseOwnerIsUnreadable_StopsNamingTheOwner()
    {
        var (questPath, quest) = QuestWithATopic(out var topic);
        var repository = SourceMod(new TreeFile(questPath, quest));

        AssertStoppedNaming(Unreadable(questPath), repository.RecordByFormKey(Plugin, topic.FormKey.ToString()).Stopped());
    }

    [PosixFact]
    public void AnEmbeddedChildByFormKey_WhoseOwnerTurnsUnreadableAfterTheScan_StopsNamingTheOwner()
    {
        var (questPath, quest) = QuestWithATopic(out var topic);
        var repository = SourceMod(new TreeFile(questPath, quest));
        Assert.NotNull(repository.RecordByFormKey(Plugin, topic.FormKey.ToString()).Value());

        AssertStoppedNaming(Unreadable(questPath), repository.RecordByFormKey(Plugin, topic.FormKey.ToString()).Stopped());
    }
}
