using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;
using static MEditService.Tests.TestSupport.Envelopes;

namespace MEditService.Tests.Edits;

public sealed class PrimitiveListEditTests : IDisposable
{
    private readonly Fixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private RecordEditResult EditRace(string field, string value) =>
        _fixture.Service().Set(_fixture.Plugin, _fixture.Race.ToString(), field, Json(value));

    [Fact]
    public void NestedAnimationPaths_Write_AppliesAndLeavesEveryOtherByteIdentical()
    {
        var before = _fixture.RaceSourceText();
        Assert.Contains("\"Actors\\\\Zero\"", before, StringComparison.Ordinal);

        var result = EditRace("Subgraphs", """
            [{"Role": "MT", "BehaviorGraph": "graph\\zero", "AnimationPaths": ["Actors\\Edited", "Actors\\Added"]},
             {"Role": "Weapon", "BehaviorGraph": "graph\\one", "AnimationPaths": ["Actors\\OneA", "Actors\\OneB"]}]
            """);

        Assert.True(result.Applied, result.Message);

        var after = _fixture.RaceSourceText();
        Assert.Contains("Actors\\\\Edited", after, StringComparison.Ordinal);
        Assert.Equal(
            before.Replace(
                "\"Actors\\\\Zero\"",
                "\"Actors\\\\Edited\",\n        \"Actors\\\\Added\"",
                StringComparison.Ordinal),
            after);
    }

    [Fact]
    public void NestedAnimationPaths_WholeArrayWriteOmittingTheList_LeavesItAtTheElementDefault()
    {
        var result = EditRace("Subgraphs", """[{"Role": "MT"}, {"Role": "Weapon"}]""");

        Assert.True(result.Applied, result.Message);
        Assert.DoesNotContain("Actors", _fixture.RaceBody(), StringComparison.Ordinal);
    }

    [Fact]
    public void NestedAnimationPaths_EmptyArray_ClearsTheList()
    {
        var result = EditRace("Subgraphs",
            """
            [{"Role": "MT", "AnimationPaths": []},
             {"Role": "Weapon", "AnimationPaths": ["Actors\\OneA", "Actors\\OneB"]}]
            """);

        Assert.True(result.Applied, result.Message);
        Assert.DoesNotContain("Actors\\\\Zero", _fixture.RaceBody(), StringComparison.Ordinal);
        Assert.Contains("Actors\\\\OneA", _fixture.RaceBody(), StringComparison.Ordinal);
    }

    [Fact]
    public void NestedAnimationPaths_ObjectShapedElement_RefusesTheWholeWrite()
    {
        var before = _fixture.RaceBody();

        var result = EditRace("Subgraphs",
            """[{"Role": "MT", "AnimationPaths": [{"nope": 1}]}, {"Role": "Weapon"}]""");

        Assert.False(result.Applied);
        Assert.Equal(before, _fixture.RaceBody());
    }

    [Fact]
    public void TopLevelStringListColumn_Write_Applies()
    {
        var result = EditRace("MovementTypeNames", """["Sneak", "Sprint"]""");

        Assert.True(result.Applied, result.Message);
        var body = _fixture.RaceBody();
        Assert.Contains("Sneak", body, StringComparison.Ordinal);
        Assert.Contains("Sprint", body, StringComparison.Ordinal);
        Assert.DoesNotContain("Walk", body, StringComparison.Ordinal);
    }

    [Fact]
    public void TopLevelIntListColumn_Write_Applies()
    {
        var result = _fixture.Service().Set(
            _fixture.Plugin, _fixture.MiscItem.ToString(), "ComponentDisplayIndices", Json("[3, 7]"));

        Assert.True(result.Applied, result.Message);
        Assert.Contains("\"ComponentDisplayIndices\": [\n    3,\n    7\n  ]",
            _fixture.MiscItemBody(), StringComparison.Ordinal);
    }

    [Fact]
    public void TopLevelIntListColumn_OutOfRangeElement_RefusesTheWholeWrite()
    {
        var before = _fixture.MiscItemBody();

        var result = _fixture.Service().Set(
            _fixture.Plugin, _fixture.MiscItem.ToString(), "ComponentDisplayIndices", Json("[3, 4096]"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecRejected, result.Refusal);
        Assert.Contains("ComponentDisplayIndices", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, _fixture.MiscItemBody());
    }

    // The refusal names the path that was edited and quotes the codec: no translation table sits
    // over Mutagen's own message.
    [Fact]
    public void TopLevelIntListColumn_OutOfRangeElement_NamesThePathAndQuotesTheCodec()
    {
        var result = _fixture.Service().Set(
            _fixture.Plugin, _fixture.MiscItem.ToString(), "ComponentDisplayIndices", Json("[3, 4096]"));

        Assert.Equal("ComponentDisplayIndices", result.Path);
        Assert.Contains("the codec rejected", result.Message, StringComparison.Ordinal);
        Assert.Contains("overflow", result.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TopLevelIntListColumn_NonNumericElement_RefusesTheWholeWrite()
    {
        var before = _fixture.MiscItemBody();

        var result = _fixture.Service().Set(
            _fixture.Plugin, _fixture.MiscItem.ToString(), "ComponentDisplayIndices", Json("""[3, "nope"]"""));

        Assert.False(result.Applied);
        Assert.Equal(before, _fixture.MiscItemBody());
    }

    [Fact]
    public void TopLevelLongListColumn_Write_AppliesAndReadsBack()
    {
        var result = _fixture.Service().Set(
            _fixture.Plugin, _fixture.SceneCollection.ToString(), "XNAMs",
            Json("[8589934591, -4294967296]"));

        Assert.True(result.Applied, result.Message);
        Assert.Contains("\"XNAMs\": [\n    8589934591,\n    -4294967296\n  ]",
            _fixture.SceneCollectionBody(), StringComparison.Ordinal);
    }

    [Fact]
    public void TopLevelLongListColumn_OutOfRangeElement_RefusesTheWholeWrite()
    {
        var before = _fixture.SceneCollectionBody();

        var result = _fixture.Service().Set(
            _fixture.Plugin, _fixture.SceneCollection.ToString(), "XNAMs",
            Json("[7, 9223372036854775808]"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecRejected, result.Refusal);
        Assert.Contains("XNAMs", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, _fixture.SceneCollectionBody());
    }

    [Fact]
    public void TopLevelByteSliceListColumn_Write_Applies()
    {
        var result = _fixture.Service().Set(
            _fixture.Plugin, _fixture.MaterialObject.ToString(), "DNAMs", Json("""["0xAABB", "[]"]"""));

        Assert.True(result.Applied, result.Message);
        var body = _fixture.MaterialObjectBody();
        Assert.Contains("AABB", body, StringComparison.Ordinal);
        Assert.DoesNotContain("0102", body, StringComparison.Ordinal);
    }

    [Fact]
    public void TopLevelByteSliceListColumn_NonHexElement_RefusesTheWholeWrite()
    {
        var before = _fixture.MaterialObjectBody();

        var result = _fixture.Service().Set(
            _fixture.Plugin, _fixture.MaterialObject.ToString(), "DNAMs", Json("""["0xAAZZ"]"""));

        Assert.False(result.Applied);
        Assert.Equal(before, _fixture.MaterialObjectBody());
    }

    [Fact]
    public void ArrayAdd_TopLevelByteSliceListColumn_AppendsAnEmptySlice()
    {
        var result = _fixture.Service().Edit(_fixture.Plugin, _fixture.MaterialObject.ToString(), AddAt(Member("DNAMs")));

        Assert.True(result.Applied, result.Message);
        Assert.Contains("\"0x0102\",\n    \"[]\"", _fixture.MaterialObjectBody(), StringComparison.Ordinal);
    }

    // ── AC 4: the ordinary array-op envelope, on a nested primitive list ──────────────────────

    [Fact]
    public void ArrayAdd_NestedPrimitiveList_AppendsADefaultElement()
    {
        var result = _fixture.Service().Edit(
            _fixture.Plugin, _fixture.Race.ToString(), AddAt(Member("Subgraphs"), At(0), Member("AnimationPaths")));

        Assert.True(result.Applied, result.Message);
        Assert.Contains("\"Actors\\\\Zero\",\n        \"\"", _fixture.RaceBody(), StringComparison.Ordinal);
    }

    [Fact]
    public void ArrayRemove_NestedPrimitiveList_RemovesTheNamedElementAndKeepsTheOthers()
    {
        var result = _fixture.Service().Edit(_fixture.Plugin, _fixture.Race.ToString(), RemoveAt(Member("Subgraphs"), At(1), Member("AnimationPaths"), At(0)));

        Assert.True(result.Applied, result.Message);
        var body = _fixture.RaceBody();
        Assert.DoesNotContain("Actors\\\\OneA", body, StringComparison.Ordinal);
        Assert.Contains("Actors\\\\OneB", body, StringComparison.Ordinal);
        Assert.Contains("Actors\\\\Zero", body, StringComparison.Ordinal);
    }

    [Fact]
    public void ArrayMoveDown_NestedPrimitiveList_SwapsWithTheNextElement()
    {
        var result = _fixture.Service().Edit(_fixture.Plugin, _fixture.Race.ToString(), MoveTo(1, Member("Subgraphs"), At(1), Member("AnimationPaths"), At(0)));

        Assert.True(result.Applied, result.Message);
        var body = _fixture.RaceBody();
        Assert.True(
            body.IndexOf("Actors\\\\OneB", StringComparison.Ordinal)
            < body.IndexOf("Actors\\\\OneA", StringComparison.Ordinal),
            body);
    }

    [Fact]
    public void ArrayMoveUp_NestedPrimitiveList_SwapsWithThePreviousElement()
    {
        var result = _fixture.Service().Edit(_fixture.Plugin, _fixture.Race.ToString(), MoveTo(0, Member("Subgraphs"), At(1), Member("AnimationPaths"), At(1)));

        Assert.True(result.Applied, result.Message);
        var body = _fixture.RaceBody();
        Assert.True(
            body.IndexOf("Actors\\\\OneB", StringComparison.Ordinal)
            < body.IndexOf("Actors\\\\OneA", StringComparison.Ordinal),
            body);
    }

    // Two subgraphs so "the edited element changed and its sibling did not" is answerable; SCCO is
    // Fallout 4's only list of long.
    private sealed class Fixture : IDisposable
    {
        private const string PluginName = "Primitive699.esp";
        private const string Origin = "Primitive699Mod";
        private const string RaceEditorId = "Race699";
        private const string MaterialObjectEditorId = "Mato699";

        private readonly string _instanceRoot = Directory.CreateTempSubdirectory("medit-699-instance-").FullName;
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-699-game-").FullName;
        private readonly string _modFolder;

        public PluginCopyKey Plugin { get; } = new(PluginName, Origin);
        public LoadOrderSnapshot LoadOrder { get; }
        public EditRecordHandler EditHandler { get; }
        public FormKey Race { get; }
        public FormKey MaterialObject { get; }
        public FormKey MiscItem { get; }
        public FormKey SceneCollection { get; }

        public Fixture()
        {
            var holder = new LoadOrderHolder();
            _modFolder = Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", Origin)).FullName;
            var pluginPath = Path.Combine(_modFolder, PluginName);
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

            var race = mod.Races.AddNew(RaceEditorId);
            race.MovementTypeNames.Add("Walk");
            race.Subgraphs.Add(new Subgraph
            {
                Role = Subgraph.SubgraphRole.MT,
                BehaviorGraph = "graph\\zero",
                AnimationPaths = { "Actors\\Zero" },
            });
            race.Subgraphs.Add(new Subgraph
            {
                Role = Subgraph.SubgraphRole.Weapon,
                BehaviorGraph = "graph\\one",
                AnimationPaths = { "Actors\\OneA", "Actors\\OneB" },
            });
            Race = race.FormKey;

            var mato = mod.MaterialObjects.AddNew(MaterialObjectEditorId);
            mato.DNAMs.Add(new MemorySlice<byte>([0x01, 0x02]));
            MaterialObject = mato.FormKey;

            var misc = mod.MiscItems.AddNew("Misc699");
            misc.ComponentDisplayIndices = [1];
            MiscItem = misc.FormKey;

            var scco = mod.SceneCollections.AddNew("Scco708");
            scco.XNAMs.Add(1L);
            SceneCollection = scco.FormKey;

            mod.WriteToBinary(pluginPath);

            LoadOrder = new LoadOrderSnapshot(
                _gameDirectory, _gameDirectory, GameRelease.Fallout4,
                SnapshotCopies.Of([new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)]));
            new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
                .TrackAsync(LoadOrder, Origin, SourcePreset.Edits)
                .GetAwaiter().GetResult();

            holder.Apply(LoadOrder);
            EditHandler = TestEditService.EditHandler(holder);
        }

        public EditRecordHandler Service() => EditHandler;

        public string RaceBody() => Body(Race);

        public string MaterialObjectBody() => Body(MaterialObject);

        public string MiscItemBody() => Body(MiscItem);

        public string SceneCollectionBody() => Body(SceneCollection);

        public string RaceSourceText() =>
            File.ReadAllText(SourceDocumentPath.Of(
                _modFolder, PluginName, "race", Race.ToString(), RaceEditorId, GameRelease.Fallout4));

        private string Body(FormKey formKey) =>
            (TrackedTree.Document(_modFolder, Plugin, formKey.ToString())
                ?? throw new InvalidOperationException($"Expected a tracked source document for {formKey}.")).Body;

        public void Dispose()
        {
            TryDelete(_instanceRoot);
            TryDelete(_gameDirectory);
        }

        private static void TryDelete(string path)
        {
            try { Directory.Delete(path, recursive: true); }
            catch (IOException) { /* scratch directory, best effort */ }
            catch (UnauthorizedAccessException) { /* ditto */ }
        }
    }
}
