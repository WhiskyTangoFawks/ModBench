using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Indexing;

public sealed class ContainerChildIndexingTests : IDisposable
{
    private static readonly PluginAddress Key = new("Dialogue.esp", PluginOrigin.DataDirectory);

    private readonly PluginFixtureData _fixture;
    private readonly string _questFk;
    private readonly string _topic0Fk;
    private readonly string _topic1Fk;
    private readonly string _response0Fk;
    private readonly string _response1Fk;
    private readonly string _cellFk;
    private readonly string _placedFk;

    public ContainerChildIndexingTests()
    {
        FormKey quest = default, topic0 = default, topic1 = default, response0 = default, response1 = default;
        FormKey cell = default, placed = default;
        _fixture = new PluginFixtureBuilder("container-child")
            .WithPlugin(Key.Name, mod =>
            {
                var q = mod.Quests.AddNew("TestQuest");
                var t0 = new DialogTopic(mod) { EditorID = "Topic0" };
                var r0 = new DialogResponses(mod) { EditorID = "Response0" };
                var r1 = new DialogResponses(mod) { EditorID = "Response1" };
                t0.Responses.Add(r0);
                t0.Responses.Add(r1);
                var t1 = new DialogTopic(mod) { EditorID = "Topic1" };
                q.DialogTopics.Add(t0);
                q.DialogTopics.Add(t1);

                var c = new Cell(mod) { EditorID = "PlacedCell" };
                var placedObject = new PlacedObject(mod) { EditorID = "PlacedInCell" };
                c.Persistent.Add(placedObject);
                var intSub = new CellSubBlock { BlockNumber = 0 };
                intSub.Cells.Add(c);
                var intBlock = new CellBlock { BlockNumber = 0 };
                intBlock.SubBlocks.Add(intSub);
                mod.Cells.Records.Add(intBlock);

                (quest, topic0, topic1, response0, response1) = (q.FormKey, t0.FormKey, t1.FormKey, r0.FormKey, r1.FormKey);
                (cell, placed) = (c.FormKey, placedObject.FormKey);
            })
            .Build();
        (_questFk, _topic0Fk, _topic1Fk, _response0Fk, _response1Fk) =
            (quest.ToString(), topic0.ToString(), topic1.ToString(), response0.ToString(), response1.ToString());
        (_cellFk, _placedFk) = (cell.ToString(), placed.ToString());
    }

    public void Dispose() => _fixture.Dispose();

    private static List<(string FormKey, string RecordType)> Children(OpenedIndex index, string parentFormKey) =>
        [.. index.Queries.GetContainerChildren(Key, parentFormKey).Value().Select(c => (c.FormKey, c.RecordType))];

    [Fact]
    public void AQuestsDialogTopics_AreItsChildren()
    {
        using var index = Indexes.Reconciled(_fixture);

        Assert.Equal([(_topic0Fk, "dial"), (_topic1Fk, "dial")], Children(index, _questFk));
    }

    [Fact]
    public void ADialogTopicsResponses_AreItsChildren()
    {
        using var index = Indexes.Reconciled(_fixture);

        Assert.Equal([(_response0Fk, "info"), (_response1Fk, "info")], Children(index, _topic0Fk));
    }

    [Fact]
    public void ACellsPlacedRef_IsListedOnce_InItsPlacementGroup()
    {
        using var index = Indexes.Reconciled(_fixture);
        var children = index.Queries.GetCellChildRecords(Key, _cellFk).Value();

        Assert.Single(children.Persistent.Concat(children.Temporary), c => c.FormKey == _placedFk);
        Assert.Equal("persistent", index.PlacementGroupIn(Key, _cellFk, _placedFk));
    }

    [Fact]
    public void ADeletedPlugin_LeavesNoContainerChildren()
    {
        using var index = Indexes.Reconciled(_fixture);
        Assert.NotEmpty(Children(index, _questFk));

        File.Delete(_fixture.Plugins.Single().Path);
        index.NextSnapshot();

        Assert.Empty(Children(index, _questFk));
        Assert.Empty(Children(index, _topic0Fk));
    }
}
