using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Query;

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

    private static FieldDiff Row(CompareResult result, string field) => result.Diffs.Single(d => d.FieldName == field);

    private static IReadOnlyList<FieldDiff> RequireChildren(FieldDiff diff) =>
        diff.Children ?? throw new InvalidOperationException($"Expected '{diff.FieldName}' to have children.");

    private static IReadOnlyDictionary<string, FormKeyResolution> RequireResolutions(FieldDiff diff) =>
        diff.Resolutions ?? throw new InvalidOperationException($"Expected '{diff.FieldName}' to have resolutions.");

    private static IReadOnlyDictionary<string, string> RequireCheckErrors(FieldDiff diff) =>
        diff.CheckErrors ?? throw new InvalidOperationException($"Expected '{diff.FieldName}' to have check errors.");

    private static string? Text(object? value) => value is JsonElement element ? element.ToString() : null;

    [Theory]
    [InlineData("XpValueOffset", "0", ConflictThis.IdenticalToMaster)]
    [InlineData("XpValueOffset", "5", ConflictThis.Override)]
    [InlineData("NoSlowApproach", "false", ConflictThis.IdenticalToMaster)]
    [InlineData("NoSlowApproach", "true", ConflictThis.Override)]
    [InlineData("Flags", "[]", ConflictThis.IdenticalToMaster)]
    [InlineData("Flags", "[\"Essential\"]", ConflictThis.Override)]
    [InlineData("Race", "\"Null\"", ConflictThis.IdenticalToMaster)]
    [InlineData("Race", "\"000900:A.esp\"", ConflictThis.Override)]
    [InlineData("ObjectBounds", "{}", ConflictThis.IdenticalToMaster)]
    public void AbsentAgainstAnExplicitValue_IsAConflictOnlyWhenTheValueIsNotTheDefault_ForTheCodecOmitsAMemberEqualToItsDefault(
        string member, string json, ConflictThis overridesState)
    {
        var result = ComparedCopies.Spelled<Npc>("B.esp", document => document[member] = JsonNode.Parse(json), _ => { }, _ => { });

        Assert.Equal(overridesState, Row(result, member).CellStates["B.esp"]);
    }

    [Fact]
    public void ACompareOfOneRecordsCopies_CarriesNoStatesByFocus()
    {
        var result = ComparedCopies.Of(Notes("SomeNotes"));

        Assert.All(result.Diffs, d => Assert.Null(d.CellStatesByFocus));
    }

    [Fact]
    public void SinglePluginShowsEveryNonNullField()
    {
        var result = ComparedCopies.Of(Notes("SomeNotes", "SomeName"));

        Assert.Equal(ConflictAll.OnlyOne, result.ConflictAll);
        Assert.Equal(ConflictThis.OnlyOne, Assert.Single(result.Overrides).ConflictThis);
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
    [InlineData(LoadOrderEntry.OverwriteOrigin, "Shared.esp|overwrite/", "overwrite", "Shared.esp|overwrite")]
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

    private static string PluginStates(CompareResult result) =>
        string.Join(",", result.Overrides.Select(o => o.ConflictThis?.ToString() ?? "-"));

    private static string CellStates(FieldDiff row, int copies) =>
        string.Join(",", Enumerable.Range(0, copies).Select(place =>
            row.CellStates.TryGetValue(ComparedCopies.PluginAt(place), out var state) ? state.ToString() : "-"));

    [Theory]
    [InlineData(new[] { "Alice", "Alice" }, ConflictAll.NoConflict, "Master,IdenticalToMaster", "-,IdenticalToMaster")]
    [InlineData(new[] { "Alice", "Bob" }, ConflictAll.Override, "Master,Override", "-,Override")]
    [InlineData(new[] { "Alice", "Bob", "Charlie" }, ConflictAll.Conflict, "Master,ConflictLoses,ConflictWins", "-,ConflictLoses,ConflictWins")]
    [InlineData(new[] { "Alice", "Bob", "Alice", "Charlie" }, ConflictAll.Conflict, "Master,ConflictLoses,IdenticalToMaster,ConflictWins", "-,ConflictLoses,IdenticalToMaster,ConflictWins")]
    [InlineData(new[] { "Alice", null, "Alice" }, ConflictAll.NoConflict, "Master,IdenticalToMaster,IdenticalToMaster", "-,-,IdenticalToMaster")]
    [InlineData(new[] { "Alice", "Bob", null }, ConflictAll.Override, "Master,Override,IdenticalToMaster", "-,Override,-")]
    [InlineData(new[] { "Alice", "Bob", "Bob" }, ConflictAll.Override, "Master,Override,Override", "-,Override,Override")]
    [InlineData(new[] { "Alice", null, "Charlie" }, ConflictAll.Override, "Master,IdenticalToMaster,Override", "-,-,Override")]
    [InlineData(new string?[] { null, "Bob", "Charlie" }, ConflictAll.Conflict, "Master,ConflictLoses,ConflictWins", "-,ConflictLoses,ConflictWins")]
    public void TheNotesOfEachCopy_ClassifyTheRecordEachColumnAndTheNotesRow(
        string?[] notes, ConflictAll conflictAll, string pluginStates, string notesCellStates)
    {
        var result = ComparedCopies.Of(notes.Select(n => Notes(n)).ToArray());

        Assert.Equal(conflictAll, result.ConflictAll);
        Assert.Equal(pluginStates, PluginStates(result));
        var row = Row(result, "Notes");
        Assert.Equal(conflictAll, row.ConflictAll);
        Assert.Equal(notesCellStates, CellStates(row, notes.Length));
    }

    [Theory]
    [InlineData(new[] { "Alice", "Bob", "Bob" }, new[] { "1", "5", "10" }, ConflictAll.Conflict, "Master,ConflictLoses,ConflictWins")]
    [InlineData(new[] { "Alice", "Bob", null, "Dave" }, new[] { "1", "1", "5", "5" }, ConflictAll.Conflict, "Master,ConflictLoses,Override,ConflictWins")]
    [InlineData(new[] { "Alice", "Bob", "Alice" }, new[] { "1", "5", "5" }, ConflictAll.Conflict, "Master,ConflictLoses,Override")]
    [InlineData(new[] { "Alice", "Bob", "Charlie" }, new[] { "1", "5", "5" }, ConflictAll.Conflict, "Master,ConflictLoses,ConflictWins")]
    [InlineData(new[] { "Alice", null, "Charlie" }, new[] { "1", "5", "5" }, ConflictAll.Override, "Master,Override,Override")]
    [InlineData(new[] { "Alice", null }, new[] { "1", "5" }, ConflictAll.Override, "Master,Override")]
    [InlineData(new[] { "Alice", "Bob" }, new[] { "5", "5" }, ConflictAll.Override, "Master,Override")]
    [InlineData(new[] { "Alice", "Bob" }, new[] { "1", "5" }, ConflictAll.Override, "Master,Override")]
    [InlineData(new string?[] { null, "Bob", "Charlie" }, new[] { "1", "5", "5" }, ConflictAll.Conflict, "Master,ConflictLoses,ConflictWins")]
    public void TheNotesAndDisplayNameOfEachCopy_ClassifyEachColumnOnTheFieldsItContests(
        string?[] notes, string?[] displayNames, ConflictAll conflictAll, string pluginStates)
    {
        var result = ComparedCopies.Of(notes.Zip(displayNames, (n, d) => Notes(n, d)).ToArray());

        Assert.Equal(conflictAll, result.ConflictAll);
        Assert.Equal(pluginStates, PluginStates(result));
    }

    [Theory]
    [InlineData(new[] { 1, 2, 3 }, new[] { 1, 2, 3 }, ConflictAll.NoConflict, ConflictThis.IdenticalToMaster)]
    [InlineData(new[] { 1, 2, 3 }, new[] { 4, 5, 6 }, ConflictAll.Override, ConflictThis.Override)]
    [InlineData(new[] { 1, 2, 3 }, new[] { 3, 1, 2 }, ConflictAll.Override, ConflictThis.Override)]
    [InlineData(new[] { 1 }, new[] { 1, 2 }, ConflictAll.Override, ConflictThis.Override)]
    [InlineData(new[] { 1, 2 }, new[] { 1, 3 }, ConflictAll.Override, ConflictThis.Override)]
    public void ALinkArray_ComparesByItsElementsInOrder(int[] master, int[] overriding, ConflictAll conflictAll, ConflictThis overridesCell)
    {
        var result = ComparedCopies.Of(Items(master.Select(id => Link((uint)id)).ToArray()), Items(overriding.Select(id => Link((uint)id)).ToArray()));

        Assert.Equal(conflictAll, result.ConflictAll);
        Assert.Equal(overridesCell, Row(result, "Items").CellStates["B.esp"]);
    }

    [Theory]
    [InlineData(new[] { 10f, 15f }, ConflictAll.Override, "Override", "IdenticalToMaster")]
    [InlineData(new[] { 10f, 10f }, ConflictAll.NoConflict, "IdenticalToMaster", "IdenticalToMaster")]
    [InlineData(new[] { 1f, 5f, 10f }, ConflictAll.Conflict, "ConflictLoses,ConflictWins", "IdenticalToMaster,IdenticalToMaster")]
    public void AStructsSubFieldsAreClassifiedEachOnItsOwn_TheStructAggregatingItsChildren(
        float[] thins, ConflictAll weightAll, string thinCellStates, string muscularCellStates)
    {
        var weight = Row(ComparedCopies.Of(thins.Select(thin => Weight(thin, 20)).ToArray()), "Weight");

        var thin = RequireChildren(weight).Single(c => c.FieldName == "Thin");
        var muscular = RequireChildren(weight).Single(c => c.FieldName == "Muscular");
        Assert.Equal(weightAll, weight.ConflictAll);
        Assert.Equal(weightAll, thin.ConflictAll);
        Assert.Equal(ConflictAll.NoConflict, muscular.ConflictAll);
        Assert.Equal("-," + thinCellStates, CellStates(thin, thins.Length));
        Assert.Equal("-," + muscularCellStates, CellStates(muscular, thins.Length));
    }

    [Fact]
    public void ColumnWithNoCellStatesHasNoPluginState()
    {
        var result = ComparedCopies.Spelled("B.esp", document => document.Clear(), Notes("Alice"), Notes("Alice"));

        Assert.Equal("Master,-", PluginStates(result));
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
    public void TwoSiblingFields_OnlyOneDiffers_OnlyThatFieldsConflictAllIsNonNoConflict_NotTheRecordWideValueStampedOnEveryRow()
    {
        var result = ComparedCopies.Of(Notes("Alice", "5"), Notes("Bob", "5"));

        Assert.Equal(ConflictAll.Override, Row(result, "Notes").ConflictAll);
        Assert.Equal(ConflictAll.NoConflict, Row(result, "DisplayName").ConflictAll);
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
    public void NonStructFieldHasNoChildren()
    {
        Assert.Null(Row(ComparedCopies.Of(Notes("Alice"), Notes("Bob")), "Notes").Children);
    }

    [Fact]
    public void StructField_WinnerMissingField_ChildrenBuiltFromOtherPlugins()
    {
        var weight = Row(ComparedCopies.Of(Weight(1, 0), Weight(5, 0), _ => { }), "Weight");

        Assert.Contains(RequireChildren(weight), c => c.FieldName == "Thin");
    }

    public static TheoryData<Func<CompareResult>> ASubFieldAbsentFromTheOverride => new()
    {
        () => ComparedCopies.Of(Weight(10, 20), Weight(15, 0)),
        () => ComparedCopies.Spelled(
            "B.esp", document => document["Weight"] = JsonNode.Parse("""{"Thin":15,"Muscular":null}"""), Weight(10, 20), Weight(10, 20)),
    };

    [Theory]
    [MemberData(nameof(ASubFieldAbsentFromTheOverride))]
    public void StructField_ASubFieldAbsentFromAColumn_LeavesThatColumnOutOfTheChildCellStates(Func<CompareResult> compare)
    {
        var muscular = RequireChildren(Row(compare(), "Weight")).Single(c => c.FieldName == "Muscular");

        Assert.Equal("-,-", CellStates(muscular, 2));
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
