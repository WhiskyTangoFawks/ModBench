using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Queries.Tests.Query;

public class ArrayChildDiffTests
{
    private static ClassifyResult Classify(
        IReadOnlyList<RecordDetail> records,
        ILogger<RecordQueryService>? logger = null) =>
        CompareQuery.Classify(records, logger);

    private static FieldMetadata LinkArrayMeta(string name) =>
        new(name, "array", true, [], [],
            ElementType: new FieldMetadata("", "formKey", false, [], []));

    private static FieldMetadata UnsortedArrayMeta(string name) =>
        new(name, "array", true, [], [],
            ElementType: new FieldMetadata("", "string", false, [], []));

    private static FieldMetadata StructArrayMeta(string name, params FieldMetadata[] subFields) =>
        new(name, "array", true, [], [],
            ElementType: new FieldMetadata("", "struct", false, [], [],
                Fields: [.. subFields]));

    private static RecordDetail MakeRecord(string plugin, int loadOrder, bool isWinner,
        FieldMetadata meta, object? value) =>
        new("000001:Test.esp", plugin, loadOrder, isWinner, null,
            [new FieldValue(meta, value)], "Data");

    private static IReadOnlyList<FieldDiff> RequireChildren(FieldDiff diff) =>
        diff.Children ?? throw new InvalidOperationException($"Expected '{diff.FieldName}' to have children.");

    private static JsonElement Json(string text) => JsonSerializer.Deserialize<JsonElement>(text);

    private static List<string> RowsAsEachColumnsElementOrDashWhereAbsent(ClassifyResult result, string field, params string[] columns) =>
        [.. RequireChildren(result.Diffs.First(d => d.FieldName == field)).Select(row => string.Join(" ",
            columns.Select(c => row.Values[c] is JsonElement e ? e.GetString() ?? e.GetRawText() : "-")))];

    [Fact]
    public void LinkArray_DifferingOnlyInOrder_IsAnOverrideAtTheArrayRow()
    {
        var meta = new FieldMetadata("Owner", "struct", false, [], [], Fields: [LinkArrayMeta("Packages")]);
        var a = Json("{\"Packages\":[\"PkgA\",\"PkgB\"]}");
        var b = Json("{\"Packages\":[\"PkgB\",\"PkgA\"]}");

        var result = Classify([MakeRecord("A.esp", 0, false, meta, a), MakeRecord("B.esp", 1, true, meta, b)]);

        var packages = RequireChildren(result.Diffs.First(d => d.FieldName == "Owner")).First(c => c.FieldName == "Packages");
        Assert.Equal(ConflictThis.Override, packages.CellStates["B.esp"]);
    }

    [Fact]
    public void Array_AnElementTheOverrideLacks_ReadsAsAnAbsenceWhereItIsMissing()
    {
        var meta = LinkArrayMeta("Packages");

        var result = Classify([
            MakeRecord("A.esp", 0, false, meta, Json("[\"x\",\"y\",\"z\"]")),
            MakeRecord("B.esp", 1, true, meta, Json("[\"x\",\"z\"]"))]);

        Assert.Equal(["x x", "y -", "z z"], RowsAsEachColumnsElementOrDashWhereAbsent(result, "Packages", "A.esp", "B.esp"));
    }

    [Fact]
    public void Array_AnElementInsertedAtTheFront_LeavesTheRestAligned()
    {
        var meta = UnsortedArrayMeta("Items");

        var result = Classify([
            MakeRecord("A.esp", 0, false, meta, Json("[\"a\",\"b\"]")),
            MakeRecord("B.esp", 1, true, meta, Json("[\"n\",\"a\",\"b\"]"))]);

        Assert.Equal(["- n", "a a", "b b"], RowsAsEachColumnsElementOrDashWhereAbsent(result, "Items", "A.esp", "B.esp"));
        var rows = RequireChildren(result.Diffs.First(d => d.FieldName == "Items"));
        Assert.Equal(ConflictThis.Override, rows[0].CellStates["B.esp"]);
        Assert.Equal(ConflictThis.IdenticalToMaster, rows[1].CellStates["B.esp"]);
        Assert.Equal(ConflictThis.IdenticalToMaster, rows[2].CellStates["B.esp"]);
    }

    [Fact]
    public void Array_AChangedElement_IsTheMastersElementAndThenTheOverrides_AsXEditsDiffMakesNoModificationOfAPair()
    {
        var meta = UnsortedArrayMeta("Items");

        var result = Classify([
            MakeRecord("A.esp", 0, false, meta, Json("[\"a\",\"b\",\"c\"]")),
            MakeRecord("B.esp", 1, true, meta, Json("[\"a\",\"x\",\"c\"]"))]);

        Assert.Equal(["a a", "b -", "- x", "c c"], RowsAsEachColumnsElementOrDashWhereAbsent(result, "Items", "A.esp", "B.esp"));
    }

    [Fact]
    public void Array_EachColumnAlignsAgainstEveryColumnBeforeIt()
    {
        var meta = UnsortedArrayMeta("Items");

        var result = Classify([
            MakeRecord("A.esp", 0, false, meta, Json("[\"a\",\"b\"]")),
            MakeRecord("B.esp", 1, false, meta, Json("[\"a\",\"c\",\"b\"]")),
            MakeRecord("C.esp", 2, true, meta, Json("[\"a\",\"b\",\"d\"]"))]);

        Assert.Equal(["a a a", "- c -", "b b b", "- - d"], RowsAsEachColumnsElementOrDashWhereAbsent(result, "Items", "A.esp", "B.esp", "C.esp"));
    }

    [Fact]
    public void Array_AColumnWithoutTheArray_AlignsNothing()
    {
        var meta = UnsortedArrayMeta("Items");

        var result = Classify([
            MakeRecord("A.esp", 0, false, meta, null),
            MakeRecord("B.esp", 1, true, meta, Json("[\"a\",\"b\"]"))]);

        Assert.Equal(["- a", "- b"], RowsAsEachColumnsElementOrDashWhereAbsent(result, "Items", "A.esp", "B.esp"));
    }

    [Fact]
    public void LinkArray_ARepeatedElement_IsARowForEachPlaceItHolds()
    {
        var meta = LinkArrayMeta("Packages");

        var result = Classify([
            MakeRecord("A.esp", 0, false, meta, Json("[\"PkgA\",\"PkgA\"]")),
            MakeRecord("B.esp", 1, true, meta, Json("[\"PkgA\"]"))]);

        Assert.Equal(["PkgA PkgA", "PkgA -"], RowsAsEachColumnsElementOrDashWhereAbsent(result, "Packages", "A.esp", "B.esp"));
    }

    [Fact]
    public void Array_EachRowCarriesTheElementsIndexInEachColumnThatHoldsIt()
    {
        var meta = UnsortedArrayMeta("Items");

        var result = Classify([
            MakeRecord("A.esp", 0, false, meta, Json("[\"x\",null,\"z\"]")),
            MakeRecord("B.esp", 1, true, meta, Json("[null,\"z\"]"))]);

        var rows = RequireChildren(result.Diffs.First(d => d.FieldName == "Items"));
        Assert.Equal(
            [
                new Dictionary<string, int> { ["A.esp"] = 0 },
                new Dictionary<string, int> { ["A.esp"] = 1, ["B.esp"] = 0 },
                new Dictionary<string, int> { ["A.esp"] = 2, ["B.esp"] = 1 },
            ],
            rows.Select(r => r.Indexes));
    }

    [Fact]
    public void KeyedArray_EachRowCarriesTheElementsIndexInItsColumn_NotItsPlaceInKeyOrder()
    {
        var meta = new FieldMetadata("Stages", "array", true, [], [],
            ElementType: new FieldMetadata("", "struct", false, [], [], Fields: [new FieldMetadata("Index", "int", false, [], [])]),
            KeyMembers: ["Index"]);

        var result = Classify([MakeRecord("A.esp", 0, true, meta, Json("[{\"Index\":20},{\"Index\":10}]"))]);

        var rows = RequireChildren(result.Diffs.First(d => d.FieldName == "Stages"));
        Assert.Equal(["10", "20"], rows.Select(r => r.FieldName));
        Assert.Equal(
            [new Dictionary<string, int> { ["A.esp"] = 1 }, new Dictionary<string, int> { ["A.esp"] = 0 }],
            rows.Select(r => r.Indexes));
    }

    private static FieldMetadata ScriptsAndTheirPropertiesKeyedByName()
    {
        var property = new FieldMetadata("", "struct", false, [], [],
            Fields: [new FieldMetadata("Name", "string", false, [], []), new FieldMetadata("Data", "int", false, [], [])]);
        var script = new FieldMetadata("", "struct", false, [], [],
            Fields:
            [
                new FieldMetadata("Name", "string", false, [], []),
                new FieldMetadata("Properties", "array", true, [], [], ElementType: property, KeyMembers: ["Name"]),
            ]);
        return new FieldMetadata("Adapter", "struct", false, [], [],
            Fields: [new FieldMetadata("Scripts", "array", true, [], [], ElementType: script, KeyMembers: ["Name"])]);
    }

    [Fact]
    public void KeyedArrays_DifferingOnlyInOrderAtAnyDepth_AreIdenticalToMasterAtEveryRow()
    {
        var master = Json("""{"Scripts":[{"Name":"A","Properties":[{"Name":"x","Data":1},{"Name":"y","Data":2}]},{"Name":"B"}]}""");
        var reordered = Json("""{"Scripts":[{"Name":"B"},{"Name":"A","Properties":[{"Name":"y","Data":2},{"Name":"x","Data":1}]}]}""");

        var result = Classify([MakeRecord("A.esp", 0, false, ScriptsAndTheirPropertiesKeyedByName(), master), MakeRecord("B.esp", 1, true, ScriptsAndTheirPropertiesKeyedByName(), reordered)]);

        var adapter = result.Diffs.Single(d => d.FieldName == "Adapter");
        var scripts = RequireChildren(adapter).Single();
        Assert.Equal(ConflictThis.IdenticalToMaster, adapter.CellStates["B.esp"]);
        Assert.Equal(ConflictThis.IdenticalToMaster, scripts.CellStates["B.esp"]);
        Assert.Equal(ConflictAll.NoConflict, result.ConflictAll);
    }

    [Fact]
    public void KeyedArray_AChangedElement_IsAnOverrideAtTheArrayRow()
    {
        var master = Json("""{"Scripts":[{"Name":"A","Properties":[{"Name":"x","Data":1}]},{"Name":"B"}]}""");
        var changed = Json("""{"Scripts":[{"Name":"B"},{"Name":"A","Properties":[{"Name":"x","Data":9}]}]}""");

        var result = Classify([MakeRecord("A.esp", 0, false, ScriptsAndTheirPropertiesKeyedByName(), master), MakeRecord("B.esp", 1, true, ScriptsAndTheirPropertiesKeyedByName(), changed)]);

        var scripts = RequireChildren(result.Diffs.Single(d => d.FieldName == "Adapter")).Single();
        Assert.Equal(ConflictThis.Override, scripts.CellStates["B.esp"]);
    }

    [Fact]
    public void KeyedArray_TwoElementsSharingAKey_EachTakeARow_AlignedByTheirTurnAtThatKey()
    {
        var meta = new FieldMetadata("Stages", "array", true, [], [],
            ElementType: new FieldMetadata("", "struct", false, [], [],
                Fields: [new FieldMetadata("Index", "int", false, [], []), new FieldMetadata("Note", "string", false, [], [])]),
            KeyMembers: ["Index"]);

        var result = Classify([
            MakeRecord("A.esp", 0, false, meta, Json("""[{"Index":10,"Note":"a"},{"Index":20,"Note":"b"}]""")),
            MakeRecord("B.esp", 1, true, meta, Json("""[{"Index":20,"Note":"b"},{"Index":10,"Note":"a"},{"Index":10,"Note":"c"}]"""))]);

        var rows = RequireChildren(result.Diffs.Single(d => d.FieldName == "Stages"));
        Assert.Equal(["10", "10", "20"], rows.Select(r => r.FieldName));
        Assert.Equal(
            [
                new Dictionary<string, int> { ["A.esp"] = 0, ["B.esp"] = 1 },
                new Dictionary<string, int> { ["B.esp"] = 2 },
                new Dictionary<string, int> { ["A.esp"] = 1, ["B.esp"] = 0 },
            ],
            rows.Select(r => r.Indexes));
    }

    [Fact]
    public void Array_RowsAreLabelledByTheirPlaceInTheAlignment()
    {
        var meta = UnsortedArrayMeta("Items");

        var result = Classify([
            MakeRecord("A.esp", 0, false, meta, Json("[\"a\"]")),
            MakeRecord("B.esp", 1, true, meta, Json("[\"n\",\"a\"]"))]);

        Assert.Equal(["[0]", "[1]"], RequireChildren(result.Diffs.First(d => d.FieldName == "Items")).Select(c => c.FieldName));
    }

    [Fact]
    public void LinkArray_NullSlotInOneColumnOnly_IsNotReadAsThatColumnsDefault_ForTheCodecOmitsAMemberEqualToItsDefaultButNeverAnElement()
    {
        var meta = LinkArrayMeta("Keywords");

        var result = Classify([
            MakeRecord("A.esp", 0, false, meta, Json("[\"KwdA\"]")),
            MakeRecord("B.esp", 1, true, meta, Json("[\"KwdA\",\"Null\"]"))]);

        var slot = RequireChildren(result.Diffs.First(d => d.FieldName == "Keywords"))[1];
        Assert.Equal(ConflictThis.Override, slot.CellStates["B.esp"]);
    }

    [Fact]
    public void UnsortedArray_TrailingZeroElementInOneColumn_IsNotReadAsTheOtherColumnsAbsence()
    {
        var meta = new FieldMetadata("Items", "array", true, [], [],
            ElementType: new FieldMetadata("", "int", false, [], []));

        var result = Classify([
            MakeRecord("A.esp", 0, false, meta, Json("[1,2]")),
            MakeRecord("B.esp", 1, true, meta, Json("[1,2,0]"))]);

        var third = RequireChildren(result.Diffs.First(d => d.FieldName == "Items"))[2];
        Assert.Equal(ConflictThis.Override, third.CellStates["B.esp"]);
    }

    [Fact]
    public void UnsortedArray_RaggedLengths_ChildCountIsMax_ShortPluginGetsNullForMissingIndex()
    {
        var meta = UnsortedArrayMeta("Items");
        var arrayA = JsonSerializer.Deserialize<JsonElement>("[\"x\",\"y\",\"z\"]");
        var arrayB = JsonSerializer.Deserialize<JsonElement>("[\"x\",\"y\"]");

        var master = MakeRecord("A.esp", 0, false, meta, arrayA);
        var override1 = MakeRecord("B.esp", 1, true, meta, arrayB);

        var result = Classify([master, override1]);

        var children = RequireChildren(result.Diffs.First(d => d.FieldName == "Items"));
        Assert.Equal(3, children.Count);
        Assert.Equal("[0]", children[0].FieldName);
        Assert.Equal("[1]", children[1].FieldName);
        Assert.Equal("[2]", children[2].FieldName);
        Assert.Null(children[2].Values["B.esp"]);
        Assert.False(children[2].CellStates.ContainsKey("B.esp"));
    }

    [Fact]
    public void Array_ExceedingMaxArrayChildCount_ReturnsNullChildren_LogsWarning()
    {
        var logEntries = new List<LogEntry>();
        using var loggerFactory = LoggerFactory.Create(b =>
            b.AddProvider(new CollectingLoggerProvider(logEntries)));
        var logger = loggerFactory.CreateLogger<RecordQueryService>();

        var meta = UnsortedArrayMeta("Items");
        var oneOverMaxArrayChildCount = JsonSerializer.Deserialize<JsonElement>(
            "[" + string.Join(",", Enumerable.Range(0, 501).Select(i => $"\"{i}\"")) + "]");

        var master = MakeRecord("A.esp", 0, false, meta, oneOverMaxArrayChildCount);
        var override1 = MakeRecord("B.esp", 1, true, meta, oneOverMaxArrayChildCount);

        var result = Classify([master, override1], logger);

        var kwdDiff = result.Diffs.First(d => d.FieldName == "Items");
        Assert.Null(kwdDiff.Children);
        Assert.Contains(logEntries, e => e.Message.Contains("MaxArrayChildCount"));
    }

    [Fact]
    public void StructTypedArrayElement_WithAChangedMember_IsTheMastersElementThenTheOverrides()
    {
        var meta = StructArrayMeta("Ranks",
            new FieldMetadata("Rank", "int", false, [], []));

        var arrayA = JsonSerializer.Deserialize<JsonElement>("[{\"Rank\":1},{\"Rank\":2}]");
        var arrayB = JsonSerializer.Deserialize<JsonElement>("[{\"Rank\":1},{\"Rank\":9}]");

        var master = MakeRecord("A.esp", 0, false, meta, arrayA);
        var override1 = MakeRecord("B.esp", 1, true, meta, arrayB);

        var result = Classify([master, override1]);

        var ranks = RequireChildren(result.Diffs.First(d => d.FieldName == "Ranks"));
        Assert.Equal(3, ranks.Count);
        Assert.All(ranks, element => Assert.Contains(RequireChildren(element), c => c.FieldName == "Rank"));

        var overridesRank = RequireChildren(ranks[2]).First(c => c.FieldName == "Rank");
        Assert.Null(overridesRank.Values["A.esp"]);
        Assert.Equal(ConflictThis.Override, overridesRank.CellStates["B.esp"]);
    }

    [Fact]
    public void StructField_ArraySubFieldWithNoElementType_EmitsWithNullChildren_DoesNotThrow()
    {
        var subArray = new FieldMetadata("Items", "array", true, [], []);
        var structMeta = new FieldMetadata("Bounds", "struct", false, [], [],
            Fields: [new FieldMetadata("X", "int", false, [], []), subArray]);
        var val = JsonSerializer.Deserialize<JsonElement>("{\"X\": 1, \"Items\": [1,2,3]}");

        var master = MakeRecord("A.esp", 0, false, structMeta, val);
        var override1 = MakeRecord("B.esp", 1, true, structMeta, val);

        var result = Classify([master, override1]);

        var boundsDiff = result.Diffs.First(d => d.FieldName == "Bounds");
        Assert.NotNull(boundsDiff.Children);
        var itemsChild = RequireChildren(boundsDiff).First(c => c.FieldName == "Items");
        Assert.Null(itemsChild.Children);
    }

    [Fact]
    public void StructField_NestedStruct_RecursesIntoSubSubFields()
    {
        var innerMeta = new FieldMetadata("Inner", "struct", false, [], [],
            Fields: [new FieldMetadata("Value", "int", false, [], [])]);
        var outerMeta = new FieldMetadata("Outer", "struct", false, [], [],
            Fields: [innerMeta]);
        var valA = JsonSerializer.Deserialize<JsonElement>("{\"Inner\": {\"Value\": 1}}");
        var valB = JsonSerializer.Deserialize<JsonElement>("{\"Inner\": {\"Value\": 2}}");

        var master = MakeRecord("A.esp", 0, false, outerMeta, valA);
        var override1 = MakeRecord("B.esp", 1, true, outerMeta, valB);

        var result = Classify([master, override1]);

        var outerDiff = result.Diffs.First(d => d.FieldName == "Outer");
        Assert.NotNull(outerDiff.Children);
        var innerChild = RequireChildren(outerDiff).First(c => c.FieldName == "Inner");
        Assert.NotNull(innerChild.Children);
        Assert.Contains(RequireChildren(innerChild), c => c.FieldName == "Value");
    }

    [Fact]
    public void StructField_AllSubFieldValuesAbsentFromJson_ReturnsNullChildren()
    {
        var structMeta = new FieldMetadata("Bounds", "struct", false, [], [],
            Fields: [new FieldMetadata("X", "int", false, [], [])]);
        var emptyStruct = JsonSerializer.Deserialize<JsonElement>("{}");

        var master = MakeRecord("A.esp", 0, false, structMeta, emptyStruct);
        var override1 = MakeRecord("B.esp", 1, true, structMeta, emptyStruct);

        var result = Classify([master, override1]);

        Assert.Null(result.Diffs.First(d => d.FieldName == "Bounds").Children);
    }

    [Fact]
    public void LinkArray_AllPluginsHaveEmptyArray_ReturnsNullChildren()
    {
        var meta = LinkArrayMeta("Keywords");
        var emptyArray = JsonSerializer.Deserialize<JsonElement>("[]");

        var master = MakeRecord("A.esp", 0, false, meta, emptyArray);
        var override1 = MakeRecord("B.esp", 1, true, meta, emptyArray);

        var result = Classify([master, override1]);

        Assert.Null(result.Diffs.First(d => d.FieldName == "Keywords").Children);
    }

    [Fact]
    public void LinkArray_ExceedingMaxArrayChildCount_ReturnsNullChildren_LogsWarning()
    {
        var logEntries = new List<LogEntry>();
        using var loggerFactory = LoggerFactory.Create(b =>
            b.AddProvider(new CollectingLoggerProvider(logEntries)));
        var logger = loggerFactory.CreateLogger<RecordQueryService>();

        var meta = LinkArrayMeta("Keywords");
        var bigArray = JsonSerializer.Deserialize<JsonElement>(
            "[" + string.Join(",", Enumerable.Range(0, 501).Select(i => $"\"Kwd{i}\"")) + "]");

        var master = MakeRecord("A.esp", 0, true, meta, bigArray);

        var result = Classify([master], logger);

        Assert.Null(result.Diffs.First(d => d.FieldName == "Keywords").Children);
        Assert.Contains(logEntries, e => e.Message.Contains("MaxArrayChildCount"));
    }

    [Fact]
    public void LinkArray_AtExactlyMaxArrayChildCount_ReturnsChildren()
    {
        var meta = LinkArrayMeta("Keywords");
        var exactly500 = JsonSerializer.Deserialize<JsonElement>(
            "[" + string.Join(",", Enumerable.Range(0, 500).Select(i => $"\"Kwd{i}\"")) + "]");

        var master = MakeRecord("A.esp", 0, true, meta, exactly500);

        var result = Classify([master]);

        Assert.Equal(500, RequireChildren(result.Diffs.First(d => d.FieldName == "Keywords")).Count);
    }

    [Fact]
    public void UnsortedArray_AtExactlyMaxArrayChildCount_ReturnsChildren()
    {
        var meta = UnsortedArrayMeta("Items");
        var exactly500 = JsonSerializer.Deserialize<JsonElement>(
            "[" + string.Join(",", Enumerable.Range(0, 500).Select(i => $"\"{i}\"")) + "]");

        var master = MakeRecord("A.esp", 0, true, meta, exactly500);

        var result = Classify([master]);

        Assert.Equal(500, RequireChildren(result.Diffs.First(d => d.FieldName == "Items")).Count);
    }
}
