using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Query;

public class ConflictByCompareTests
{
    private static readonly FormKey GoodRecord = ComparedCopies.InMaster(0x900);
    private static readonly FormKey Dangling = ComparedCopies.InMaster(0xEEE);

    private static Action<Keyword> Notes(string? notes, string? displayName = null) =>
        keyword =>
        {
            keyword.Notes = notes;
            keyword.DisplayName = displayName;
        };

    private static Action<Npc> Weight(float thin, float muscular) =>
        npc => npc.Weight = new NpcWeight { Thin = thin, Muscular = muscular };

    private static Action<FormList> Items(params FormKey[] items) =>
        list => list.Items.AddRange(items.Select(item => new FormLink<IFallout4MajorRecordGetter>(item)));

    private static FormKey Link(uint id) => ComparedCopies.InMaster(id);

    private static IReadOnlyDictionary<string, ConflictThis> PluginStates(CompareResult result) =>
        result.Overrides.Where(o => o.ConflictThis.HasValue).ToDictionary(o => o.Plugin, o => o.ConflictThis.GetValueOrDefault());

    private static FieldDiff Row(CompareResult result, string field) => result.Diffs.Single(d => d.FieldName == field);

    private static IReadOnlyList<FieldDiff> RequireChildren(FieldDiff diff) =>
        diff.Children ?? throw new InvalidOperationException($"Expected '{diff.FieldName}' to have children.");

    private static IReadOnlyDictionary<string, FormKeyResolution> RequireResolutions(FieldDiff diff) =>
        diff.Resolutions ?? throw new InvalidOperationException($"Expected '{diff.FieldName}' to have resolutions.");

    private static IReadOnlyDictionary<string, string> RequireCheckErrors(FieldDiff diff) =>
        diff.CheckErrors ?? throw new InvalidOperationException($"Expected '{diff.FieldName}' to have check errors.");

    private static string? Text(object? value) => value is JsonElement element ? element.ToString() : null;

    [Theory]
    [InlineData("XpValueOffset", "0", true)]
    [InlineData("XpValueOffset", "5", false)]
    [InlineData("NoSlowApproach", "false", true)]
    [InlineData("NoSlowApproach", "true", false)]
    [InlineData("Flags", "[]", true)]
    [InlineData("Flags", "[\"Essential\"]", false)]
    [InlineData("Race", "\"Null\"", true)]
    [InlineData("Race", "\"000900:A.esp\"", false)]
    [InlineData("ObjectBounds", "{}", true)]
    public void AbsentAgainstAnExplicitValue_IsAConflictOnlyWhenTheValueIsNotTheDefault_ForTheCodecOmitsAMemberEqualToItsDefault(
        string member, string json, bool equal)
    {
        var result = ComparedCopies.Spelled<Npc>("B.esp", document => document[member] = JsonNode.Parse(json), _ => { }, _ => { });

        Assert.Equal(equal ? ConflictThis.IdenticalToMaster : ConflictThis.Override, Row(result, member).CellStates["B.esp"]);
    }

    [Fact]
    public void SinglePluginShowsEveryNonNullField()
    {
        var result = ComparedCopies.Of(Notes("SomeNotes", "SomeName"));

        Assert.Equal(ConflictAll.OnlyOne, result.ConflictAll);
        Assert.Contains(result.Diffs, d => d.FieldName == "Notes");
        Assert.Contains(result.Diffs, d => d.FieldName == "DisplayName");
        Assert.DoesNotContain(result.Diffs, d => d.FieldName == "AttractionRule");

        var notes = Row(result, "Notes");
        Assert.Equal("SomeNotes", Text(notes.Values["A.esp"]));
        Assert.Equal("A.esp", notes.WinnerColumn);
    }

    [Theory]
    [InlineData("ModA", "Shared.esp|ModA", "ModB", "Shared.esp|ModB")]
    [InlineData(PluginOrigin.DataDirectory, "Shared.esp", "Data", "Shared.esp|Data")]
    [InlineData(PluginOrigin.Overwrite, "Shared.esp|overwrite/", "overwrite", "Shared.esp|overwrite")]
    public void TwoPluginsOfOneFilename_AreTwoColumns_EachHoldingItsOwnValue_WhereBarePluginKeysWouldCollide(
        string losingOrigin, string losingColumn, string winningOrigin, string winningColumn)
    {
        Keyword? losing = null;
        using var fixture = new PluginFixtureBuilder("medit-one-filename-two-columns")
            .WithPlugin("Shared.esp", mod => losing = SharedKeyword(mod, "FromLosing"), origin: losingOrigin)
            .WithPlugin("Shared.esp", mod => SharedKeyword(mod, "FromWinning"), origin: winningOrigin)
            .BuildScattered();
        using var index = Indexes.Reconciled(fixture);
        var losingCopy = losing ?? throw new InvalidOperationException("The losing plugin was not built.");
        var losingText = new CopyText(new PluginAddress("Shared.esp", losingOrigin), RecordTextCodec.SerializeToText(losingCopy, GameRelease.Fallout4));

        var result = index.Queries.GetCompare(losingCopy.FormKey.ToString(), losingText).Value()
            ?? throw new InvalidOperationException("Expected the record to compare.");

        var notes = Row(result, "Notes");
        Assert.Equal("FromLosing", Text(notes.Values[losingColumn]));
        Assert.Equal("FromWinning", Text(notes.Values[winningColumn]));
    }

    private static Keyword SharedKeyword(Fallout4Mod mod, string notes)
    {
        var keyword = new Keyword(new FormKey(mod.ModKey, 0x800), Fallout4Release.Fallout4) { Notes = notes };
        mod.Keywords.Add(keyword);
        return keyword;
    }

    [Fact]
    public void TwoPlugins_AllFieldsSame_ReturnsNoConflict()
    {
        var result = ComparedCopies.Of(Notes("Alice"), Notes("Alice"));

        Assert.Equal(ConflictAll.NoConflict, result.ConflictAll);
        Assert.Equal(ConflictThis.Master, PluginStates(result)["A.esp"]);
        Assert.Equal(ConflictThis.IdenticalToMaster, PluginStates(result)["B.esp"]);
    }

    [Fact]
    public void ColumnWithNoCellStatesHasNoPluginState()
    {
        var result = ComparedCopies.Spelled("B.esp", document => document.Clear(), Notes("Alice"), Notes("Alice"));

        Assert.DoesNotContain("B.esp", PluginStates(result).Keys);
    }

    [Fact]
    public void FourPlugins_OneITM_TwoDisagree_ReturnsConflict_NotNoConflictThoughOneIsIdenticalToMaster()
    {
        var result = ComparedCopies.Of(Notes("Alice"), Notes("Bob"), Notes("Alice"), Notes("Charlie"));

        Assert.Equal(ConflictAll.Conflict, result.ConflictAll);
    }

    [Fact]
    public void TwoPlugins_OneChangesUniqueField_ReturnsOverride()
    {
        var result = ComparedCopies.Of(Notes("Alice", "1"), Notes("Alice", "5"));

        Assert.Equal(ConflictAll.Override, result.ConflictAll);
        Assert.Equal(ConflictThis.Master, PluginStates(result)["A.esp"]);
        Assert.Equal(ConflictThis.Override, PluginStates(result)["B.esp"]);
    }

    [Fact]
    public void TwoPlugins_DifferentValues_ReturnsOverride_ForOnlyOneNonMasterChangesTheFieldSoItIsUncontested()
    {
        var result = ComparedCopies.Of(Notes("Alice"), Notes("Bob"));

        Assert.Equal(ConflictAll.Override, result.ConflictAll);
        Assert.Equal(ConflictThis.Master, PluginStates(result)["A.esp"]);
        Assert.Equal(ConflictThis.Override, PluginStates(result)["B.esp"]);
    }

    [Fact]
    public void ThreePlugins_TwoNonMastersDisagree_ReturnsConflict()
    {
        var result = ComparedCopies.Of(Notes("Alice"), Notes("Bob"), Notes("Charlie"));

        Assert.Equal(ConflictAll.Conflict, result.ConflictAll);
        Assert.Equal(ConflictThis.ConflictLoses, PluginStates(result)["B.esp"]);
        Assert.Equal(ConflictThis.ConflictWins, PluginStates(result)["C.esp"]);
    }

    [Fact]
    public void ThreePlugins_OneFieldConflicts_OtherAgreesOnChange_ReturnsConflict()
    {
        var result = ComparedCopies.Of(Notes("Alice", "1"), Notes("Bob", "5"), Notes("Bob", "10"));

        Assert.Equal(ConflictAll.Conflict, result.ConflictAll);
    }

    [Fact]
    public void WinnerChangesField_OnlyOneContesterAmongMultiple_GetsConflictWins()
    {
        var result = ComparedCopies.Of(Notes("Alice", "1"), Notes("Bob", "1"), Notes(null, "5"), Notes("Dave", "5"));

        Assert.Equal(ConflictThis.ConflictWins, PluginStates(result)["D.esp"]);
    }

    [Fact]
    public void WinnerChangesOneField_OtherChangesAnother_WinnerGetsOverride_ForAnotherPluginsChangeDoesNotContestTheWinnersField()
    {
        var result = ComparedCopies.Of(Notes("Alice", "1"), Notes("Bob", "5"), Notes("Alice", "5"));

        Assert.Equal(ConflictThis.Override, PluginStates(result)["C.esp"]);
    }

    [Fact]
    public void LoserChangesMultipleFields_OnlyOneLost_GetsConflictLoses()
    {
        var result = ComparedCopies.Of(Notes("Alice", "1"), Notes("Bob", "5"), Notes("Charlie", "5"));

        Assert.Equal(ConflictThis.ConflictLoses, PluginStates(result)["B.esp"]);
    }

    [Fact]
    public void NullFieldInNonMaster_TreatedAsAbsent_NotConflictLoses_ForAPluginThatLeavesTheFieldAbsent()
    {
        var result = ComparedCopies.Of(Notes("Alice", "1"), Notes(null, "5"), Notes("Charlie", "5"));

        Assert.NotEqual(ConflictThis.ConflictLoses, PluginStates(result)["B.esp"]);
        Assert.Contains(result.Diffs, d => d.FieldName == "Notes");
    }

    [Fact]
    public void NullFieldInNonMasterIsNoConflict()
    {
        var result = ComparedCopies.Of(Notes("Alice"), Notes(null), Notes("Alice"));

        Assert.NotEqual(ConflictAll.Conflict, result.ConflictAll);
    }

    [Fact]
    public void RecordWideWinnerHasNullField_WinnerColumnFallsThroughToEarlierPlugin()
    {
        var result = ComparedCopies.Of(Notes("Alice", "1"), Notes("Bob"));

        var displayName = Row(result, "DisplayName");
        Assert.Equal("A.esp", displayName.WinnerColumn);
        Assert.Equal("1", Text(displayName.Values[displayName.WinnerColumn]));
    }

    [Fact]
    public void TwoPlugins_ArrayFields_EqualValues_ReturnsNoConflict_ComparedByRawTextNotReferenceEquality()
    {
        var result = ComparedCopies.Of(Items(Link(1), Link(2), Link(3)), Items(Link(1), Link(2), Link(3)));

        Assert.Equal(ConflictAll.NoConflict, result.ConflictAll);
    }

    [Fact]
    public void TwoPlugins_ArrayFields_DifferentValues_ReturnsOverride()
    {
        var result = ComparedCopies.Of(Items(Link(1), Link(2), Link(3)), Items(Link(4), Link(5), Link(6)));

        Assert.Equal(ConflictAll.Override, result.ConflictAll);
    }

    [Fact]
    public void PluginMissingFieldEntirely_TreatedAsNull()
    {
        var result = ComparedCopies.Of(Notes("Alice", "1"), Notes(null, "5"));

        Assert.Equal(ConflictAll.Override, result.ConflictAll);
        Assert.Equal(ConflictThis.Override, PluginStates(result)["B.esp"]);
    }

    [Fact]
    public void LinkArraySameElementsDifferentOrder_ReturnsOverride()
    {
        var result = ComparedCopies.Of(Items(Link(1), Link(2), Link(3)), Items(Link(3), Link(1), Link(2)));

        Assert.Equal(ConflictAll.Override, result.ConflictAll);
        Assert.Equal(ConflictThis.Override, Row(result, "Items").CellStates["B.esp"]);
    }

    [Fact]
    public void LinkArrayDifferentLengths_ReturnsOverride()
    {
        var result = ComparedCopies.Of(Items(Link(1)), Items(Link(1), Link(2)));

        Assert.Equal(ConflictAll.Override, result.ConflictAll);
    }

    [Fact]
    public void LinkArrayDifferentElements_ReturnsOverride()
    {
        var result = ComparedCopies.Of(Items(Link(1), Link(2)), Items(Link(1), Link(3)));

        Assert.Equal(ConflictAll.Override, result.ConflictAll);
    }

    [Fact]
    public void UnsortedArraySameElementsDifferentOrder_ReturnsOverride()
    {
        var result = ComparedCopies.Of<MiscItem>(
            misc => misc.ComponentDisplayIndices = [1, 2],
            misc => misc.ComponentDisplayIndices = [2, 1]);

        Assert.Equal(ConflictAll.Override, result.ConflictAll);
    }

    [Fact]
    public void TwoPlugins_NonMasterMatchesMaster_CellStateIsIdenticalToMaster_AndTheMasterHasNoCellState()
    {
        var notes = Row(ComparedCopies.Of(Notes("Alice"), Notes("Alice")), "Notes");

        Assert.Equal(ConflictThis.IdenticalToMaster, notes.CellStates["B.esp"]);
        Assert.False(notes.CellStates.ContainsKey("A.esp"));
    }

    [Fact]
    public void TwoPlugins_NonMasterChangesFieldUncontestedly_CellStateIsOverride_AndTheMasterHasNoCellState()
    {
        var notes = Row(ComparedCopies.Of(Notes("Alice"), Notes("Bob")), "Notes");

        Assert.Equal(ConflictThis.Override, notes.CellStates["B.esp"]);
        Assert.False(notes.CellStates.ContainsKey("A.esp"));
    }

    [Fact]
    public void ThreePlugins_TwoDisagreeOnField_WinnerGetsConflictWins_LoserGetsConflictLoses_AndTheMasterHasNoCellState()
    {
        var notes = Row(ComparedCopies.Of(Notes("Alice"), Notes("Bob"), Notes("Charlie")), "Notes");

        Assert.Equal(ConflictThis.ConflictWins, notes.CellStates["C.esp"]);
        Assert.Equal(ConflictThis.ConflictLoses, notes.CellStates["B.esp"]);
        Assert.False(notes.CellStates.ContainsKey("A.esp"));
    }

    [Fact]
    public void FieldWinnerDiffersFromRecordWinner_FieldWinnerGetsOverride_NotConflictLoses_AndTheNullRecordWinnerHasNoCellState()
    {
        var notes = Row(ComparedCopies.Of(Notes("Alice"), Notes("Bob"), Notes(null)), "Notes");

        Assert.Equal(ConflictThis.Override, notes.CellStates["B.esp"]);
        Assert.False(notes.CellStates.ContainsKey("C.esp"));
    }

    [Fact]
    public void NonWinnerMatchesFieldWinner_CellStateIsOverride_NotConflictLoses()
    {
        var notes = Row(ComparedCopies.Of(Notes("Alice"), Notes("Bob"), Notes("Bob")), "Notes");

        Assert.Equal(ConflictThis.Override, notes.CellStates["B.esp"]);
    }

    [Fact]
    public void NullValueInNonMaster_OmittedFromCellStates()
    {
        var notes = Row(ComparedCopies.Of(Notes("Alice"), Notes(null), Notes("Charlie")), "Notes");

        Assert.False(notes.CellStates.ContainsKey("B.esp"));
        Assert.True(notes.CellStates.ContainsKey("C.esp"));
    }

    [Fact]
    public void LeafField_AllPluginsAgree_ConflictAllIsNoConflict()
    {
        Assert.Equal(ConflictAll.NoConflict, Row(ComparedCopies.Of(Notes("Alice"), Notes("Alice")), "Notes").ConflictAll);
    }

    [Fact]
    public void LeafField_UncontestedOverride_ConflictAllIsOverride()
    {
        Assert.Equal(ConflictAll.Override, Row(ComparedCopies.Of(Notes("Alice"), Notes("Bob")), "Notes").ConflictAll);
    }

    [Fact]
    public void LeafField_ContestedWinLose_ConflictAllIsConflict()
    {
        Assert.Equal(ConflictAll.Conflict, Row(ComparedCopies.Of(Notes("Alice"), Notes("Bob"), Notes("Charlie")), "Notes").ConflictAll);
    }

    [Fact]
    public void TwoSiblingFields_OnlyOneDiffers_OnlyThatFieldsConflictAllIsNonNoConflict_NotTheRecordWideValueStampedOnEveryRow()
    {
        var result = ComparedCopies.Of(Notes("Alice", "5"), Notes("Bob", "5"));

        Assert.Equal(ConflictAll.Override, Row(result, "Notes").ConflictAll);
        Assert.Equal(ConflictAll.NoConflict, Row(result, "DisplayName").ConflictAll);
    }

    [Fact]
    public void StructField_OneSubFieldDiffers_StructConflictAllAggregatesFromChild()
    {
        var weight = Row(ComparedCopies.Of(Weight(10, 20), Weight(15, 20)), "Weight");

        Assert.Equal(ConflictAll.Override, RequireChildren(weight).Single(c => c.FieldName == "Thin").ConflictAll);
        Assert.Equal(ConflictAll.NoConflict, RequireChildren(weight).Single(c => c.FieldName == "Muscular").ConflictAll);
        Assert.Equal(ConflictAll.Override, weight.ConflictAll);
    }

    [Fact]
    public void NestedStructInsideTheOverridesElement_GrandchildConflictAggregatesTwoLevelsUp()
    {
        static Action<Container> Holding(int count) =>
            container => container.Items = [new ContainerEntry { Item = new ContainerItem { Item = new FormLink<IItemGetter>(Link(1)), Count = count } }];

        var items = Row(ComparedCopies.Of(Holding(1), Holding(2)), "Items");

        var element = Assert.Single(RequireChildren(items));
        var item = RequireChildren(element).Single(c => c.FieldName == "Item");
        var count = RequireChildren(item).Single(c => c.FieldName == "Count");
        Assert.Equal(ConflictAll.Override, count.ConflictAll);
        Assert.Equal(ConflictAll.Override, item.ConflictAll);
        Assert.Equal(ConflictAll.Override, element.ConflictAll);
        Assert.Equal(ConflictAll.Override, items.ConflictAll);
    }

    [Fact]
    public void RecordWideConflictAllIsOverrideWhenOnlyOneFieldDiffers()
    {
        Assert.Equal(ConflictAll.Override, ComparedCopies.Of(Notes("Alice", "5"), Notes("Bob", "5")).ConflictAll);
    }

    [Fact]
    public void NonStructFieldHasNoChildren()
    {
        Assert.Null(Row(ComparedCopies.Of(Notes("Alice"), Notes("Bob")), "Notes").Children);
    }

    [Fact]
    public void StructField_TwoPluginsDifferOnSubField_ChildrenPopulated()
    {
        var weight = Row(ComparedCopies.Of(Weight(10, 20), Weight(15, 20)), "Weight");

        Assert.Equal(ConflictThis.Override, RequireChildren(weight).Single(c => c.FieldName == "Thin").CellStates["B.esp"]);
        Assert.Equal(ConflictThis.IdenticalToMaster, RequireChildren(weight).Single(c => c.FieldName == "Muscular").CellStates["B.esp"]);
    }

    [Fact]
    public void StructField_AllPluginsAgreeOnStruct_ChildrenHaveIdenticalToMasterStates()
    {
        var weight = Row(ComparedCopies.Of(Weight(10, 20), Weight(10, 20)), "Weight");

        Assert.NotEmpty(RequireChildren(weight));
        Assert.All(RequireChildren(weight), child => Assert.Equal(ConflictThis.IdenticalToMaster, child.CellStates["B.esp"]));
    }

    [Fact]
    public void StructField_ThreePluginsTwoDisagreeOnSubField_ConflictWinsAndConflictLoses()
    {
        var thin = RequireChildren(Row(ComparedCopies.Of(Weight(1, 0), Weight(5, 0), Weight(10, 0)), "Weight"))
            .Single(c => c.FieldName == "Thin");

        Assert.Equal(ConflictThis.ConflictWins, thin.CellStates["C.esp"]);
        Assert.Equal(ConflictThis.ConflictLoses, thin.CellStates["B.esp"]);
    }

    [Fact]
    public void StructField_WinnerMissingField_ChildrenBuiltFromOtherPlugins()
    {
        var weight = Row(ComparedCopies.Of(Weight(1, 0), Weight(5, 0), _ => { }), "Weight");

        Assert.Contains(RequireChildren(weight), c => c.FieldName == "Thin");
    }

    [Fact]
    public void StructField_SubFieldAbsentInOnePlugin_ThatPluginOmittedFromChildCellStates()
    {
        var weight = Row(ComparedCopies.Of(Weight(10, 20), Weight(15, 0)), "Weight");

        Assert.False(RequireChildren(weight).Single(c => c.FieldName == "Muscular").CellStates.ContainsKey("B.esp"));
    }

    [Fact]
    public void StructField_ArraySubFieldIncluded_ProducesChildRows()
    {
        static Action<Npc> Destructible(int health, params byte[] stages) =>
            npc => npc.Destructible = new Destructible
            {
                Data = new DestructableData { Health = health },
                Stages = [.. stages.Select(index => new DestructionStage { Index = index })],
            };

        var destructible = Row(ComparedCopies.Of(Destructible(10, 1, 2), Destructible(15, 3, 4)), "Destructible");

        Assert.Contains(RequireChildren(destructible), c => c.FieldName == "Data");
        Assert.Equal(4, RequireChildren(RequireChildren(destructible).Single(c => c.FieldName == "Stages")).Count);
    }

    [Fact]
    public void StructField_SubFieldWinnerIsTheHighestLoadOrderPluginWithAValue_NotTheLowest()
    {
        var thin = RequireChildren(Row(ComparedCopies.Of(Weight(1, 0), Weight(5, 0)), "Weight")).Single(c => c.FieldName == "Thin");

        Assert.Equal("B.esp", thin.WinnerColumn);
        Assert.Equal(5f, Assert.IsType<JsonElement>(thin.Values[thin.WinnerColumn]).GetSingle());
    }

    [Fact]
    public void StructField_JsonNullSubField_TreatedAsAbsent()
    {
        var result = ComparedCopies.Spelled(
            "B.esp", document => document["Weight"] = JsonNode.Parse("""{"Thin":15,"Muscular":null}"""), Weight(10, 20), Weight(10, 20));

        Assert.False(RequireChildren(Row(result, "Weight")).Single(c => c.FieldName == "Muscular").CellStates.ContainsKey("B.esp"));
    }

    [Fact]
    public void ScalarFormKeyField_PopulatesResolutionPerPlugin()
    {
        var result = ComparedCopies.Beside<Npc>(
            mod => mod.Races.Add(new Race(GoodRecord, Fallout4Release.Fallout4) { EditorID = "GoodRace" }),
            npc => npc.Race.SetTo(GoodRecord),
            npc => npc.Race.SetTo(Dangling));

        var race = RequireResolutions(Row(result, "Race"));
        Assert.Equal(FormKeyResolutionState.ResolvedValidType, race["A.esp"].State);
        Assert.Equal("GoodRace", race["A.esp"].EditorId);
        Assert.Equal(FormKeyResolutionState.Unresolved, race["B.esp"].State);
    }

    [Fact]
    public void LinkArray_SiblingLeavesResolveIndependently_ParentCarriesNoResolutions()
    {
        var result = ComparedCopies.Beside(
            mod => mod.Keywords.Add(new Keyword(GoodRecord, Fallout4Release.Fallout4) { EditorID = "GoodKeyword" }),
            Items(GoodRecord, Dangling));

        var items = Row(result, "Items");
        Assert.Null(items.Resolutions);
        Assert.Equal(FormKeyResolutionState.ResolvedValidType, RequireResolutions(RequireChildren(items)[0])["A.esp"].State);
        Assert.Equal(FormKeyResolutionState.Unresolved, RequireResolutions(RequireChildren(items)[1])["A.esp"].State);
    }

    private static Action<MiscItem> Model(FormKey materialSwap) =>
        misc => misc.Model = new Model { File = "Clutter\\Thing.nif", MaterialSwap = new FormLinkNullable<IMaterialSwapGetter>(materialSwap) };

    [Fact]
    public void StructFormKeySubField_ReportsItsOwnCheckErrorAndTheParentReportsTheSubtreePathed()
    {
        var result = ComparedCopies.Beside(
            mod => mod.MaterialSwaps.Add(new MaterialSwap(GoodRecord, Fallout4Release.Fallout4) { EditorID = "GoodSwap" }),
            Model(GoodRecord),
            Model(Dangling));

        var model = Row(result, "Model");
        var checkErrors = RequireCheckErrors(model);
        Assert.Equal("MaterialSwap: [000EEE:A.esp] <Error: Could not be resolved>", checkErrors["B.esp"]);
        Assert.False(checkErrors.ContainsKey("A.esp"));
        Assert.Equal(
            "[000EEE:A.esp] <Error: Could not be resolved>",
            RequireCheckErrors(RequireChildren(model).Single(c => c.FieldName == "MaterialSwap"))["B.esp"]);
        Assert.Null(RequireChildren(model).Single(c => c.FieldName == "File").CheckErrors);
    }

    [Fact]
    public void StructFormKeySubField_ResolvesIndependentlyOfSiblingStructField_ANonFormKeySiblingGetsNoResolutions()
    {
        var model = Row(ComparedCopies.Of(Model(Dangling)), "Model");

        Assert.Equal(
            FormKeyResolutionState.Unresolved,
            RequireResolutions(RequireChildren(model).Single(c => c.FieldName == "MaterialSwap"))["A.esp"].State);
        Assert.Null(RequireChildren(model).Single(c => c.FieldName == "File").Resolutions);
    }
}
