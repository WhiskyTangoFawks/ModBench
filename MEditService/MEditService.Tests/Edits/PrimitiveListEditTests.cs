using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Tests.Edits;

/// <summary>
/// #699: a list whose elements are bare scalars is written through the same door every other array
/// takes, at the record's own top level (<c>race.movement_type_names</c>, <c>mato.dnams</c>) and one
/// level in, inside an array element (<c>race.subgraphs[].animation_paths</c>). The element itself is
/// built by <c>SchemaReflector.BuildListElement</c>'s scalar arm, so the whole-value write, the
/// array-op envelope and the refuse-before-attach guarantee all apply unchanged.
/// </summary>
public sealed class PrimitiveListEditTests : IDisposable
{
    private readonly Fixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private RecordEditResult EditRace(string field, string value) =>
        _fixture.Service().EditField(_fixture.Plugin, _fixture.Race.ToString(), field, Json(value));

    /// <summary>
    /// AC 1. The write lands, reads back, and every other byte of the record's own source document
    /// on disk is unchanged — asserted against the real file's text before and after, with only the
    /// edited list's own fragment substituted, so a rebuild that re-serialises a sibling subgraph
    /// differently (a dropped <c>behavior_graph</c>, a lost keyword link, a reordered member) fails
    /// here rather than hiding behind a re-serialisation of both sides.
    /// </summary>
    [Fact]
    public void NestedAnimationPaths_Write_AppliesAndLeavesEveryOtherByteIdentical()
    {
        var before = _fixture.RaceSourceText();
        Assert.Contains("\"Actors\\\\Zero\"", before, StringComparison.Ordinal);

        var result = EditRace("subgraphs", """
            [{"role": "MT", "behavior_graph": "graph\\zero", "animation_paths": ["Actors\\Edited", "Actors\\Added"]},
             {"role": "Weapon", "behavior_graph": "graph\\one", "animation_paths": ["Actors\\OneA", "Actors\\OneB"]}]
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

    /// <summary>An array field is written as one whole value (CONTEXT.md's Complex field), so every
    /// element is rebuilt from a fresh instance and a member the payload omits is left at that
    /// instance's own default — for a list, empty. "Absence is not targeting" is a rule about the
    /// members of the object being built, not a promise that the record's previous element survives
    /// a whole-array replacement. Pinned because the scalar list is now writable and this is what a
    /// caller who sends a partial element gets.</summary>
    [Fact]
    public void NestedAnimationPaths_WholeArrayWriteOmittingTheList_LeavesItAtTheElementDefault()
    {
        var result = EditRace("subgraphs", """[{"role": "MT"}, {"role": "Weapon"}]""");

        Assert.True(result.Applied, result.Message);
        Assert.DoesNotContain("Actors", _fixture.RaceBody(), StringComparison.Ordinal);
    }

    /// <summary>An explicitly empty list clears the list. Written as an empty list, never as an
    /// absent one — the document has to be able to say "this record has no animation paths".</summary>
    [Fact]
    public void NestedAnimationPaths_EmptyArray_ClearsTheList()
    {
        var result = EditRace("subgraphs",
            """
            [{"role": "MT", "animation_paths": []},
             {"role": "Weapon", "animation_paths": ["Actors\\OneA", "Actors\\OneB"]}]
            """);

        Assert.True(result.Applied, result.Message);
        Assert.DoesNotContain("Actors\\\\Zero", _fixture.RaceBody(), StringComparison.Ordinal);
        Assert.Contains("Actors\\\\OneA", _fixture.RaceBody(), StringComparison.Ordinal);
    }

    /// <summary>An element the scalar arm cannot convert refuses the whole write and attaches
    /// nothing — the same refuse-before-attach rule every other array element already takes.</summary>
    [Fact]
    public void NestedAnimationPaths_ObjectShapedElement_RefusesTheWholeWrite()
    {
        var before = _fixture.RaceBody();

        var result = EditRace("subgraphs",
            """[{"role": "MT", "animation_paths": [{"nope": 1}]}, {"role": "Weapon"}]""");

        Assert.False(result.Applied);
        Assert.Equal(before, _fixture.RaceBody());
    }

    /// <summary>AC 2: the top-level primitive-list column takes the same write, through the same
    /// column applier — no adapter between the two.</summary>
    [Fact]
    public void TopLevelStringListColumn_Write_Applies()
    {
        var result = EditRace("movement_type_names", """["Sneak", "Sprint"]""");

        Assert.True(result.Applied, result.Message);
        var body = _fixture.RaceBody();
        Assert.Contains("Sneak", body, StringComparison.Ordinal);
        Assert.Contains("Sprint", body, StringComparison.Ordinal);
        Assert.DoesNotContain("Walk", body, StringComparison.Ordinal);
    }

    /// <summary>The same door for a numeric element type: the value lands as the list's own CLR
    /// element type, not widened to whatever a shared converter happened to pick.</summary>
    [Fact]
    public void TopLevelIntListColumn_Write_Applies()
    {
        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.MiscItem.ToString(), "component_display_indices", Json("[3, 7]"));

        Assert.True(result.Applied, result.Message);
        Assert.Contains("\"ComponentDisplayIndices\": [\n    3,\n    7\n  ]",
            _fixture.MiscItemBody(), StringComparison.Ordinal);
    }

    /// <summary>
    /// <b>A defect, pinned rather than blessed.</b> <c>SchemaReflector.PrimitiveMap</c>'s narrowing
    /// converters are unchecked casts (<c>(byte)v.GetInt32()</c>), so a value the element type cannot
    /// hold is silently truncated instead of refused — 4096 lands as 0. That is the converter table
    /// every scalar column has always used; making scalar lists writable only widens where it is
    /// reachable. Recorded here so the gap is visible and this test is what has to change when the
    /// converters start refusing (<c>checked</c> throws <c>OverflowException</c>, which both
    /// <c>MakeApplier</c> and <c>BuildScalarListElement</c> already turn into a refusal).
    /// </summary>
    [Fact]
    public void TopLevelIntListColumn_OutOfRangeElement_IsSilentlyNarrowedByTheSharedConverter()
    {
        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.MiscItem.ToString(), "component_display_indices", Json("[3, 4096]"));

        Assert.True(result.Applied, result.Message);
        Assert.Contains("\"ComponentDisplayIndices\": [\n    3,\n    0\n  ]",
            _fixture.MiscItemBody(), StringComparison.Ordinal);
    }

    /// <summary>A value that is not a number at all still refuses the whole write.</summary>
    [Fact]
    public void TopLevelIntListColumn_NonNumericElement_RefusesTheWholeWrite()
    {
        var before = _fixture.MiscItemBody();

        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.MiscItem.ToString(), "component_display_indices", Json("""[3, "nope"]"""));

        Assert.False(result.Applied);
        Assert.Equal(before, _fixture.MiscItemBody());
    }

    /// <summary>#690 made a byte slice a hex leaf that reads and writes; as a <i>list element</i> it
    /// was still extracted and never written, landing on the same refusal this ticket reverses. It
    /// writes now, in Mutagen's own <c>0x</c>-prefixed grammar.</summary>
    [Fact]
    public void TopLevelByteSliceListColumn_Write_Applies()
    {
        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.MaterialObject.ToString(), "dnams", Json("""["0xAABB", "[]"]"""));

        Assert.True(result.Applied, result.Message);
        var body = _fixture.MaterialObjectBody();
        Assert.Contains("AABB", body, StringComparison.Ordinal);
        Assert.DoesNotContain("0102", body, StringComparison.Ordinal);
    }

    /// <summary>Non-hex text is declined rather than truncated to the prefix that happened to
    /// parse.</summary>
    [Fact]
    public void TopLevelByteSliceListColumn_NonHexElement_RefusesTheWholeWrite()
    {
        var before = _fixture.MaterialObjectBody();

        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.MaterialObject.ToString(), "dnams", Json("""["0xAAZZ"]"""));

        Assert.False(result.Applied);
        Assert.Equal(before, _fixture.MaterialObjectBody());
    }

    /// <summary>An added byte-slice element arrives as <c>ArrayOpWriter.DefaultElementValue</c>'s
    /// <c>"[]"</c>, Mutagen's own empty-slice token, and is written as an empty slice.</summary>
    [Fact]
    public void ArrayAdd_TopLevelByteSliceListColumn_AppendsAnEmptySlice()
    {
        var result = _fixture.Service().EditField(
            _fixture.Plugin, _fixture.MaterialObject.ToString(), "dnams",
            Json("""{"op": "array_add", "path": []}"""));

        Assert.True(result.Applied, result.Message);
        Assert.Contains("\"0x0102\",\n    \"[]\"", _fixture.MaterialObjectBody(), StringComparison.Ordinal);
    }

    // ── AC 4: the ordinary array-op envelope, on a nested primitive list ──────────────────────

    private const string NestedListPath =
        """{"kind": "index", "index": 0}, {"kind": "member", "name": "animation_paths"}""";

    [Fact]
    public void ArrayAdd_NestedPrimitiveList_AppendsADefaultElement()
    {
        var result = EditRace("subgraphs", $$"""{"op": "array_add", "path": [{{NestedListPath}}]}""");

        Assert.True(result.Applied, result.Message);
        Assert.Contains("\"Actors\\\\Zero\",\n        \"\"", _fixture.RaceBody(), StringComparison.Ordinal);
    }

    [Fact]
    public void ArrayRemove_NestedPrimitiveList_RemovesTheNamedElementAndKeepsTheOthers()
    {
        var result = _fixture.Service().EditField(_fixture.Plugin, _fixture.Race.ToString(), "subgraphs",
            Json($$"""{"op": "array_remove", "path": [{"kind": "index", "index": 1}, {"kind": "member", "name": "animation_paths"}, {"kind": "index", "index": 0}]}"""));

        Assert.True(result.Applied, result.Message);
        var body = _fixture.RaceBody();
        Assert.DoesNotContain("Actors\\\\OneA", body, StringComparison.Ordinal);
        Assert.Contains("Actors\\\\OneB", body, StringComparison.Ordinal);
        Assert.Contains("Actors\\\\Zero", body, StringComparison.Ordinal);
    }

    [Fact]
    public void ArrayMoveDown_NestedPrimitiveList_SwapsWithTheNextElement()
    {
        var result = _fixture.Service().EditField(_fixture.Plugin, _fixture.Race.ToString(), "subgraphs",
            Json($$"""{"op": "array_move_down", "path": [{"kind": "index", "index": 1}, {"kind": "member", "name": "animation_paths"}, {"kind": "index", "index": 0}]}"""));

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
        var result = _fixture.Service().EditField(_fixture.Plugin, _fixture.Race.ToString(), "subgraphs",
            Json($$"""{"op": "array_move_up", "path": [{"kind": "index", "index": 1}, {"kind": "member", "name": "animation_paths"}, {"kind": "index", "index": 1}]}"""));

        Assert.True(result.Applied, result.Message);
        var body = _fixture.RaceBody();
        Assert.True(
            body.IndexOf("Actors\\\\OneB", StringComparison.Ordinal)
            < body.IndexOf("Actors\\\\OneA", StringComparison.Ordinal),
            body);
    }

    /// <summary>One real mod folder holding one RACE (two subgraphs, so "the element I edited
    /// changed and its sibling did not" is answerable) and one MATO (a byte-slice list) — the
    /// self-contained-fixture-per-file convention every other edit-path test file follows.</summary>
    private sealed class Fixture : IDisposable
    {
        private const string PluginName = "Primitive699.esp";
        private const string Origin = "Primitive699Mod";
        private const string RaceEditorId = "Race699";
        private const string MaterialObjectEditorId = "Mato699";

        private readonly string _instanceRoot = Directory.CreateTempSubdirectory("medit-699-instance-").FullName;
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-699-game-").FullName;
        private readonly string _modFolder;
        private readonly LoadOrderMirror _mirror;

        public PluginKey Plugin { get; } = new(PluginName, Origin);
        public FormKey Race { get; }
        public FormKey MaterialObject { get; }
        public FormKey MiscItem { get; }

        public Fixture()
        {
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

            mod.WriteToBinary(pluginPath);

            _mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ILoadOrderMirror)_mirror).Reconcile(
                _gameDirectory, [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);
            new TrackService(NullLogger<TrackService>.Instance)
                .TrackAsync(_mirror.LoadOrder!, Origin, SourcePreset.Edits)
                .GetAwaiter().GetResult();
        }

        public RecordEditService Service() =>
            new(_mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

        public string RaceBody() => Body(Race);

        public string MaterialObjectBody() => Body(MaterialObject);

        public string MiscItemBody() => Body(MiscItem);

        /// <summary>The record's own source document as it sits on disk — the file a git diff shows,
        /// not a re-serialisation of anything this test built.</summary>
        public string RaceSourceText() =>
            File.ReadAllText(SourceUnitResolver.FlatSourcePath(
                _modFolder, PluginName, "race", Race.ToString(), RaceEditorId, GameRelease.Fallout4));

        private string Body(FormKey formKey) =>
            _mirror.Index!.At(RecordRef.Effective).GetDocument(formKey.ToString(), Plugin)!.Body!;

        public void Dispose()
        {
            _mirror.Dispose();
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
