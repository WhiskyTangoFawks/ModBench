using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Commands.Tests.Edits;

/// <summary>The container counterpart to SourceEditFixture, which holds only flat records. No
/// index anywhere in it (ADR-0015); the handlers below still need Commands, unlike
/// the shared container shape.</summary>
public sealed class ContainerModFixture : TestInstance, ITrackedPlugin
{
    public const string ModFolderOrigin = "ContainerFixtureMod";
    public const string PluginName = "ContainerFixture.esp";

    public string ModFolder => FolderOf(ModFolderOrigin);
    public PluginAddress Plugin { get; }

    public const string NpcEditorId = "FixtureNpc";
    public FormKey Npc { get; }

    public FormKey Cell { get; }

    public FormKey EmbedCell { get; }

    public FormKey TemporaryRef { get; }

    public FormKey PersistentRef { get; }

    public FormKey Navmesh { get; }

    public FormKey Landscape { get; }

    public FormKey Worldspace { get; }

    public FormKey TopCell { get; }

    public FormKey TopCellRef { get; }

    public FormKey ExteriorCell { get; }

    public FormKey ExteriorRef { get; }

    public const string QuestEditorId = "EmbedQuest";
    public FormKey Quest { get; }

    public const string DialogTopicEditorId = "EmbedTopic";
    public FormKey DialogTopic { get; }

    // Two responses inline in the first topic's document: a sibling is what shows an edit, a delete
    // or a FormID edit touching only its own element, and two is the shortest list with an order.
    public const string ResponseEditorId = "EmbedResponse";
    public FormKey Response { get; }

    public const string Response2EditorId = "EmbedResponse2";
    public FormKey Response2 { get; }

    // Two more siblings under the same Quest, so a delete or FormID edit of a mid-list topic has
    // an actual middle and two survivors to pin the compiled GRUP order of.
    public const string DialogTopic2EditorId = "EmbedTopic2";
    public FormKey DialogTopic2 { get; }

    public const string DialogTopic3EditorId = "EmbedTopic3";
    public FormKey DialogTopic3 { get; }

    // The quest's other two child slots, one record each.
    public const string DialogBranchEditorId = "EmbedBranch";
    public FormKey DialogBranch { get; }

    public const string SceneEditorId = "EmbedScene";
    public FormKey Scene { get; }

    // The first response's own array field, seeded with two lines so an array op on an embedded
    // child has an order to change.
    public static readonly byte[] ResponseLineNumbers = [1, 2];

    public ContainerModFixture()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

        var npc = mod.Npcs.AddNew(NpcEditorId);
        var containerKeys = ContainerModPlugin.AddTo(mod);

        var exteriorCell = new Cell(mod) { EditorID = "ExteriorCell", Grid = new CellGrid() };
        var exteriorRef = new PlacedObject(mod) { EditorID = "ExteriorRef", Position = new P3Float(100f, 100f, 0f), Scale = 1f };
        exteriorCell.Temporary.Add(exteriorRef);
        mod.Worldspaces.AddNew("ExteriorWorld").SubCells.Add(CellBlocks.Exterior(exteriorCell));

        var quest = new Quest(mod) { EditorID = QuestEditorId };
        var dialogTopic = new DialogTopic(mod) { EditorID = DialogTopicEditorId };
        var response = new DialogResponses(mod) { EditorID = ResponseEditorId };
        foreach (var line in ResponseLineNumbers) response.Responses.Add(new DialogResponse { ResponseNumber = line });
        var response2 = new DialogResponses(mod) { EditorID = Response2EditorId };
        dialogTopic.Responses.Add(response);
        dialogTopic.Responses.Add(response2);
        var dialogTopic2 = new DialogTopic(mod) { EditorID = DialogTopic2EditorId };
        var dialogTopic3 = new DialogTopic(mod) { EditorID = DialogTopic3EditorId };
        quest.DialogTopics.Add(dialogTopic);
        quest.DialogTopics.Add(dialogTopic2);
        quest.DialogTopics.Add(dialogTopic3);
        var dialogBranch = new DialogBranch(mod) { EditorID = DialogBranchEditorId };
        quest.DialogBranches.Add(dialogBranch);
        var scene = new Scene(mod) { EditorID = SceneEditorId };
        quest.Scenes.Add(scene);
        mod.Quests.Add(quest);

        Plugin = Add(mod, ModFolderOrigin);

        Npc = npc.FormKey;
        Cell = containerKeys.Cell;
        (EmbedCell, TemporaryRef, PersistentRef) = (containerKeys.EmbedCell, containerKeys.TemporaryRef, containerKeys.PersistentRef);
        (Navmesh, Landscape) = (containerKeys.Navmesh, containerKeys.Landscape);
        (Worldspace, TopCell, TopCellRef) = (containerKeys.Worldspace, containerKeys.TopCell, containerKeys.TopCellRef);
        (ExteriorCell, ExteriorRef) = (exteriorCell.FormKey, exteriorRef.FormKey);
        (Quest, DialogTopic) = (quest.FormKey, dialogTopic.FormKey);
        (Response, Response2) = (response.FormKey, response2.FormKey);
        (DialogTopic2, DialogTopic3) = (dialogTopic2.FormKey, dialogTopic3.FormKey);
        (DialogBranch, Scene) = (dialogBranch.FormKey, scene.FormKey);
    }
}
