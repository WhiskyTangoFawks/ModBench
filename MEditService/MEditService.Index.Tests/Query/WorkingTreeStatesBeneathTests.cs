using System.Text.Json.Nodes;
using MEditService.Codec.Serialization;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Query;

public sealed class WorkingTreeStatesBeneathTests : IDisposable
{
    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);
    private static readonly WorkingTreeState[] ModifiedAndAdded = [WorkingTreeState.Modified, WorkingTreeState.Added];

    private readonly IndexedContainerMod _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private OpenedIndex Index => _fixture.Index;

    private WorkingTreeStatesBeneath Beneath() => Index.Records.GetWorkingTreeStatesBeneath(_fixture.Plugin);

    private void AddARefToTheTopCellItsWorldspacesDocumentEmbeds()
    {
        var cell = JsonNode.Parse(Index.BodyOf(_fixture.TopCell, _fixture.Plugin))?.AsObject()
            ?? throw new InvalidOperationException("Expected the top cell's body to be an object.");
        var temporary = cell["Temporary"]?.AsArray()
            ?? throw new InvalidOperationException("Expected the top cell to hold temporary refs.");
        var added = temporary[0]?.DeepClone().AsObject()
            ?? throw new InvalidOperationException("Expected a temporary ref to copy.");
        added["FormKey"] = FormKey.Factory($"000F10:{ContainerMod.PluginName}").ToString();
        added["EditorID"] = "AddedRef";
        temporary.Add(added);
        Index.Project(_fixture.Entry,
            [(_fixture.TopCell, Codec.RoundTrip(cell.ToJsonString(), GameRelease.Fallout4, "cell"))]);
    }

    private void RenameTheNpc() =>
        Index.Edit(_fixture.Entry, Index.DocumentOf(_fixture.Npc, _fixture.Plugin),
            Index.BodyOf(_fixture.Npc, _fixture.Plugin).Replace(ContainerMod.NpcEditorId, "RenamedNpc", StringComparison.Ordinal));

    [Fact]
    public void ARefAddedToAModifiedCell_IsBeneathTheCellAsAdded_AndBeneathEachRowAboveAsBoth()
    {
        AddARefToTheTopCellItsWorldspacesDocumentEmbeds();

        var beneath = Beneath();

        Assert.Equal(ModifiedAndAdded, beneath.Plugin);
        Assert.Equal(ModifiedAndAdded, Assert.Single(beneath.RecordTypes, group => group.Key == "wrld").Value);
        Assert.Equal(
            new Dictionary<string, WorkingTreeState[]>
            {
                [_fixture.Worldspace] = ModifiedAndAdded,
                [_fixture.TopCell] = [WorkingTreeState.Added],
            },
            beneath.Records.ToDictionary(row => row.Key, row => row.Value.ToArray()));
    }

    [Fact]
    public void ARecordWithNothingBeneathIt_ShowsItsChangeOnlyInItsGroup_AndItsPlugin()
    {
        RenameTheNpc();

        var beneath = Beneath();

        Assert.Equal([WorkingTreeState.Modified], beneath.Plugin);
        Assert.Equal([WorkingTreeState.Modified], Assert.Single(beneath.RecordTypes).Value);
        Assert.Empty(beneath.Records);
    }

    [Fact]
    public void AnEditedTopic_IsBeneathItsQuest()
    {
        const string questPlugin = "Quests.esp";
        const string quest = "000800:Quests.esp";
        const string topic = "000801:Quests.esp";
        using var fixture = new PluginFixtureBuilder("working-tree-states-beneath-quest")
            .WithPlugin(questPlugin, mod =>
            {
                var owner = new Quest(FormKey.Factory(quest), Fallout4Release.Fallout4) { EditorID = "OwnerQuest" };
                owner.DialogTopics.Add(new DialogTopic(FormKey.Factory(topic), Fallout4Release.Fallout4) { EditorID = "HeldTopic" });
                mod.Quests.Add(owner);
            }, origin: "QuestMod")
            .BuildScattered()
            .Tracked();
        var entry = fixture.Plugins.Single();
        using var index = Indexes.Reconciled(fixture);
        index.Edit(entry, index.DocumentOf(topic, entry.KeyOf()),
            index.BodyOf(topic, entry.KeyOf()).Replace("HeldTopic", "RenamedTopic", StringComparison.Ordinal));

        var beneath = index.Records.GetWorkingTreeStatesBeneath(entry.KeyOf());

        Assert.Equal([WorkingTreeState.Modified], Assert.Single(beneath.RecordTypes, group => group.Key == "qust").Value);
        Assert.Equal([WorkingTreeState.Modified], Assert.Single(beneath.Records, row => row.Key == quest).Value);
    }

    [Fact]
    public void AChangeInOneOriginsPlugin_IsBeneathNoRowOfAnotherOriginsPluginOfTheSameName()
    {
        const string sharedName = "Shared.esp";
        string placed = "";
        void HoldingAPlacedRef(Fallout4Mod mod)
        {
            var cell = new Cell(mod) { EditorID = "SharedCell" };
            var reference = new PlacedObject(mod) { EditorID = "SharedRef" };
            cell.Persistent.Add(reference);
            var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
            subBlock.Cells.Add(cell);
            var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
            block.SubBlocks.Add(subBlock);
            mod.Cells.Records.Add(block);
            placed = reference.FormKey.ToString();
        }
        using var fixture = new PluginFixtureBuilder("working-tree-states-beneath-origins")
            .WithPlugin(sharedName, HoldingAPlacedRef)
            .WithPlugin(sharedName, HoldingAPlacedRef, origin: "SharedMod")
            .BuildScattered();
        var tracked = fixture.Plugins.Single(p => p.Origin == "SharedMod");
        TrackedMods.Track(tracked, fixture.GameDirectory);
        using var index = Indexes.Reconciled(fixture);
        index.Edit(tracked, index.DocumentOf(placed, tracked.KeyOf()),
            index.BodyOf(placed, tracked.KeyOf()).Replace("SharedRef", "RenamedRef", StringComparison.Ordinal));
        Assert.NotEmpty(index.Records.GetWorkingTreeStatesBeneath(tracked.KeyOf()).Records);

        var otherOrigin = index.Records.GetWorkingTreeStatesBeneath(new PluginAddress(sharedName, PluginOrigin.DataDirectory));

        Assert.Empty(otherOrigin.Plugin);
        Assert.Empty(otherOrigin.Records);
    }

    [Fact]
    public void ARecordFilterThatHidesEveryChangedRow_LeavesNothingBeneathAnyRow()
    {
        AddARefToTheTopCellItsWorldspacesDocumentEmbeds();

        Index.SetFilter($"SELECT '{_fixture.Npc}' AS form_key", "npc.sql");
        var beneath = Beneath();

        Assert.Empty(beneath.Plugin);
        Assert.Empty(beneath.RecordTypes);
        Assert.Empty(beneath.Records);
    }
}
