using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using MEditService.TestSupport.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Indexing;

/// <summary>Slots already answered by the placement reads must not get a second, competing copy
/// among the container children.</summary>
public sealed class ContainerChildIndexingTests : IDisposable
{
    private static readonly PluginCopyKey Key = new("Dialogue.esp", "Data");

    private readonly PluginFixtureData _fixture;
    private readonly string _questFk;
    private readonly string _topic0Fk;
    private readonly string _topic1Fk;
    private readonly string _response0Fk;
    private readonly string _response1Fk;
    private readonly string _cellFk;
    private readonly string _navMesh0Fk;
    private readonly string _landscapeFk;
    private readonly string _placedFk;

    public ContainerChildIndexingTests()
    {
        FormKey quest = default, topic0 = default, topic1 = default, response0 = default, response1 = default;
        FormKey cell = default, navMesh0 = default, landscape = default, placed = default;
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

                var c = new Cell(mod) { EditorID = "NavCell" };
                var nav = new NavigationMesh(mod);
                c.NavigationMeshes.Add(nav);
                var land = new Landscape(mod);
                c.Landscape = land;
                var placedObject = new PlacedObject(mod) { EditorID = "PlacedInNavCell" };
                c.Persistent.Add(placedObject);
                var intSub = new CellSubBlock { BlockNumber = 0 };
                intSub.Cells.Add(c);
                var intBlock = new CellBlock { BlockNumber = 0 };
                intBlock.SubBlocks.Add(intSub);
                mod.Cells.Records.Add(intBlock);

                (quest, topic0, topic1, response0, response1) = (q.FormKey, t0.FormKey, t1.FormKey, r0.FormKey, r1.FormKey);
                (cell, navMesh0, landscape, placed) = (c.FormKey, nav.FormKey, land.FormKey, placedObject.FormKey);
            })
            .Build();
        (_questFk, _topic0Fk, _topic1Fk, _response0Fk, _response1Fk) =
            (quest.ToString(), topic0.ToString(), topic1.ToString(), response0.ToString(), response1.ToString());
        (_cellFk, _navMesh0Fk, _landscapeFk, _placedFk) =
            (cell.ToString(), navMesh0.ToString(), landscape.ToString(), placed.ToString());
    }

    public void Dispose() => _fixture.Dispose();

    private static List<(string ChildFormKey, string SlotName, int SlotIndex)> Children(IRecordReads reads, string parentFormKey) =>
        [.. reads.GetContainerChildren(Key, parentFormKey)
            .OrderBy(r => r.SlotName, StringComparer.Ordinal).ThenBy(r => r.SlotIndex)
            .Select(r => (r.ChildFormKey, r.SlotName, r.SlotIndex))];

    [Fact]
    public void Index_PopulatesQuestDialogTopics_InOriginalOrder()
    {
        using var index = Indexes.Reconciled(_fixture);
        var rows = Children(index.RequireReads(), _questFk).Where(r => r.SlotName == "DialogTopics").ToList();

        Assert.Equal([(_topic0Fk, "DialogTopics", 0), (_topic1Fk, "DialogTopics", 1)], rows);
    }

    [Fact]
    public void Index_PopulatesDialogTopicResponses_InOriginalOrder()
    {
        using var index = Indexes.Reconciled(_fixture);
        var rows = Children(index.RequireReads(), _topic0Fk);

        Assert.Equal([(_response0Fk, "Responses", 0), (_response1Fk, "Responses", 1)], rows);
    }

    [Fact]
    public void Index_PopulatesCellNavigationMeshesAndLandscape()
    {
        using var index = Indexes.Reconciled(_fixture);
        var rows = Children(index.RequireReads(), _cellFk);

        Assert.Contains((_navMesh0Fk, "NavigationMeshes", 0), rows);
        Assert.Contains((_landscapeFk, "Landscape", 0), rows);
    }

    // The placement reads already answer Persistent/Temporary/TopCell/SubCells, so the container
    // children must never carry a second, competing copy of those slots.
    [Fact]
    public void Index_DoesNotDuplicate_RelationshipsAlreadyCoveredByPlacementReads()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();

        Assert.NotNull(reads.GetPlacement(_placedFk, Key));
        Assert.DoesNotContain(Children(reads, _cellFk), r => r.SlotName is "Persistent" or "Temporary" or "TopCell" or "SubCells");
        Assert.Null(reads.GetContainerParent(Key, _placedFk));
    }

    [Fact]
    public async Task Unindex_RemovesContainerChildRows()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();
        Assert.NotEmpty(reads.GetContainerChildren(Key, _questFk));

        File.Delete(_fixture.Plugins.Single().Path);
        Assert.True(await index.RefreshBinary(Key, _fixture.Plugins.Single().Path));

        Assert.Empty(reads.GetContainerChildren(Key, _questFk));
        Assert.Empty(reads.GetContainerChildren(Key, _topic0Fk));
        Assert.Null(reads.GetContainerParent(Key, _topic0Fk));
    }
}
