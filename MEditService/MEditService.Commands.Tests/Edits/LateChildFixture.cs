using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

/// <summary>A source quest whose own FormKey comes from a plugin that loads before the destination, and
/// whose dialog topic comes from one that loads after it.</summary>
public sealed class LateChildFixture : TestInstance, ITrackedPlugins
{
    private const string EarlyName = "Early.esm";
    private const string LateName = "Late.esm";

    public string DestinationModFolder => FolderOf("DestinationMod");
    public PluginAddress SourcePlugin { get; }
    public PluginAddress DestinationPlugin { get; }
    public FormKey Quest { get; }

    public LateChildFixture()
    {
        var early = new ModKey(Path.GetFileNameWithoutExtension(EarlyName), ModType.Master);
        var late = new ModKey(Path.GetFileNameWithoutExtension(LateName), ModType.Master);
        Quest = new FormKey(early, 0x800);

        var source = new Fallout4Mod(ModKey.FromFileName("Source.esp"), Fallout4Release.Fallout4);
        var quest = new Quest(Quest, Fallout4Release.Fallout4) { EditorID = "OverriddenQuest" };
        quest.DialogTopics.Add(new DialogTopic(new FormKey(late, 0x800), Fallout4Release.Fallout4) { EditorID = "LateTopic" });
        source.Quests.Add(quest);

        Add(new Fallout4Mod(early, Fallout4Release.Fallout4), "EarlyMod", tracked: false);
        DestinationPlugin = Add(new Fallout4Mod(ModKey.FromFileName("Destination.esp"), Fallout4Release.Fallout4), "DestinationMod");
        Add(new Fallout4Mod(late, Fallout4Release.Fallout4), "LateMod", tracked: false);
        SourcePlugin = Add(source, "SourceMod", tracked: false);
    }
}
