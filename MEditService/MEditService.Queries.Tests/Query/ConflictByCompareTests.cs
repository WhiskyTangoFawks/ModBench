using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.Queries.Tests.TestSupport;

namespace MEditService.Queries.Tests.Query;

public class ConflictByCompareTests
{
    private static IReadOnlyDictionary<string, RecordLookupEntry> Lookups(params (string formKey, string type, string editorId)[] entries) =>
        entries.ToDictionary(e => e.formKey, e => new RecordLookupEntry(e.type, e.editorId));

    private static FieldMetadata Meta(string name, string type = "string") =>
        new(name, type, false, [], []);

    private static FieldValue LinkArrayField(string name, object? value) =>
        new(new FieldMetadata(name, "array", true, [], [],
            ElementType: new FieldMetadata("", "formKey", false, [], [])), value);

    private static RecordDetail MakeOverride(string plugin, int loadOrder, bool isWinner,
        params (string name, object? value)[] fields) =>
        new("000001:Test.esp", plugin, loadOrder, isWinner, null,
            [.. fields.Select(f => new FieldValue(Meta(f.name), f.value))], "Data");

    private static IReadOnlyList<FieldDiff> RequireChildren(FieldDiff diff) =>
        diff.Children ?? throw new InvalidOperationException($"Expected '{diff.FieldName}' to have children.");

    private static IReadOnlyDictionary<string, FormKeyResolution> RequireResolutions(FieldDiff diff) =>
        diff.Resolutions ?? throw new InvalidOperationException($"Expected '{diff.FieldName}' to have resolutions.");

    private static IReadOnlyDictionary<string, string> RequireCheckErrors(FieldDiff diff) =>
        diff.CheckErrors ?? throw new InvalidOperationException($"Expected '{diff.FieldName}' to have check errors.");

    private static RecordDetail MakeOverrideWithOrigin(string plugin, string origin, int loadOrder, bool isWinner,
        params (string name, object? value)[] fields) =>
        new("000001:Test.esp", plugin, loadOrder, isWinner, null,
            [.. fields.Select(f => new FieldValue(Meta(f.name), f.value))], Origin: origin);

    private static RecordDetail MakePartialFormOverrideWhoseOwnFieldsAreExcludedRegardlessOfContent(string plugin, int loadOrder, bool isWinner,
        params (string name, object? value)[] fields) =>
        new("000001:Test.esp", plugin, loadOrder, isWinner, null,
            [.. fields.Select(f => new FieldValue(Meta(f.name), f.value))], "Data", IsPartialForm: true);

    [Theory]
    [InlineData("int", "0", true)]
    [InlineData("int", "5", false)]
    [InlineData("bool", "false", true)]
    [InlineData("bool", "true", false)]
    [InlineData("flags", "[]", true)]
    [InlineData("flags", "[\"OR\"]", false)]
    [InlineData("formKey", "\"Null\"", true)]
    [InlineData("formKey", "\"000001:Test.esp\"", false)]
    [InlineData("struct", "{}", true)]
    public void Classify_AbsentAgainstAnExplicitValue_IsAConflictOnlyWhenTheValueIsNotTheDefault_ForTheCodecOmitsAMemberEqualToItsDefault(
        string type, string json, bool equal)
    {
        var meta = new FieldMetadata("Member", type, false, [], []);
        var master = new RecordDetail("000001:Test.esp", "A.esp", 0, false, null, [new FieldValue(meta, null)], "Data");
        var spelled = new RecordDetail("000001:Test.esp", "B.esp", 1, true, null,
            [new FieldValue(meta, JsonSerializer.Deserialize<JsonElement>(json))], "Data");

        var diff = Assert.Single(CompareQuery.Classify([master, spelled]).Diffs);

        Assert.Equal(equal ? ConflictThis.IdenticalToMaster : ConflictThis.Override, diff.CellStates["B.esp"]);
    }

    [Theory]
    [InlineData("2", true)]
    [InlineData("2.0", true)]
    [InlineData("0", false)]
    public void Classify_AbsentAgainstAnExplicitValue_EqualsTheDeclaredDefault_NotZero_ForMutagenDeclaresVirtualMachineAdapterObjectFormatAsTwoAndTheCodecOmitsExactlyThat(string json, bool equal)
    {
        var meta = new FieldMetadata("ObjectFormat", "int", false, [], [], Default: 2);
        var master = new RecordDetail("000001:Test.esp", "A.esp", 0, false, null, [new FieldValue(meta, null)], "Data");
        var spelled = new RecordDetail("000001:Test.esp", "B.esp", 1, true, null,
            [new FieldValue(meta, JsonSerializer.Deserialize<JsonElement>(json))], "Data");

        var diff = Assert.Single(CompareQuery.Classify([master, spelled]).Diffs);

        Assert.Equal(equal ? ConflictThis.IdenticalToMaster : ConflictThis.Override, diff.CellStates["B.esp"]);
    }

    [Fact]
    public void Classify_SinglePlugin_ReturnsAllNonNullFieldsAsDiffs()
    {
        var o = MakeOverride("DLCRobot.esm", 0, true,
            ("Name", "SomeNPC"), ("Level", (object?)10), ("NullField", (object?)null));
        var result = CompareQuery.Classify([o]);

        Assert.Equal(ConflictAll.OnlyOne, result.ConflictAll);
        Assert.Contains(result.Diffs, d => d.FieldName == "Name");
        Assert.Contains(result.Diffs, d => d.FieldName == "Level");
        Assert.DoesNotContain(result.Diffs, d => d.FieldName == "NullField");

        var nameDiff = result.Diffs.First(d => d.FieldName == "Name");
        Assert.Equal("SomeNPC", nameDiff.Values["DLCRobot.esm"]);
        Assert.Equal("DLCRobot.esm", nameDiff.WinnerColumn);
        Assert.Equal("SomeNPC", nameDiff.Values[nameDiff.WinnerColumn]);
    }

    [Fact]
    public void Classify_MultiplePlugins_NoWinnerMarked_Throws_NamingTheRecordsFormKey()
    {
        var a = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var b = MakeOverride("B.esp", 1, false, ("Name", "Bob"));
        var ex = Assert.Throws<InvalidOperationException>(() => CompareQuery.Classify([a, b]));
        Assert.Contains("000001:Test.esp", ex.Message);
    }

    [Fact]
    public void Classify_SameFilenameDifferentOrigin_DoesNotCollide_WhereBarePluginDictionaryKeysWouldThrowOnTheDuplicate()
    {
        var modA = MakeOverrideWithOrigin("Shared.esp", "ModA", 0, false, ("Name", "FromModA"));
        var modB = MakeOverrideWithOrigin("Shared.esp", "ModB", 1, true, ("Name", "FromModB"));

        var result = CompareQuery.Classify([modA, modB]);

        Assert.Equal(2, result.PluginStates.Count);
        var nameDiff = Assert.Single(result.Diffs, d => d.FieldName == "Name");
        Assert.Equal("FromModA", nameDiff.Values["Shared.esp|ModA"]);
        Assert.Equal("FromModB", nameDiff.Values["Shared.esp|ModB"]);
    }

    [Fact]
    public void Classify_SameFilenameDifferentOrigin_EditingOneColumnsValue_LeavesTheOtherColumnsValueInTheDiff()
    {
        var modA = MakeOverrideWithOrigin("Shared.esp", "ModA", 0, false, ("Name", "Original"));
        var modB = MakeOverrideWithOrigin("Shared.esp", "ModB", 1, true, ("Name", "Original"));
        var baseline = CompareQuery.Classify([modA, modB]);
        var baselineDiff = Assert.Single(baseline.Diffs, d => d.FieldName == "Name");
        Assert.Equal(ConflictThis.IdenticalToMaster, baselineDiff.CellStates["Shared.esp|ModB"]);

        var modAEdited = MakeOverrideWithOrigin("Shared.esp", "ModA", 0, false, ("Name", "Edited"));
        var after = CompareQuery.Classify([modAEdited, modB]);

        var afterDiff = Assert.Single(after.Diffs, d => d.FieldName == "Name");
        Assert.Equal("Edited", afterDiff.Values["Shared.esp|ModA"]);
        Assert.Equal("Original", afterDiff.Values["Shared.esp|ModB"]);
    }

    [Fact]
    public void Classify_TwoPlugins_AllFieldsSame_ReturnsNoConflict()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var override1 = MakeOverride("B.esp", 1, true, ("Name", "Alice"));
        var result = CompareQuery.Classify([master, override1]);
        Assert.Equal(ConflictAll.NoConflict, result.ConflictAll);
        Assert.Equal(ConflictThis.Master, result.PluginStates["A.esp"]);
        Assert.Equal(ConflictThis.IdenticalToMaster, result.PluginStates["B.esp"]);
    }

    [Fact]
    public void Classify_ColumnWithNoCellStates_HasNoPluginState()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var empty = MakeOverride("B.esp", 1, true);
        var result = CompareQuery.Classify([master, empty]);
        Assert.DoesNotContain("B.esp", result.PluginStates.Keys);
    }

    [Fact]
    public void Classify_FourPlugins_OneITM_TwoDisagree_ReturnsConflict_NotNoConflictThoughOneIsIdenticalToMaster()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var loser = MakeOverride("B.esp", 1, false, ("Name", "Bob"));
        var itm = MakeOverride("C.esp", 2, false, ("Name", "Alice"));
        var winner = MakeOverride("D.esp", 3, true, ("Name", "Charlie"));
        var result = CompareQuery.Classify([master, loser, itm, winner]);
        Assert.Equal(ConflictAll.Conflict, result.ConflictAll);
    }

    [Fact]
    public void Classify_TwoPlugins_OneChangesUniqueField_ReturnsOverride()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"), ("Level", 1));
        var override1 = MakeOverride("B.esp", 1, true, ("Name", "Alice"), ("Level", 5));
        var result = CompareQuery.Classify([master, override1]);
        Assert.Equal(ConflictAll.Override, result.ConflictAll);
        Assert.Equal(ConflictThis.Master, result.PluginStates["A.esp"]);
        Assert.Equal(ConflictThis.Override, result.PluginStates["B.esp"]);
    }

    [Fact]
    public void Classify_TwoPlugins_DifferentValues_ReturnsOverride_ForOnlyOneNonMasterChangesTheFieldSoItIsUncontested()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var override1 = MakeOverride("B.esp", 1, true, ("Name", "Bob"));
        var result = CompareQuery.Classify([master, override1]);
        Assert.Equal(ConflictAll.Override, result.ConflictAll);
        Assert.Equal(ConflictThis.Master, result.PluginStates["A.esp"]);
        Assert.Equal(ConflictThis.Override, result.PluginStates["B.esp"]);
    }

    [Fact]
    public void Classify_ThreePlugins_TwoNonMastersDisagree_ReturnsConflict()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var loser = MakeOverride("B.esp", 1, false, ("Name", "Bob"));
        var winner = MakeOverride("C.esp", 2, true, ("Name", "Charlie"));
        var result = CompareQuery.Classify([master, loser, winner]);
        Assert.Equal(ConflictAll.Conflict, result.ConflictAll);
        Assert.Equal(ConflictThis.ConflictLoses, result.PluginStates["B.esp"]);
        Assert.Equal(ConflictThis.ConflictWins, result.PluginStates["C.esp"]);
    }

    [Fact]
    public void Classify_ThreePlugins_OneFieldConflicts_OtherAgreesOnChange_ReturnsConflict()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"), ("Level", 1));
        var loser = MakeOverride("B.esp", 1, false, ("Name", "Bob"), ("Level", 5));
        var winner = MakeOverride("C.esp", 2, true, ("Name", "Bob"), ("Level", 10));
        var result = CompareQuery.Classify([master, loser, winner]);
        Assert.Equal(ConflictAll.Conflict, result.ConflictAll);
    }

    [Fact]
    public void Classify_WinnerChangesField_OnlyOneContesterAmongMultiple_GetsConflictWins()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"), ("Level", 1));
        var contester = MakeOverride("B.esp", 1, false, ("Name", "Bob"), ("Level", 1));
        var nonContester = MakeOverride("C.esp", 2, false, ("Name", null), ("Level", 5));
        var winner = MakeOverride("D.esp", 3, true, ("Name", "Dave"), ("Level", 5));
        var result = CompareQuery.Classify([master, contester, nonContester, winner]);
        Assert.Equal(ConflictThis.ConflictWins, result.PluginStates["D.esp"]);
    }

    [Fact]
    public void Classify_WinnerChangesLevel_OtherChangesName_WinnerGetsOverride_ForAnotherPluginsNameChangeDoesNotContestTheWinnersLevel()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"), ("Level", 1));
        var other = MakeOverride("B.esp", 1, false, ("Name", "Bob"), ("Level", 5));
        var winner = MakeOverride("C.esp", 2, true, ("Name", "Alice"), ("Level", 5));
        var result = CompareQuery.Classify([master, other, winner]);
        Assert.Equal(ConflictThis.Override, result.PluginStates["C.esp"]);
    }

    [Fact]
    public void Classify_LoserChangesMultipleFields_OnlyOneLost_GetsConflictLoses()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"), ("Level", 1));
        var loser = MakeOverride("B.esp", 1, false, ("Name", "Bob"), ("Level", 5));
        var winner = MakeOverride("C.esp", 2, true, ("Name", "Charlie"), ("Level", 5));
        var result = CompareQuery.Classify([master, loser, winner]);
        Assert.Equal(ConflictThis.ConflictLoses, result.PluginStates["B.esp"]);
    }

    [Fact]
    public void Classify_NullFieldInNonMaster_TreatedAsAbsent_NotConflictLoses_ForAPluginThatLeavesTheFieldAbsent()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"), ("Level", 1));
        var partial = MakeOverride("B.esp", 1, false, ("Name", null), ("Level", 5));
        var winner = MakeOverride("C.esp", 2, true, ("Name", "Charlie"), ("Level", 5));
        var result = CompareQuery.Classify([master, partial, winner]);
        Assert.NotEqual(ConflictThis.ConflictLoses, result.PluginStates["B.esp"]);
        Assert.Contains(result.Diffs, d => d.FieldName == "Name");
    }

    [Fact]
    public void Classify_NullFieldInNonMaster_DoesNotCountAsConflict()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var partial = MakeOverride("B.esp", 1, false, ("Name", null));
        var winner = MakeOverride("C.esp", 2, true, ("Name", "Alice"));
        var result = CompareQuery.Classify([master, partial, winner]);
        Assert.NotEqual(ConflictAll.Conflict, result.ConflictAll);
    }

    [Fact]
    public void Classify_RecordWideWinnerHasNullField_WinnerColumnFallsThroughToEarlierPlugin()
    {
        var master = MakeOverride("A.esp", 0, false, ("Level", 1), ("Name", "Alice"));
        var winner = MakeOverride("C.esp", 1, true, ("Level", null), ("Name", "Bob"));
        var result = CompareQuery.Classify([master, winner]);

        var level = result.Diffs.Single(d => d.FieldName == "Level");
        Assert.Equal("A.esp", level.WinnerColumn);
        Assert.Equal(1, level.Values[level.WinnerColumn]);
    }

    [Fact]
    public void Classify_PartialFormOverride_OwnNonNullFieldDiffersFromMaster_StillNoConflict()
    {
        var master = MakeOverride("A.esp", 0, false, ("Level", 1));
        var partial = MakePartialFormOverrideWhoseOwnFieldsAreExcludedRegardlessOfContent("B.esp", 1, true, ("Level", 999));
        var result = CompareQuery.Classify([master, partial]);

        Assert.Equal(ConflictAll.NoConflict, result.ConflictAll);
    }

    [Fact]
    public void Classify_PartialFormOverride_OwnFieldNeverWinsOrLoses()
    {
        var master = MakeOverride("A.esp", 0, false, ("Level", 1));
        var partial = MakePartialFormOverrideWhoseOwnFieldsAreExcludedRegardlessOfContent("B.esp", 1, false, ("Level", 999));
        var winner = MakeOverride("C.esp", 2, true, ("Level", 5));
        var result = CompareQuery.Classify([master, partial, winner]);

        Assert.DoesNotContain(result.Diffs, d => d.CellStates.ContainsKey("B.esp"));
    }

    [Fact]
    public void Classify_TwoPlugins_JsonElementFields_EqualValues_ReturnsNoConflict_ComparedByRawTextNotReferenceEquality()
    {
        var arrayA = JsonSerializer.Deserialize<JsonElement>("[1,2,3]");
        var arrayB = JsonSerializer.Deserialize<JsonElement>("[1,2,3]");
        var master = MakeOverride("A.esp", 0, false, ("Keywords", (object?)arrayA));
        var override1 = MakeOverride("B.esp", 1, true, ("Keywords", (object?)arrayB));
        var result = CompareQuery.Classify([master, override1]);
        Assert.Equal(ConflictAll.NoConflict, result.ConflictAll);
    }

    [Fact]
    public void Classify_TwoPlugins_JsonElementFields_DifferentValues_ReturnsOverride()
    {
        var arrayA = JsonSerializer.Deserialize<JsonElement>("[1,2,3]");
        var arrayB = JsonSerializer.Deserialize<JsonElement>("[4,5,6]");
        var master = MakeOverride("A.esp", 0, false, ("Keywords", (object?)arrayA));
        var override1 = MakeOverride("B.esp", 1, true, ("Keywords", (object?)arrayB));
        var result = CompareQuery.Classify([master, override1]);
        Assert.Equal(ConflictAll.Override, result.ConflictAll);
    }

    [Fact]
    public void Classify_PluginMissingFieldEntirely_TreatedAsNull()
    {
        var master = new RecordDetail("000001:Test.esp", "A.esp", 0, false, null,
            [new FieldValue(Meta("Name"), "Alice"), new FieldValue(Meta("Level"), 1)], Origin: "Data");
        var partial = new RecordDetail("000001:Test.esp", "B.esp", 1, true, null,
            [new FieldValue(Meta("Level"), 5)], Origin: "Data");
        var result = CompareQuery.Classify([master, partial]);
        Assert.Equal(ConflictAll.Override, result.ConflictAll);
        Assert.Equal(ConflictThis.Override, result.PluginStates["B.esp"]);
    }

    [Fact]
    public void Classify_LinkArraySameElementsDifferentOrder_ReturnsOverride()
    {
        var arrayA = JsonSerializer.Deserialize<JsonElement>("[\"a\",\"b\",\"c\"]");
        var arrayB = JsonSerializer.Deserialize<JsonElement>("[\"c\",\"a\",\"b\"]");
        var master = new RecordDetail("000001:Test.esp", "A.esp", 0, false, null,
            [LinkArrayField("Packages", (object?)arrayA)], Origin: "Data");
        var override1 = new RecordDetail("000001:Test.esp", "B.esp", 1, true, null,
            [LinkArrayField("Packages", (object?)arrayB)], Origin: "Data");
        var result = CompareQuery.Classify([master, override1]);
        Assert.Equal(ConflictAll.Override, result.ConflictAll);
        Assert.Equal(ConflictThis.Override, result.Diffs.Single().CellStates["B.esp"]);
    }

    [Fact]
    public void Classify_LinkArrayDifferentLengths_ReturnsOverride()
    {
        var arrayA = JsonSerializer.Deserialize<JsonElement>("[\"a\"]");
        var arrayB = JsonSerializer.Deserialize<JsonElement>("[\"a\",\"b\"]");
        var master = new RecordDetail("000001:Test.esp", "A.esp", 0, false, null,
            [LinkArrayField("scriptProperties", (object?)arrayA)], Origin: "Data");
        var override1 = new RecordDetail("000001:Test.esp", "B.esp", 1, true, null,
            [LinkArrayField("scriptProperties", (object?)arrayB)], Origin: "Data");
        var result = CompareQuery.Classify([master, override1]);
        Assert.Equal(ConflictAll.Override, result.ConflictAll);
    }

    [Fact]
    public void Classify_LinkArrayDifferentElements_ReturnsOverride()
    {
        var arrayA = JsonSerializer.Deserialize<JsonElement>("[\"a\",\"b\"]");
        var arrayB = JsonSerializer.Deserialize<JsonElement>("[\"a\",\"c\"]");
        var master = new RecordDetail("000001:Test.esp", "A.esp", 0, false, null,
            [LinkArrayField("scriptProperties", (object?)arrayA)], Origin: "Data");
        var override1 = new RecordDetail("000001:Test.esp", "B.esp", 1, true, null,
            [LinkArrayField("scriptProperties", (object?)arrayB)], Origin: "Data");
        var result = CompareQuery.Classify([master, override1]);
        Assert.Equal(ConflictAll.Override, result.ConflictAll);
    }

    [Fact]
    public void Classify_UnsortedArraySameElementsDifferentOrder_ReturnsOverride()
    {
        var arrayA = JsonSerializer.Deserialize<JsonElement>("[1,2]");
        var arrayB = JsonSerializer.Deserialize<JsonElement>("[2,1]");
        var master = MakeOverride("A.esp", 0, false, ("Keywords", (object?)arrayA));
        var override1 = MakeOverride("B.esp", 1, true, ("Keywords", (object?)arrayB));
        var result = CompareQuery.Classify([master, override1]);
        Assert.Equal(ConflictAll.Override, result.ConflictAll);
    }

    [Fact]
    public void Classify_TwoPlugins_NonMasterMatchesMaster_CellStateIsIdenticalToMaster_AndTheMasterHasNoCellState()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var override1 = MakeOverride("B.esp", 1, true, ("Name", "Alice"));
        var result = CompareQuery.Classify([master, override1]);
        var nameDiff = result.Diffs.First(d => d.FieldName == "Name");
        Assert.Equal(ConflictThis.IdenticalToMaster, nameDiff.CellStates["B.esp"]);
        Assert.False(nameDiff.CellStates.ContainsKey("A.esp"));
    }

    [Fact]
    public void Classify_TwoPlugins_NonMasterChangesFieldUncontestedly_CellStateIsOverride_AndTheMasterHasNoCellState()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var override1 = MakeOverride("B.esp", 1, true, ("Name", "Bob"));
        var result = CompareQuery.Classify([master, override1]);
        var nameDiff = result.Diffs.First(d => d.FieldName == "Name");
        Assert.Equal(ConflictThis.Override, nameDiff.CellStates["B.esp"]);
        Assert.False(nameDiff.CellStates.ContainsKey("A.esp"));
    }

    [Fact]
    public void Classify_ThreePlugins_TwoDisagreeOnField_WinnerGetsConflictWins_LoserGetsConflictLoses_AndTheMasterHasNoCellState()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var loser = MakeOverride("B.esp", 1, false, ("Name", "Bob"));
        var winner = MakeOverride("C.esp", 2, true, ("Name", "Charlie"));
        var result = CompareQuery.Classify([master, loser, winner]);
        var nameDiff = result.Diffs.First(d => d.FieldName == "Name");
        Assert.Equal(ConflictThis.ConflictWins, nameDiff.CellStates["C.esp"]);
        Assert.Equal(ConflictThis.ConflictLoses, nameDiff.CellStates["B.esp"]);
        Assert.False(nameDiff.CellStates.ContainsKey("A.esp"));
    }

    [Fact]
    public void Classify_FieldWinnerDiffersFromRecordWinner_FieldWinnerGetsOverride_NotConflictLoses_AndTheNullRecordWinnerHasNoCellState()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var fieldWinner = MakeOverride("B.esp", 1, false, ("Name", "Bob"));
        var recordWinner = MakeOverride("C.esp", 2, true, ("Name", null));
        var result = CompareQuery.Classify([master, fieldWinner, recordWinner]);
        var nameDiff = result.Diffs.First(d => d.FieldName == "Name");
        Assert.Equal(ConflictThis.Override, nameDiff.CellStates["B.esp"]);
        Assert.False(nameDiff.CellStates.ContainsKey("C.esp"));
    }

    [Fact]
    public void Classify_NonWinnerMatchesFieldWinner_CellStateIsOverride_NotConflictLoses()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var nonWinner = MakeOverride("B.esp", 1, false, ("Name", "Bob"));
        var winner = MakeOverride("C.esp", 2, true, ("Name", "Bob"));
        var result = CompareQuery.Classify([master, nonWinner, winner]);
        var nameDiff = result.Diffs.First(d => d.FieldName == "Name");
        Assert.Equal(ConflictThis.Override, nameDiff.CellStates["B.esp"]);
    }

    [Fact]
    public void Classify_NullValueInNonMaster_OmittedFromCellStates()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var partial = MakeOverride("B.esp", 1, false, ("Name", null));
        var winner = MakeOverride("C.esp", 2, true, ("Name", "Charlie"));
        var result = CompareQuery.Classify([master, partial, winner]);
        var nameDiff = result.Diffs.First(d => d.FieldName == "Name");
        Assert.False(nameDiff.CellStates.ContainsKey("B.esp"));
        Assert.True(nameDiff.CellStates.ContainsKey("C.esp"));
    }

    [Fact]
    public void Classify_LeafField_AllPluginsAgree_ConflictAllIsNoConflict()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var override1 = MakeOverride("B.esp", 1, true, ("Name", "Alice"));
        var result = CompareQuery.Classify([master, override1]);
        var nameDiff = result.Diffs.First(d => d.FieldName == "Name");
        Assert.Equal(ConflictAll.NoConflict, nameDiff.ConflictAll);
    }

    [Fact]
    public void Classify_LeafField_UncontestedOverride_ConflictAllIsOverride()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var override1 = MakeOverride("B.esp", 1, true, ("Name", "Bob"));
        var result = CompareQuery.Classify([master, override1]);
        var nameDiff = result.Diffs.First(d => d.FieldName == "Name");
        Assert.Equal(ConflictAll.Override, nameDiff.ConflictAll);
    }

    [Fact]
    public void Classify_LeafField_ContestedWinLose_ConflictAllIsConflict()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var loser = MakeOverride("B.esp", 1, false, ("Name", "Bob"));
        var winner = MakeOverride("C.esp", 2, true, ("Name", "Charlie"));
        var result = CompareQuery.Classify([master, loser, winner]);
        var nameDiff = result.Diffs.First(d => d.FieldName == "Name");
        Assert.Equal(ConflictAll.Conflict, nameDiff.ConflictAll);
    }

    [Fact]
    public void Classify_TwoSiblingFields_OnlyOneDiffers_OnlyThatFieldsConflictAllIsNonNoConflict_NotTheRecordWideValueStampedOnEveryRow()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"), ("Level", 5));
        var override1 = MakeOverride("B.esp", 1, true, ("Name", "Bob"), ("Level", 5));
        var result = CompareQuery.Classify([master, override1]);

        var nameDiff = result.Diffs.First(d => d.FieldName == "Name");
        var levelDiff = result.Diffs.First(d => d.FieldName == "Level");
        Assert.Equal(ConflictAll.Override, nameDiff.ConflictAll);
        Assert.Equal(ConflictAll.NoConflict, levelDiff.ConflictAll);
    }

    [Fact]
    public void Classify_StructField_OneSubFieldDiffers_StructConflictAllAggregatesFromChild()
    {
        var subX = Meta("X", "int");
        var subY = Meta("Y", "int");
        var structMeta = StructMeta("Bounds", subX, subY);

        var masterVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 10, \"Y\": 20}");
        var overrideVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 15, \"Y\": 20}");

        var master = MakeStructOverride("A.esp", 0, false, structMeta, masterVal);
        var override1 = MakeStructOverride("B.esp", 1, true, structMeta, overrideVal);

        var result = CompareQuery.Classify([master, override1]);

        var boundsDiff = result.Diffs.First(d => d.FieldName == "Bounds");
        var xChild = RequireChildren(boundsDiff).First(c => c.FieldName == "X");
        var yChild = RequireChildren(boundsDiff).First(c => c.FieldName == "Y");

        Assert.Equal(ConflictAll.Override, xChild.ConflictAll);
        Assert.Equal(ConflictAll.NoConflict, yChild.ConflictAll);
        Assert.Equal(ConflictAll.Override, boundsDiff.ConflictAll);
    }

    [Fact]
    public void Classify_NestedStructInsideTheOverridesElement_GrandchildConflictAggregatesTwoLevelsUp()
    {
        var subX = Meta("X", "int");
        var posMeta = new FieldMetadata("Pos", "struct", false, [], [], Fields: [subX]);
        var elementMeta = new FieldMetadata("", "struct", false, [], [], Fields: [posMeta]);
        var itemsMeta = new FieldMetadata("Items", "array", true, [], [], ElementType: elementMeta);

        var masterVal = JsonSerializer.Deserialize<JsonElement>("[{\"Pos\":{\"X\":1}}]");
        var overrideVal = JsonSerializer.Deserialize<JsonElement>("[{\"Pos\":{\"X\":2}}]");

        var master = new RecordDetail("000001:Test.esp", "A.esp", 0, false, null,
            [new FieldValue(itemsMeta, masterVal)], Origin: "Data");
        var override1 = new RecordDetail("000001:Test.esp", "B.esp", 1, true, null,
            [new FieldValue(itemsMeta, overrideVal)], Origin: "Data");

        var result = CompareQuery.Classify([master, override1]);

        var itemsDiff = result.Diffs.First(d => d.FieldName == "Items");
        var elementDiff = RequireChildren(itemsDiff).First(c => c.FieldName == "[1]");
        var posDiff = RequireChildren(elementDiff).First(c => c.FieldName == "Pos");
        var xDiff = RequireChildren(posDiff).First(c => c.FieldName == "X");

        Assert.Equal(ConflictAll.Override, xDiff.ConflictAll);
        Assert.Equal(ConflictAll.Override, posDiff.ConflictAll);
        Assert.Equal(ConflictAll.Override, elementDiff.ConflictAll);
        Assert.Equal(ConflictAll.Override, itemsDiff.ConflictAll);
    }

    [Fact]
    public void Classify_PerNodeConflictAll_DoesNotChangeRecordWideConflictAll()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"), ("Level", 5));
        var override1 = MakeOverride("B.esp", 1, true, ("Name", "Bob"), ("Level", 5));
        var result = CompareQuery.Classify([master, override1]);
        Assert.Equal(ConflictAll.Override, result.ConflictAll);
    }

    private static FieldMetadata StructMeta(string name, params FieldMetadata[] subFields) =>
        new(name, "struct", false, [], [], Fields: [.. subFields]);

    private static RecordDetail MakeStructOverride(
        string plugin, int loadOrder, bool isWinner,
        FieldMetadata structMeta, object? structValue) =>
        new("000001:Test.esp", plugin, loadOrder, isWinner, null,
            [new FieldValue(structMeta, structValue)], "Data");

    [Fact]
    public void Classify_NonStructField_ChildrenIsNull()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var override1 = MakeOverride("B.esp", 1, true, ("Name", "Bob"));
        var result = CompareQuery.Classify([master, override1]);
        var nameDiff = result.Diffs.First(d => d.FieldName == "Name");
        Assert.Null(nameDiff.Children);
    }

    [Fact]
    public void Classify_StructField_TwoPluginsDifferOnSubField_ChildrenPopulated()
    {
        var subX = Meta("X", "int");
        var subY = Meta("Y", "int");
        var structMeta = StructMeta("Bounds", subX, subY);

        var masterVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 10, \"Y\": 20}");
        var overrideVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 15, \"Y\": 20}");

        var master = MakeStructOverride("A.esp", 0, false, structMeta, masterVal);
        var override1 = MakeStructOverride("B.esp", 1, true, structMeta, overrideVal);

        var result = CompareQuery.Classify([master, override1]);

        var boundsDiff = result.Diffs.First(d => d.FieldName == "Bounds");
        Assert.NotNull(boundsDiff.Children);

        var xChild = RequireChildren(boundsDiff).FirstOrDefault(c => c.FieldName == "X");
        Assert.NotNull(xChild);
        Assert.True(xChild.CellStates.ContainsKey("B.esp"));
        Assert.Equal(ConflictThis.Override, xChild.CellStates["B.esp"]);

        var yChild = RequireChildren(boundsDiff).FirstOrDefault(c => c.FieldName == "Y");
        Assert.NotNull(yChild);
        Assert.True(yChild.CellStates.ContainsKey("B.esp"));
        Assert.Equal(ConflictThis.IdenticalToMaster, yChild.CellStates["B.esp"]);
    }

    [Fact]
    public void Classify_StructField_AllPluginsAgreeOnStruct_ChildrenHaveIdenticalToMasterStates()
    {
        var subX = Meta("X", "int");
        var subY = Meta("Y", "int");
        var structMeta = StructMeta("Bounds", subX, subY);

        var val = JsonSerializer.Deserialize<JsonElement>("{\"X\": 10, \"Y\": 20}");

        var master = MakeStructOverride("A.esp", 0, false, structMeta, val);
        var override1 = MakeStructOverride("B.esp", 1, true, structMeta, val);

        var result = CompareQuery.Classify([master, override1]);

        var boundsDiff = result.Diffs.First(d => d.FieldName == "Bounds");
        Assert.NotNull(boundsDiff.Children);
        Assert.All(RequireChildren(boundsDiff), child =>
            Assert.Equal(ConflictThis.IdenticalToMaster, child.CellStates["B.esp"]));
    }

    [Fact]
    public void Classify_StructField_ThreePluginsTwoDisagreeOnSubField_ConflictWinsAndConflictLoses()
    {
        var subX = Meta("X", "int");
        var structMeta = StructMeta("Pos", subX);

        var masterVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 0}");
        var loserVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 5}");
        var winnerVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 10}");

        var master = MakeStructOverride("A.esp", 0, false, structMeta, masterVal);
        var loser = MakeStructOverride("B.esp", 1, false, structMeta, loserVal);
        var winner = MakeStructOverride("C.esp", 2, true, structMeta, winnerVal);

        var result = CompareQuery.Classify([master, loser, winner]);

        var posDiff = result.Diffs.First(d => d.FieldName == "Pos");
        Assert.NotNull(posDiff.Children);

        var xChild = RequireChildren(posDiff).First(c => c.FieldName == "X");
        Assert.Equal(ConflictThis.ConflictWins, xChild.CellStates["C.esp"]);
        Assert.Equal(ConflictThis.ConflictLoses, xChild.CellStates["B.esp"]);
    }

    [Fact]
    public void Classify_StructField_WinnerMissingField_ChildrenBuiltFromOtherPlugins()
    {
        var subX = Meta("X", "int");
        var structMeta = StructMeta("Pos", subX);

        var masterVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 0}");
        var overrideVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 5}");

        var master = MakeStructOverride("A.esp", 0, false, structMeta, masterVal);
        var override1 = MakeStructOverride("B.esp", 1, false, structMeta, overrideVal);
        var winnerWithoutField = new RecordDetail("000001:Test.esp", "C.esp", 2, true, null, [], Origin: "Data");

        var result = CompareQuery.Classify([master, override1, winnerWithoutField]);

        var posDiff = result.Diffs.FirstOrDefault(d => d.FieldName == "Pos");
        Assert.NotNull(posDiff);
        Assert.NotNull(posDiff.Children);
        Assert.Contains(RequireChildren(posDiff), c => c.FieldName == "X");
    }

    [Fact]
    public void Classify_StructField_SubFieldAbsentInOnePlugin_ThatPluginOmittedFromChildCellStates()
    {
        var subX = Meta("X", "int");
        var subY = Meta("Y", "int");
        var structMeta = StructMeta("Bounds", subX, subY);

        var masterVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 10, \"Y\": 20}");
        var overrideVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 15}");

        var master = MakeStructOverride("A.esp", 0, false, structMeta, masterVal);
        var override1 = MakeStructOverride("B.esp", 1, true, structMeta, overrideVal);

        var result = CompareQuery.Classify([master, override1]);

        var boundsDiff = result.Diffs.First(d => d.FieldName == "Bounds");
        Assert.NotNull(boundsDiff.Children);

        var yChild = RequireChildren(boundsDiff).FirstOrDefault(c => c.FieldName == "Y");
        Assert.NotNull(yChild);
        Assert.False(yChild.CellStates.ContainsKey("B.esp"));
    }

    [Fact]
    public void Classify_StructField_ArraySubFieldIncluded_ProducesChildRows()
    {
        var subX = Meta("X", "int");
        var subYArray = new FieldMetadata("Y", "array", true, [], [],
            ElementType: new FieldMetadata("", "int", false, [], []));
        var structMeta = new FieldMetadata("Bounds", "struct", false, [], [], Fields: [subX, subYArray]);

        var masterVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 10, \"Y\": [1,2]}");
        var overrideVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 15, \"Y\": [3,4]}");

        var master = MakeStructOverride("A.esp", 0, false, structMeta, masterVal);
        var override1 = MakeStructOverride("B.esp", 1, true, structMeta, overrideVal);

        var result = CompareQuery.Classify([master, override1]);

        var boundsDiff = result.Diffs.First(d => d.FieldName == "Bounds");
        Assert.NotNull(boundsDiff.Children);
        Assert.Contains(RequireChildren(boundsDiff), c => c.FieldName == "X");

        var yChild = RequireChildren(boundsDiff).FirstOrDefault(c => c.FieldName == "Y");
        Assert.NotNull(yChild);
        Assert.NotNull(yChild.Children);
        Assert.Equal(4, RequireChildren(yChild).Count);
    }

    [Fact]
    public void Classify_StructField_SubFieldWinnerIsTheHighestLoadOrderPluginWithAValue_NotTheLowest()
    {
        var subX = Meta("X", "int");
        var structMeta = StructMeta("Pos", subX);

        var masterVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 0}");
        var overrideVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 5}");

        var master = MakeStructOverride("A.esp", 0, false, structMeta, masterVal);
        var override1 = MakeStructOverride("B.esp", 1, true, structMeta, overrideVal);

        var result = CompareQuery.Classify([master, override1]);

        var xChild = RequireChildren(result.Diffs.First(d => d.FieldName == "Pos")).First(c => c.FieldName == "X");
        Assert.Equal("B.esp", xChild.WinnerColumn);
        Assert.Equal(5, ((System.Text.Json.JsonElement)(xChild.Values[xChild.WinnerColumn] ?? throw new InvalidOperationException("Expected the winner column value to be non-null."))).GetInt32());
    }

    [Fact]
    public void Classify_StructField_JsonNullSubField_TreatedAsAbsent()
    {
        var subX = Meta("X", "int");
        var subY = Meta("Y", "int");
        var structMeta = StructMeta("Bounds", subX, subY);

        var masterVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 10, \"Y\": 20}");
        var overrideVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 15, \"Y\": null}");

        var master = MakeStructOverride("A.esp", 0, false, structMeta, masterVal);
        var override1 = MakeStructOverride("B.esp", 1, true, structMeta, overrideVal);

        var result = CompareQuery.Classify([master, override1]);

        var yChild = RequireChildren(result.Diffs.First(d => d.FieldName == "Bounds")).FirstOrDefault(c => c.FieldName == "Y");
        Assert.NotNull(yChild);
        Assert.False(yChild.CellStates.ContainsKey("B.esp"));
    }

    [Fact]
    public void Classify_ScalarFormKeyField_PopulatesResolutionPerPlugin()
    {
        var meta = new FieldMetadata("Race", "formKey", false, ["Race"], []);
        var master = new RecordDetail("000001:Test.esp", "A.esp", 0, false, null,
            [new FieldValue(meta, "000AAA:Test.esp")], Origin: "Data");
        var override1 = new RecordDetail("000001:Test.esp", "B.esp", 1, true, null,
            [new FieldValue(meta, "000BBB:Test.esp")], Origin: "Data");

        var result = CompareQuery.Classify([master, override1], resolvable: Lookups(("000AAA:Test.esp", "race", "GoodRace")));

        var diff = result.Diffs.First(d => d.FieldName == "Race");
        Assert.NotNull(diff.Resolutions);
        Assert.Equal(MEditService.Codec.Schema.FormKeyResolutionState.ResolvedValidType, diff.Resolutions["A.esp"].State);
        Assert.Equal("GoodRace", diff.Resolutions["A.esp"].EditorId);
        Assert.Equal(MEditService.Codec.Schema.FormKeyResolutionState.Unresolved, diff.Resolutions["B.esp"].State);
    }

    [Fact]
    public void Classify_LinkArray_SiblingLeavesResolveIndependently_ParentCarriesNoResolutions()
    {
        var arrayA = JsonSerializer.Deserialize<JsonElement>("[\"000AAA:Test.esp\",\"000BBB:Test.esp\"]");
        var master = new RecordDetail("000001:Test.esp", "A.esp", 0, true, null,
            [LinkArrayField("Keywords", (object?)arrayA)], Origin: "Data");

        var result = CompareQuery.Classify([master], resolvable: Lookups(("000AAA:Test.esp", "kywd", "GoodKeyword")));

        var arrayDiff = result.Diffs.First(d => d.FieldName == "Keywords");
        Assert.Null(arrayDiff.Resolutions);

        var kw1 = RequireChildren(arrayDiff)[0];
        var kw2 = RequireChildren(arrayDiff)[1];

        Assert.Equal(MEditService.Codec.Schema.FormKeyResolutionState.ResolvedValidType, RequireResolutions(kw1)["A.esp"].State);
        Assert.Equal(MEditService.Codec.Schema.FormKeyResolutionState.Unresolved, RequireResolutions(kw2)["A.esp"].State);
    }

    [Fact]
    public void Classify_StructFormKeySubField_ReportsItsOwnCheckErrorAndTheParentReportsTheSubtreePathed()
    {
        var factionField = new FieldMetadata("Faction", "formKey", false, ["fact"], []);
        var rankField = Meta("Rank", "int");
        var structMeta = StructMeta("Factions", factionField, rankField);

        var good = JsonSerializer.Deserialize<JsonElement>("""{"Faction":"000FFF:Test.esp","Rank":1}""");
        var dangling = JsonSerializer.Deserialize<JsonElement>("""{"Faction":"000EEE:Test.esp","Rank":1}""");
        var master = MakeStructOverride("A.esp", 0, false, structMeta, good);
        var override1 = MakeStructOverride("B.esp", 1, true, structMeta, dangling);

        var result = CompareQuery.Classify([master, override1], resolvable: Lookups(("000FFF:Test.esp", "fact", "GoodFaction")));

        var factions = result.Diffs.First(d => d.FieldName == "Factions");
        var checkErrors = RequireCheckErrors(factions);
        Assert.Equal("Faction: [000EEE:Test.esp] <Error: Could not be resolved>", checkErrors["B.esp"]);
        Assert.False(checkErrors.ContainsKey("A.esp"));

        var children = RequireChildren(factions);
        Assert.Equal(
            "[000EEE:Test.esp] <Error: Could not be resolved>",
            RequireCheckErrors(children.First(c => c.FieldName == "Faction"))["B.esp"]);
        Assert.Null(children.First(c => c.FieldName == "Rank").CheckErrors);
    }

    [Fact]
    public void Classify_PartialFormColumn_ReportsNoUnsetLinkCheckError_ForAnExclusionIsNotTheRecordSayingTheLinkIsUnset()
    {
        var meta = new FieldMetadata("Race", "formKey", false, ["race"], []);
        var link = JsonSerializer.Deserialize<JsonElement>("\"000AAA:Test.esp\"");
        var master = new RecordDetail("000001:Test.esp", "A.esp", 0, false, null,
            [new FieldValue(meta, link)], "Data");
        var partial = new RecordDetail("000001:Test.esp", "B.esp", 1, true, null,
            [new FieldValue(meta, link)], "Data", IsPartialForm: true);

        var diff = Assert.Single(CompareQuery.Classify([master, partial], resolvable: Lookups(("000AAA:Test.esp", "race", "GoodRace"))).Diffs);

        Assert.Null(diff.CheckErrors);
    }

    [Fact]
    public void Classify_StructFormKeySubField_ResolvesIndependentlyOfSiblingStructField_ANonFormKeySiblingGetsNoResolutions()
    {
        var factionField = new FieldMetadata("Faction", "formKey", false, ["fact"], []);
        var rankField = Meta("Rank", "int");
        var structMeta = StructMeta("Factions", factionField, rankField);

        var val = JsonSerializer.Deserialize<JsonElement>("""{"Faction":"000FFF:Test.esp","Rank":1}""");
        var master = MakeStructOverride("A.esp", 0, true, structMeta, val);

        var result = CompareQuery.Classify([master]);

        var factionsDiff = result.Diffs.First(d => d.FieldName == "Factions");
        var factionChild = RequireChildren(factionsDiff).First(c => c.FieldName == "Faction");
        var rankChild = RequireChildren(factionsDiff).First(c => c.FieldName == "Rank");

        Assert.Equal(MEditService.Codec.Schema.FormKeyResolutionState.Unresolved, RequireResolutions(factionChild)["A.esp"].State);
        Assert.Null(rankChild.Resolutions);
    }
}
