using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Query;

public class ArrayChildDiffTests
{
    private const char NullSlot = '_';

    private static FormKey Element(char name) => ComparedCopies.InMaster(0x900u + name);

    private static Action<FormList> List(string elements) =>
        list => list.Items.AddRange(elements.Select(name => new FormLink<IFallout4MajorRecordGetter>(name == NullSlot ? FormKey.Null : Element(name))));

    private static Action<FormList> ListOf(int count) =>
        list => list.Items.AddRange(Enumerable.Range(0, count).Select(i => new FormLink<IFallout4MajorRecordGetter>(ComparedCopies.InMaster(0x1000u + (uint)i))));

    private static Action<MiscItem> DisplayIndices(params byte[] indices) => misc => misc.ComponentDisplayIndices = [.. indices];

    private static Action<Quest> Stages(params (ushort Index, byte Unknown)[] stages) =>
        quest => quest.Stages.AddRange(stages.Select(stage => new QuestStage { Index = stage.Index, Unknown = stage.Unknown }));

    private static FieldDiff Row(CompareResult result, string field) => result.Diffs.Single(d => d.FieldName == field);

    private static IReadOnlyList<FieldDiff> RequireChildren(FieldDiff diff) =>
        diff.Children ?? throw new InvalidOperationException($"Expected '{diff.FieldName}' to have children.");

    private static string NameOf(JsonElement element) =>
        element.ValueKind == JsonValueKind.String && FormKey.TryFactory(element.GetString(), out var key) && !key.IsNull
            ? ((char)(key.ID - 0x900)).ToString()
            : element.ToString();

    private static List<string> RowsAsEachColumnsElementOrDashWhereAbsent(CompareResult result, string field, params string[] columns) =>
        [.. RequireChildren(Row(result, field)).Select(row => string.Join(" ",
            columns.Select(c => row.Values[c] is JsonElement e ? NameOf(e) : "-")))];

    [Fact]
    public void Array_AnElementTheOverrideLacks_ReadsAsAnAbsenceWhereItIsMissing()
    {
        var result = ComparedCopies.Of(List("xyz"), List("xz"));

        Assert.Equal(["x x", "y -", "z z"], RowsAsEachColumnsElementOrDashWhereAbsent(result, "Items", "A.esp", "B.esp"));
    }

    [Fact]
    public void Array_AnElementInsertedAtTheFront_LeavesTheRestAligned()
    {
        var result = ComparedCopies.Of(List("ab"), List("nab"));

        Assert.Equal(["- n", "a a", "b b"], RowsAsEachColumnsElementOrDashWhereAbsent(result, "Items", "A.esp", "B.esp"));
        var rows = RequireChildren(Row(result, "Items"));
        Assert.Equal(ConflictThis.Override, rows[0].CellStates["B.esp"]);
        Assert.Equal(ConflictThis.IdenticalToMaster, rows[1].CellStates["B.esp"]);
        Assert.Equal(ConflictThis.IdenticalToMaster, rows[2].CellStates["B.esp"]);
    }

    [Fact]
    public void Array_AChangedElement_IsTheMastersElementAndThenTheOverrides_AsXEditsDiffMakesNoModificationOfAPair()
    {
        var result = ComparedCopies.Of(List("abc"), List("axc"));

        Assert.Equal(["a a", "b -", "- x", "c c"], RowsAsEachColumnsElementOrDashWhereAbsent(result, "Items", "A.esp", "B.esp"));
    }

    [Fact]
    public void Array_EachColumnAlignsAgainstEveryColumnBeforeIt()
    {
        var result = ComparedCopies.Of(List("ab"), List("acb"), List("abd"));

        Assert.Equal(["a a a", "- c -", "b b b", "- - d"], RowsAsEachColumnsElementOrDashWhereAbsent(result, "Items", "A.esp", "B.esp", "C.esp"));
    }

    [Fact]
    public void Array_AColumnWithoutTheArray_AlignsNothing()
    {
        var result = ComparedCopies.Of(List(""), List("ab"));

        Assert.Equal(["- a", "- b"], RowsAsEachColumnsElementOrDashWhereAbsent(result, "Items", "A.esp", "B.esp"));
    }

    [Fact]
    public void LinkArray_ARepeatedElement_IsARowForEachPlaceItHolds()
    {
        var result = ComparedCopies.Of(List("aa"), List("a"));

        Assert.Equal(["a a", "a -"], RowsAsEachColumnsElementOrDashWhereAbsent(result, "Items", "A.esp", "B.esp"));
    }

    [Fact]
    public void Array_EachRowCarriesTheElementsIndexInEachColumnThatHoldsIt()
    {
        var result = ComparedCopies.Of(List("x_z"), List("_z"));

        Assert.Equal(
            [
                new Dictionary<string, int> { ["A.esp"] = 0 },
                new Dictionary<string, int> { ["A.esp"] = 1, ["B.esp"] = 0 },
                new Dictionary<string, int> { ["A.esp"] = 2, ["B.esp"] = 1 },
            ],
            RequireChildren(Row(result, "Items")).Select(r => r.Indexes));
    }

    [Fact]
    public void KeyedArray_EachRowCarriesTheElementsIndexInItsColumn_NotItsPlaceInKeyOrder()
    {
        var rows = RequireChildren(Row(ComparedCopies.Of(Stages((20, 0), (10, 0))), "Stages"));

        Assert.Equal(["10", "20"], rows.Select(r => r.FieldName));
        Assert.Equal(
            [new Dictionary<string, int> { ["A.esp"] = 1 }, new Dictionary<string, int> { ["A.esp"] = 0 }],
            rows.Select(r => r.Indexes));
    }

    private static ScriptEntry Script(string name, params (string Name, int Data)[] properties) =>
        new() { Name = name, Properties = [.. properties.Select(p => new ScriptIntProperty { Name = p.Name, Data = p.Data })] };

    private static Action<Npc> Scripts(params ScriptEntry[] scripts) =>
        npc => npc.VirtualMachineAdapter = new VirtualMachineAdapter { Version = 6, ObjectFormat = 2, Scripts = [.. scripts] };

    [Fact]
    public void KeyedArrays_DifferingOnlyInOrderAtAnyDepth_AreIdenticalToMasterAtEveryRow()
    {
        var result = ComparedCopies.Of(
            Scripts(Script("A", ("x", 1), ("y", 2)), Script("B")),
            Scripts(Script("B"), Script("A", ("y", 2), ("x", 1))));

        var adapter = Row(result, "VirtualMachineAdapter");
        Assert.Equal(ConflictThis.IdenticalToMaster, adapter.CellStates["B.esp"]);
        Assert.Equal(ConflictThis.IdenticalToMaster, RequireChildren(adapter).Single(c => c.FieldName == "Scripts").CellStates["B.esp"]);
        Assert.Equal(ConflictAll.NoConflict, result.ConflictAll);
    }

    [Fact]
    public void KeyedArray_AChangedElement_IsAnOverrideAtTheArrayRow()
    {
        var result = ComparedCopies.Of(
            Scripts(Script("A", ("x", 1)), Script("B")),
            Scripts(Script("B"), Script("A", ("x", 9))));

        var scripts = RequireChildren(Row(result, "VirtualMachineAdapter")).Single(c => c.FieldName == "Scripts");
        Assert.Equal(ConflictThis.Override, scripts.CellStates["B.esp"]);
    }

    [Fact]
    public void KeyedArray_TwoElementsSharingAKey_EachTakeARow_AlignedByTheirTurnAtThatKey()
    {
        var result = ComparedCopies.Of(Stages((10, 1), (20, 2)), Stages((20, 2), (10, 1), (10, 3)));

        var rows = RequireChildren(Row(result, "Stages"));
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
        var result = ComparedCopies.Of(List("a"), List("na"));

        Assert.Equal(["[0]", "[1]"], RequireChildren(Row(result, "Items")).Select(c => c.FieldName));
    }

    [Fact]
    public void LinkArray_NullSlotInOneColumnOnly_IsNotReadAsThatColumnsDefault_ForTheCodecOmitsAMemberEqualToItsDefaultButNeverAnElement()
    {
        var slot = RequireChildren(Row(ComparedCopies.Of(List("k"), List("k_")), "Items"))[1];

        Assert.Equal(ConflictThis.Override, slot.CellStates["B.esp"]);
    }

    [Fact]
    public void UnsortedArray_TrailingZeroElementInOneColumn_IsNotReadAsTheOtherColumnsAbsence()
    {
        var third = RequireChildren(Row(ComparedCopies.Of(DisplayIndices(1, 2), DisplayIndices(1, 2, 0)), "ComponentDisplayIndices"))[2];

        Assert.Equal(ConflictThis.Override, third.CellStates["B.esp"]);
    }

    [Fact]
    public void UnsortedArray_RaggedLengths_ChildCountIsMax_ShortPluginGetsNullForMissingIndex()
    {
        var children = RequireChildren(Row(ComparedCopies.Of(List("xyz"), List("xy")), "Items"));

        Assert.Equal(["[0]", "[1]", "[2]"], children.Select(c => c.FieldName));
        Assert.Null(children[2].Values["B.esp"]);
        Assert.False(children[2].CellStates.ContainsKey("B.esp"));
    }

    [Fact]
    public void Array_ExceedingMaxArrayChildCount_ReturnsNullChildren()
    {
        Assert.Null(Row(ComparedCopies.Of(ListOf(501), ListOf(501)), "Items").Children);
    }

    [Fact]
    public void StructTypedArrayElement_WithAChangedMember_IsTheMastersElementThenTheOverrides()
    {
        static Action<MiscItem> Components(params uint[] counts) =>
            misc => misc.Components = [.. counts.Select(count => new MiscItemComponent { Component = new FormLink<IComponentGetter>(Element('c')), Count = count })];

        var components = RequireChildren(Row(ComparedCopies.Of(Components(1, 2), Components(1, 9)), "Components"));

        Assert.Equal(3, components.Count);
        Assert.All(components, element => Assert.Contains(RequireChildren(element), c => c.FieldName == "Count"));
        var overridesCount = RequireChildren(components[2]).Single(c => c.FieldName == "Count");
        Assert.Null(overridesCount.Values["A.esp"]);
        Assert.Equal(ConflictThis.Override, overridesCount.CellStates["B.esp"]);
    }

    [Fact]
    public void StructField_NestedStruct_RecursesIntoSubSubFields()
    {
        static Action<Npc> Health(int health) => npc => npc.Destructible = new Destructible { Data = new DestructableData { Health = health } };

        var destructible = Row(ComparedCopies.Of(Health(1), Health(2)), "Destructible");

        var data = RequireChildren(destructible).Single(c => c.FieldName == "Data");
        Assert.Contains(RequireChildren(data), c => c.FieldName == "Health");
    }

    [Fact]
    public void StructField_AllSubFieldValuesAbsentFromJson_ReturnsNullChildren()
    {
        static void Defaulted(Npc npc) => npc.Weight = new NpcWeight();

        Assert.Null(Row(ComparedCopies.Of<Npc>(Defaulted, Defaulted), "Weight").Children);
    }

    [Fact]
    public void LinkArray_AnEmptyArray_HasNoChildren()
    {
        var result = ComparedCopies.Spelled("B.esp", document => document["Items"] = new JsonArray(), List(""), List(""));

        Assert.Null(Row(result, "Items").Children);
    }

    [Fact]
    public void LinkArray_ExceedingMaxArrayChildCount_ReturnsNullChildren()
    {
        Assert.Null(Row(ComparedCopies.Of(ListOf(501)), "Items").Children);
    }

    [Fact]
    public void LinkArray_AtExactlyMaxArrayChildCount_ReturnsChildren()
    {
        Assert.Equal(500, RequireChildren(Row(ComparedCopies.Of(ListOf(500)), "Items")).Count);
    }

    [Fact]
    public void UnsortedArray_AtExactlyMaxArrayChildCount_ReturnsChildren()
    {
        var result = ComparedCopies.Of(DisplayIndices([.. Enumerable.Range(0, 500).Select(i => (byte)i)]));

        Assert.Equal(500, RequireChildren(Row(result, "ComponentDisplayIndices")).Count);
    }
}
