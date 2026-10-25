using System.Text.Json;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Indexing;

public sealed class ContainerOwnDocumentTests
{
    private const string PluginName = "Containers.esp";
    private const string Origin = "ContainersMod";
    private static readonly PluginAddress Plugin = new(PluginName, Origin);

    private sealed class Fixture : IDisposable
    {
        private readonly ScatteredFixtureData _data;

        public Fixture(bool compiledPlugin)
        {
            ContainerModPlugin.Keys keys = default;
            FormKey quest = default, topic = default, response = default;
            _data = new PluginFixtureBuilder("container-own-document")
                .WithPlugin(PluginName, mod =>
                {
                    keys = ContainerModPlugin.AddTo(mod);
                    var q = mod.Quests.AddNew("OwnQuest");
                    var t = new DialogTopic(mod) { EditorID = "OwnTopic" };
                    var r = new DialogResponses(mod) { EditorID = "OwnResponse" };
                    t.Responses.Add(r);
                    q.DialogTopics.Add(t);
                    (quest, topic, response) = (q.FormKey, t.FormKey, r.FormKey);
                }, origin: Origin)
                .BuildScattered();
            if (compiledPlugin) _data.CompiledPlugin();
            (Keys, Quest, Topic, Response) = (keys, quest.ToString(), topic.ToString(), response.ToString());
            Index = Indexes.Reconciled(_data);
        }

        public ContainerModPlugin.Keys Keys { get; }
        public string Quest { get; }
        public string Topic { get; }
        public string Response { get; }
        public OpenedIndex Index { get; }
        public LoadOrderEntry Entry => _data.Plugins.Single();

        public JsonElement Stored(string formKey) =>
            JsonDocument.Parse(Index.Queries.GetRenderedDocument(Plugin, formKey).Value()?.Text
                ?? throw new InvalidOperationException($"Expected the record index to store {formKey}.")).RootElement;

        public List<string> Children(string formKey) =>
            [.. Index.Queries.GetContainerChildren(Plugin, formKey).Value().Select(c => c.FormKey)];

        public void Dispose()
        {
            Index.Dispose();
            _data.Dispose();
        }
    }

    private static List<string> MembersOf(JsonElement document) => [.. document.EnumerateObject().Select(p => p.Name)];

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AContainersStoredDocument_HoldsItsOwnFields_AndNoneOfItsChildren(bool compiledPlugin)
    {
        using var fixture = new Fixture(compiledPlugin);
        var keys = fixture.Keys;

        Assert.Equal(
            [
                ("OwnQuest", false), ("OwnTopic", false),
                (ContainerModPlugin.EmbedCellEditorId, false), (ContainerModPlugin.WorldspaceEditorId, false),
                (ContainerModPlugin.TopCellEditorId, false),
            ],
            new[] { fixture.Quest, fixture.Topic, keys.EmbedCell.ToString(), keys.Worldspace.ToString(), keys.TopCell.ToString() }
                .Select(fixture.Stored)
                .Select(d => (d.GetProperty("EditorID").GetString(), MembersOf(d).Intersect(
                    ["DialogTopics", "Responses", "Persistent", "Temporary", "NavigationMeshes", "Landscape", "TopCell", "SubCells"]).Any())));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void EachChild_IsStoredAsItsOwnRecord_AndItsContainerStillHoldsIt(bool compiledPlugin)
    {
        using var fixture = new Fixture(compiledPlugin);
        var keys = fixture.Keys;

        Assert.Equal(
            [
                "OwnTopic", "OwnResponse", ContainerModPlugin.TemporaryRefEditorId, ContainerModPlugin.PersistentRefEditorId,
                ContainerModPlugin.NavmeshEditorId, ContainerModPlugin.LandscapeEditorId, ContainerModPlugin.TopCellEditorId,
                ContainerModPlugin.TopCellRefEditorId,
            ],
            new[] { keys.TemporaryRef, keys.PersistentRef, keys.Navmesh, keys.Landscape, keys.TopCell, keys.TopCellRef }
                .Select(formKey => formKey.ToString())
                .Prepend(fixture.Response)
                .Prepend(fixture.Topic)
                .Select(formKey => fixture.Stored(formKey).GetProperty("EditorID").GetString()));
        Assert.Equal([fixture.Topic], fixture.Children(fixture.Quest));
        Assert.Equal([fixture.Response], fixture.Children(fixture.Topic));
        var held = fixture.Index.Queries.GetCellChildRecords(Plugin, keys.EmbedCell.ToString()).Value();
        Assert.Equal(
            new[] { keys.PersistentRef, keys.TemporaryRef, keys.Navmesh, keys.Landscape }.Select(formKey => formKey.ToString()),
            held.Persistent.Concat(held.Temporary).Select(c => c.FormKey));
    }

    [Fact]
    public void AContainerEditedInItsTree_IsStoredWithItsOwnFieldsOnly()
    {
        using var fixture = new Fixture(compiledPlugin: true);
        var cell = fixture.Keys.EmbedCell.ToString();
        fixture.Entry.HandEdit(
            fixture.Index.DocumentOf(cell, Plugin), $"\"{ContainerModPlugin.EmbedCellEditorId}\"", "\"EditedCell\"");

        fixture.Index.NextSnapshot();

        var stored = fixture.Stored(cell);
        Assert.Equal(["FormKey", "EditorID", "WaterHeight"], MembersOf(stored));
        Assert.Equal("EditedCell", stored.GetProperty("EditorID").GetString());
        Assert.Equal(ContainerModPlugin.TemporaryRefEditorId, fixture.Stored(fixture.Keys.TemporaryRef.ToString()).GetProperty("EditorID").GetString());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AContainersFields_AreItsOwn_WithNoRowForAChildSlot(bool compiledPlugin)
    {
        using var fixture = new Fixture(compiledPlugin);
        var cell = fixture.Keys.EmbedCell.ToString();
        string[] childSlots = ["Persistent", "Temporary", "NavigationMeshes", "Landscape", "DialogTopics", "Scenes", "DialogBranches"];

        var fields = new[] { cell, fixture.Quest }
            .Select(formKey => fixture.Index.DocumentOf(formKey, Plugin).Fields.Select(f => f.Metadata.Name).ToList())
            .ToList();

        Assert.All(fields, names => Assert.Contains("EditorID", names));
        Assert.All(fields, names => Assert.Empty(names.Intersect(childSlots)));
    }

    [Fact]
    public void ACompiledPluginContainersFields_ReadFromItsWholeFile_AreItsOwn()
    {
        using var fixture = new Fixture(compiledPlugin: true);
        var cell = fixture.Keys.EmbedCell.ToString();
        var file = fixture.Entry.SourceFileOf(fixture.Index.DocumentOf(cell, Plugin));

        var fields = fixture.Index.Queries.GetCompare(cell, new CopyText(Plugin, File.ReadAllText(file))).Value()?.Overrides.Single().Fields
            ?? throw new InvalidOperationException("Expected the cell to compare.");

        Assert.Contains(ContainerModPlugin.TemporaryRefEditorId, File.ReadAllText(file), StringComparison.Ordinal);
        Assert.Empty(fields.Select(f => f.Metadata.Name).Intersect(["Persistent", "Temporary", "NavigationMeshes", "Landscape"]));
    }
}
