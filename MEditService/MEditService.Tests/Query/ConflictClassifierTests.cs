using System.Text.Json;
using MEditService.Core.Queries;
using Mutagen.Bethesda;

namespace MEditService.Tests.Query;

public class ConflictClassifierTests
{
    private static readonly IReadOnlyDictionary<string, IReadOnlyList<string>> NoMasters =
        new Dictionary<string, IReadOnlyList<string>>();

    private static readonly ConflictClassifier Classifier = new ConflictClassifier();

    private static ClassifyResult Classify(IReadOnlyList<RecordDetail> records,
        IReadOnlyDictionary<string, IReadOnlyList<string>>? masters = null,
        IReadOnlyDictionary<string, bool>? participation = null) =>
        Classifier.Classify(records, masters ?? NoMasters, GameRelease.Fallout4, pluginParticipates: participation);

    private static FieldMetadata Meta(string name, string type = "string") =>
        new(name, type, false, [], []);

    private static FieldValue SortedArrayField(string name, object? value) =>
        new(new FieldMetadata(name, "array", true, [], [],
            ElementType: new FieldMetadata("", "formKey", false, [], [], IsSortable: true)), value);

    private static RecordDetail MakeOverride(string plugin, int loadOrder, bool isWinner,
        params (string name, object? value)[] fields) =>
        new("000001:Test.esp", plugin, loadOrder, isWinner, null,
            [.. fields.Select(f => new FieldValue(Meta(f.name), f.value))], "Data");

    private static RecordDetail MakeOverrideWithOrigin(string plugin, string origin, int loadOrder, bool isWinner,
        params (string name, object? value)[] fields) =>
        new("000001:Test.esp", plugin, loadOrder, isWinner, null,
            [.. fields.Select(f => new FieldValue(Meta(f.name), f.value))], Origin: origin);

    // A Partial Form override — its own fields are excluded from conflict detection
    // regardless of their content (not merely when null, unlike the generic absent-field rule
    // above).
    private static RecordDetail MakePartialFormOverride(string plugin, int loadOrder, bool isWinner,
        params (string name, object? value)[] fields) =>
        new("000001:Test.esp", plugin, loadOrder, isWinner, null,
            [.. fields.Select(f => new FieldValue(Meta(f.name), f.value))], "Data", IsPartialForm: true);

    // --- OnlyOne ---

    [Fact]
    public void Classify_EmptyList_ReturnsOnlyOne()
    {
        var result = Classify([]);
        Assert.Equal(ConflictAll.OnlyOne, result.ConflictAll);
    }

    [Fact]
    public void Classify_SinglePlugin_ReturnsOnlyOne()
    {
        var o = MakeOverride("A.esp", 0, true, ("Name", "Alice"));
        var result = Classify([o]);
        Assert.Equal(ConflictAll.OnlyOne, result.ConflictAll);
        Assert.Equal(ConflictThis.OnlyOne, result.PluginStates["A.esp"]);
    }

    [Fact]
    public void Classify_SinglePlugin_ReturnsAllNonNullFieldsAsDiffs()
    {
        var o = MakeOverride("DLCRobot.esm", 0, true,
            ("Name", "SomeNPC"), ("Level", (object?)10), ("NullField", (object?)null));
        var result = Classify([o]);

        Assert.Equal(ConflictAll.OnlyOne, result.ConflictAll);
        Assert.Contains(result.Diffs, d => d.FieldName == "Name");
        Assert.Contains(result.Diffs, d => d.FieldName == "Level");
        Assert.DoesNotContain(result.Diffs, d => d.FieldName == "NullField");

        var nameDiff = result.Diffs.First(d => d.FieldName == "Name");
        Assert.Equal("SomeNPC", nameDiff.Values["DLCRobot.esm"]);
        Assert.Equal("DLCRobot.esm", nameDiff.WinnerColumn);
        Assert.Equal("SomeNPC", nameDiff.WinnerValue);
    }

    [Fact]
    public void Classify_MultiplePlugins_NoWinnerMarked_Throws()
    {
        var a = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var b = MakeOverride("B.esp", 1, false, ("Name", "Bob"));
        // MakeOverride uses FormKey "000001:Test.esp" — the message must name it, not be a
        // generic or blank string.
        var ex = Assert.Throws<InvalidOperationException>(() => Classify([a, b]));
        Assert.Contains("000001:Test.esp", ex.Message);
    }

    // ADR-0036: two columns sharing a filename, differing in origin. Bare-plugin
    // dictionary keys (o.Plugin) would collide here — ToDictionary throws on the literal duplicate
    // key "Shared.esp".
    [Fact]
    public void Classify_SameFilenameDifferentOrigin_DoesNotCollide()
    {
        var modA = MakeOverrideWithOrigin("Shared.esp", "ModA", 0, false, ("Name", "FromModA"));
        var modB = MakeOverrideWithOrigin("Shared.esp", "ModB", 1, true, ("Name", "FromModB"));

        var result = Classify([modA, modB]);

        Assert.Equal(2, result.PluginStates.Count);
        var nameDiff = Assert.Single(result.Diffs, d => d.FieldName == "Name");
        Assert.Equal("FromModA", nameDiff.Values["Shared.esp|ModA"]);
        Assert.Equal("FromModB", nameDiff.Values["Shared.esp|ModB"]);
    }

    // A change to one column's value must never appear on the other column's diff entry —
    // "action on one never affects the other", exercised at the value level.
    [Fact]
    public void Classify_SameFilenameDifferentOrigin_ActionOnOneDoesNotAffectOther()
    {
        var modA = MakeOverrideWithOrigin("Shared.esp", "ModA", 0, false, ("Name", "Original"));
        var modB = MakeOverrideWithOrigin("Shared.esp", "ModB", 1, true, ("Name", "Original"));
        var baseline = Classify([modA, modB]);
        var baselineDiff = Assert.Single(baseline.Diffs, d => d.FieldName == "Name");
        Assert.Equal(ConflictThis.IdenticalToMaster, baselineDiff.CellStates["Shared.esp|ModB"]);

        // "Edit" only ModA's column.
        var modAEdited = MakeOverrideWithOrigin("Shared.esp", "ModA", 0, false, ("Name", "Edited"));
        var after = Classify([modAEdited, modB]);

        var afterDiff = Assert.Single(after.Diffs, d => d.FieldName == "Name");
        Assert.Equal("Edited", afterDiff.Values["Shared.esp|ModA"]);
        // ModB's own value/state is untouched by the edit to ModA's column.
        Assert.Equal("Original", afterDiff.Values["Shared.esp|ModB"]);
    }

    // --- NoConflict / Override / Conflict ---

    [Fact]
    public void Classify_TwoPlugins_AllFieldsSame_ReturnsNoConflict()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var override1 = MakeOverride("B.esp", 1, true, ("Name", "Alice"));
        var result = Classify([master, override1]);
        Assert.Equal(ConflictAll.NoConflict, result.ConflictAll);
        Assert.Equal(ConflictThis.Master, result.PluginStates["A.esp"]);
        Assert.Equal(ConflictThis.IdenticalToMaster, result.PluginStates["B.esp"]);
    }

    [Fact]
    public void Classify_FourPlugins_OneITM_TwoDisagree_ReturnsConflict()
    {
        // hasAnyChange: Any()=true (B,D change), All()=false (C is ITM) — an All()-based check
        // would wrongly return NoConflict.
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var loser = MakeOverride("B.esp", 1, false, ("Name", "Bob"));
        var itm = MakeOverride("C.esp", 2, false, ("Name", "Alice"));
        var winner = MakeOverride("D.esp", 3, true, ("Name", "Charlie"));
        var result = Classify([master, loser, itm, winner]);
        Assert.Equal(ConflictAll.Conflict, result.ConflictAll);
    }

    [Fact]
    public void Classify_TwoPlugins_OneChangesUniqueField_ReturnsOverride()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"), ("Level", 1));
        var override1 = MakeOverride("B.esp", 1, true, ("Name", "Alice"), ("Level", 5));
        var result = Classify([master, override1]);
        Assert.Equal(ConflictAll.Override, result.ConflictAll);
        Assert.Equal(ConflictThis.Master, result.PluginStates["A.esp"]);
        Assert.Equal(ConflictThis.Override, result.PluginStates["B.esp"]);
    }

    [Fact]
    public void Classify_TwoPlugins_DifferentValues_ReturnsOverride()
    {
        // Only one non-master plugin changes the field — uncontested → Override, not Conflict
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var override1 = MakeOverride("B.esp", 1, true, ("Name", "Bob"));
        var result = Classify([master, override1]);
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
        var result = Classify([master, loser, winner]);
        Assert.Equal(ConflictAll.Conflict, result.ConflictAll);
        Assert.Equal(ConflictThis.ConflictLoses, result.PluginStates["B.esp"]);
        Assert.Equal(ConflictThis.ConflictWins, result.PluginStates["C.esp"]);
    }

    [Fact]
    public void Classify_ThreePlugins_OneFieldConflicts_OtherAgreesOnChange_ReturnsConflict()
    {
        // B and C agree on "Name" but disagree on "Level". hasConflict: Any()=true, All()=false.
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"), ("Level", 1));
        var loser = MakeOverride("B.esp", 1, false, ("Name", "Bob"), ("Level", 5));
        var winner = MakeOverride("C.esp", 2, true, ("Name", "Bob"), ("Level", 10));
        var result = Classify([master, loser, winner]);
        Assert.Equal(ConflictAll.Conflict, result.ConflictAll);
    }

    // --- Participation (ADR-0035) ---

    [Fact]
    public void Classify_OneEnabledOneDisabled_ReturnsOnlyOne_NotConflict()
    {
        var enabled = MakeOverride("A.esp", 0, true, ("Name", "Alice"));
        var disabled = MakeOverride("B.esp", 1, false, ("Name", "Bob"));
        var participation = new Dictionary<string, bool> { ["A.esp"] = true, ["B.esp"] = false };

        var result = Classify([enabled, disabled], participation: participation);

        Assert.Equal(ConflictAll.OnlyOne, result.ConflictAll);
        Assert.Equal(ConflictThis.OnlyOne, result.PluginStates["A.esp"]);
        Assert.DoesNotContain("B.esp", result.PluginStates.Keys);
    }

    [Fact]
    public void Classify_AllDisabled_ReturnsOnlyOne_NoDiffs()
    {
        var a = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var b = MakeOverride("B.esp", 1, false, ("Name", "Bob"));
        var participation = new Dictionary<string, bool> { ["A.esp"] = false, ["B.esp"] = false };

        var result = Classify([a, b], participation: participation);

        Assert.Equal(ConflictAll.OnlyOne, result.ConflictAll);
        Assert.Empty(result.Diffs);
    }

    // ADR-0044: a losing copy of one filename is registered beside the winner and reaches the
    // classifier as a second column with the same name. Keyed by ColumnKey, so the two are distinct
    // and the loser is filtered out first.
    [Fact]
    public void Classify_LosingCopyOfTheSameFilename_IsExcluded_NotAConflictWithTheWinner()
    {
        var winning = MakeOverrideWithOrigin("Shared.esp", "ModA", 3, true, ("Name", "FromModA"));
        var losing = MakeOverrideWithOrigin("Shared.esp", "ModB", 3, false, ("Name", "FromModB"));
        var participation = new Dictionary<string, bool>
        {
            [ColumnKey.Of("Shared.esp", "ModA")] = true,
            [ColumnKey.Of("Shared.esp", "ModB")] = false,
        };

        var result = Classify([winning, losing], participation: participation);

        Assert.Equal(ConflictAll.OnlyOne, result.ConflictAll);
        Assert.Equal(ConflictThis.OnlyOne, result.PluginStates[ColumnKey.Of("Shared.esp", "ModA")]);
        Assert.DoesNotContain(ColumnKey.Of("Shared.esp", "ModB"), result.PluginStates.Keys);
    }

    [Fact]
    public void Classify_NoParticipationSupplied_BehavesAsBefore()
    {
        // Default (null participation) = every plugin participates — legacy call sites unaffected.
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var winner = MakeOverride("B.esp", 1, true, ("Name", "Bob"));
        var result = Classify([master, winner]);
        Assert.Equal(ConflictAll.Override, result.ConflictAll);
    }

    // --- Winner ConflictThis ---

    [Fact]
    public void Classify_WinnerChangesField_OnlyOneContesterAmongMultiple_GetsConflictWins()
    {
        // D=winner changes "Name". B contests (B.name≠D.name). C doesn't contest (C.name=null absent).
        // contested: Any()=true (B contests), All()=false (C doesn't).
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"), ("Level", 1));
        var contester = MakeOverride("B.esp", 1, false, ("Name", "Bob"), ("Level", 1));
        var nonContester = MakeOverride("C.esp", 2, false, ("Name", null), ("Level", 5));
        var winner = MakeOverride("D.esp", 3, true, ("Name", "Dave"), ("Level", 5));
        var result = Classify([master, contester, nonContester, winner]);
        Assert.Equal(ConflictThis.ConflictWins, result.PluginStates["D.esp"]);
    }

    [Fact]
    public void Classify_WinnerChangesLevel_OtherChangesName_WinnerGetsOverride()
    {
        // C changes only "Level"; B changes "Name", which is not in C's changedFields, and B.level equals
        // C.level. With && in the contest check this is Override; an || would wrongly read B.name
        // non-null as contesting.
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"), ("Level", 1));
        var other = MakeOverride("B.esp", 1, false, ("Name", "Bob"), ("Level", 5));
        var winner = MakeOverride("C.esp", 2, true, ("Name", "Alice"), ("Level", 5));
        var result = Classify([master, other, winner]);
        Assert.Equal(ConflictThis.Override, result.PluginStates["C.esp"]);
    }

    // --- Loser ConflictThis ---

    [Fact]
    public void Classify_LoserChangesMultipleFields_OnlyOneLost_GetsConflictLoses()
    {
        // B changes "Name" and "Level". C changes "Name" differently, "Level" same as B.
        // B loses "Name" but not "Level". lost: Any()=true, All()=false.
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"), ("Level", 1));
        var loser = MakeOverride("B.esp", 1, false, ("Name", "Bob"), ("Level", 5));
        var winner = MakeOverride("C.esp", 2, true, ("Name", "Charlie"), ("Level", 5));
        var result = Classify([master, loser, winner]);
        Assert.Equal(ConflictThis.ConflictLoses, result.PluginStates["B.esp"]);
    }

    // --- PartialForm null rule ---

    [Fact]
    public void Classify_NullFieldInNonMaster_TreatedAsAbsent_NotConflictLoses()
    {
        // B.esp has "Name" absent (null) — a PartialForm that doesn't override "Name".
        // C.esp sets "Name" to "Charlie". B.esp should not get ConflictLoses for "Name".
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"), ("Level", 1));
        var partial = MakeOverride("B.esp", 1, false, ("Name", null), ("Level", 5));
        var winner = MakeOverride("C.esp", 2, true, ("Name", "Charlie"), ("Level", 5));
        var result = Classify([master, partial, winner]);
        Assert.NotEqual(ConflictThis.ConflictLoses, result.PluginStates["B.esp"]);
        // Diff for "Name" is included even though B has null (master & C are non-null)
        Assert.Contains(result.Diffs, d => d.FieldName == "Name");
    }

    [Fact]
    public void Classify_NullFieldInNonMaster_DoesNotCountAsConflict()
    {
        // B.esp absent on "Name", C.esp sets "Name" = same as master — no non-master disagreement
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var partial = MakeOverride("B.esp", 1, false, ("Name", null));
        var winner = MakeOverride("C.esp", 2, true, ("Name", "Alice"));
        var result = Classify([master, partial, winner]);
        Assert.NotEqual(ConflictAll.Conflict, result.ConflictAll);
    }

    // --- Per-field WinnerColumn/WinnerValue fallthrough ---
    //
    // A field the record-wide winner never set must not report that winner's null value instead of
    // falling through to whichever plugin actually carries one.

    [Fact]
    public void Classify_RecordWideWinnerHasNullField_WinnerColumnFallsThroughToEarlierPlugin()
    {
        // C.esp is the record-wide winner (IsWinner=true) but never touches "Level" — only "Name".
        // The field's own winner must be A.esp (the only plugin with a "Level" value), not C.esp.
        var master = MakeOverride("A.esp", 0, false, ("Level", 1), ("Name", "Alice"));
        var winner = MakeOverride("C.esp", 1, true, ("Level", null), ("Name", "Bob"));
        var result = Classify([master, winner]);

        var level = result.Diffs.Single(d => d.FieldName == "Level");
        Assert.Equal("A.esp", level.WinnerColumn);
        Assert.Equal(1, level.WinnerValue);
    }

    // --- Partial Form flag rule ---

    [Fact]
    public void Classify_PartialFormOverride_OwnNonNullFieldDiffersFromMaster_StillNoConflict()
    {
        // B.esp is Partial Form and genuinely sets "Level" to a different value than the master —
        // not merely absent (unlike the generic null rule above). Its own field is still excluded.
        var master = MakeOverride("A.esp", 0, false, ("Level", 1));
        var partial = MakePartialFormOverride("B.esp", 1, true, ("Level", 999));
        var result = Classify([master, partial]);

        Assert.Equal(ConflictAll.NoConflict, result.ConflictAll);
    }

    [Fact]
    public void Classify_PartialFormOverride_OwnFieldNeverWinsOrLoses()
    {
        var master = MakeOverride("A.esp", 0, false, ("Level", 1));
        var partial = MakePartialFormOverride("B.esp", 1, false, ("Level", 999));
        var winner = MakeOverride("C.esp", 2, true, ("Level", 5));
        var result = Classify([master, partial, winner]);

        Assert.DoesNotContain(result.Diffs, d => d.CellStates.ContainsKey("B.esp"));
    }

    // --- JsonElement comparison (ValuesEqual branch) ---

    [Fact]
    public void Classify_TwoPlugins_JsonElementFields_EqualValues_ReturnsNoConflict()
    {
        // JsonElement fields come from DuckDbRecordIndex (array/struct fields).
        // ValuesEqual must compare by raw text, not reference equality.
        var arrayA = JsonSerializer.Deserialize<JsonElement>("[1,2,3]");
        var arrayB = JsonSerializer.Deserialize<JsonElement>("[1,2,3]");
        var master = MakeOverride("A.esp", 0, false, ("Keywords", (object?)arrayA));
        var override1 = MakeOverride("B.esp", 1, true, ("Keywords", (object?)arrayB));
        var result = Classify([master, override1]);
        Assert.Equal(ConflictAll.NoConflict, result.ConflictAll);
    }

    [Fact]
    public void Classify_TwoPlugins_JsonElementFields_DifferentValues_ReturnsOverride()
    {
        var arrayA = JsonSerializer.Deserialize<JsonElement>("[1,2,3]");
        var arrayB = JsonSerializer.Deserialize<JsonElement>("[4,5,6]");
        var master = MakeOverride("A.esp", 0, false, ("Keywords", (object?)arrayA));
        var override1 = MakeOverride("B.esp", 1, true, ("Keywords", (object?)arrayB));
        var result = Classify([master, override1]);
        Assert.Equal(ConflictAll.Override, result.ConflictAll);
    }

    [Fact]
    public void Classify_PluginMissingFieldEntirely_TreatedAsNull()
    {
        // B.esp's Fields list doesn't include "Name" at all (not just null — absent from list).
        var master = new RecordDetail("000001:Test.esp", "A.esp", 0, false, null,
            [new FieldValue(Meta("Name"), "Alice"), new FieldValue(Meta("Level"), 1)], Origin: "Data");
        var partial = new RecordDetail("000001:Test.esp", "B.esp", 1, true, null,
            [new FieldValue(Meta("Level"), 5)], Origin: "Data");
        var result = Classify([master, partial]);
        Assert.Equal(ConflictAll.Override, result.ConflictAll);
        Assert.Equal(ConflictThis.Override, result.PluginStates["B.esp"]);
    }

    // --- Injected record detection ---

    [Fact]
    public void Classify_InjectedRecord_ReturnsConflictCritical()
    {
        // FormKey origin is "Origin.esm" but B.esp's masters don't include it → injected
        var master = new RecordDetail("000001:Origin.esm", "A.esm", 0, false, null,
            [new FieldValue(Meta("Name"), "Alice")], Origin: "Data");
        var override1 = new RecordDetail("000001:Origin.esm", "B.esp", 1, true, null,
            [new FieldValue(Meta("Name"), "Bob")], Origin: "Data");
        var masters = new Dictionary<string, IReadOnlyList<string>>
        {
            ["A.esm"] = ["Origin.esm"],
            ["B.esp"] = ["SomeOther.esm"],  // Origin.esm NOT in masters → injected
        };
        var result = Classify([master, override1], masters: masters);
        Assert.Equal(ConflictAll.ConflictCritical, result.ConflictAll);
    }

    [Fact]
    public void Classify_PartialInjection_OnlyOneOverrideMissingOrigin_ReturnsConflictCritical()
    {
        // B.esp has originPlugin in masters (not injected), C.esp doesn't (injected).
        // Any()=true (C.esp injected), All()=false (B.esp is not) — one injected override suffices.
        var master = new RecordDetail("000001:Origin.esm", "Origin.esm", 0, false, null,
            [new FieldValue(Meta("Name"), "Alice")], Origin: "Data");
        var override1 = new RecordDetail("000001:Origin.esm", "B.esp", 1, false, null,
            [new FieldValue(Meta("Name"), "Bob")], Origin: "Data");
        var override2 = new RecordDetail("000001:Origin.esm", "C.esp", 2, true, null,
            [new FieldValue(Meta("Name"), "Charlie")], Origin: "Data");
        var masters = new Dictionary<string, IReadOnlyList<string>>
        {
            ["Origin.esm"] = [],
            ["B.esp"] = ["Origin.esm"],      // has origin → not injected
            ["C.esp"] = ["SomeOther.esm"],   // missing origin → injected
        };
        var result = Classify([master, override1, override2], masters: masters);
        Assert.Equal(ConflictAll.ConflictCritical, result.ConflictAll);
    }

    [Fact]
    public void Classify_InvalidFormKey_TreatedAsNotInjected()
    {
        // FormKey.TryFactory fails for "INVALID" → IsInjectedRecord returns false (defensive guard).
        var master = new RecordDetail("INVALID", "A.esm", 0, false, null,
            [new FieldValue(Meta("Name"), "Alice")], Origin: "Data");
        var override1 = new RecordDetail("INVALID", "B.esp", 1, true, null,
            [new FieldValue(Meta("Name"), "Bob")], Origin: "Data");
        var masters = new Dictionary<string, IReadOnlyList<string>>
        {
            ["A.esm"] = [],
            ["B.esp"] = ["SomeOther.esm"],  // would be injected if FormKey were valid
        };
        var result = Classify([master, override1], masters: masters);
        Assert.NotEqual(ConflictAll.ConflictCritical, result.ConflictAll);
    }

    [Fact]
    public void Classify_InjectedRecord_ContentIdentical_DoesNotBumpToCritical()
    {
        // B.esp is injected (origin missing from its masters) but its value matches the master
        // exactly — xEdit only escalates injected records to caConflictCritical when a real value
        // difference exists (xeMainForm.pas ConflictLevelForNodeDatas); content-identical stays NoConflict.
        var master = new RecordDetail("000001:Origin.esm", "A.esm", 0, false, null,
            [new FieldValue(Meta("Name"), "Alice")], Origin: "Data");
        var override1 = new RecordDetail("000001:Origin.esm", "B.esp", 1, true, null,
            [new FieldValue(Meta("Name"), "Alice")], Origin: "Data");
        var masters = new Dictionary<string, IReadOnlyList<string>>
        {
            ["A.esm"] = ["Origin.esm"],
            ["B.esp"] = ["SomeOther.esm"],  // Origin.esm NOT in masters → injected
        };
        var result = Classify([master, override1], masters: masters);
        Assert.Equal(ConflictAll.NoConflict, result.ConflictAll);
    }

    [Fact]
    public void Classify_NonInjectedRecord_DoesNotBumpToCritical()
    {
        var master = new RecordDetail("000001:Origin.esm", "A.esm", 0, false, null,
            [new FieldValue(Meta("Name"), "Alice")], Origin: "Data");
        var override1 = new RecordDetail("000001:Origin.esm", "B.esp", 1, true, null,
            [new FieldValue(Meta("Name"), "Bob")], Origin: "Data");
        var masters = new Dictionary<string, IReadOnlyList<string>>
        {
            ["A.esm"] = ["Origin.esm"],
            ["B.esp"] = ["A.esm", "Origin.esm"],  // Origin.esm IS in masters → not injected
        };
        var result = Classify([master, override1], masters: masters);
        Assert.NotEqual(ConflictAll.ConflictCritical, result.ConflictAll);
    }

    // --- Sorted array comparison ---

    [Fact]
    public void Classify_SortedArraySameElementsDifferentOrder_ReturnsNoConflict()
    {
        var arrayA = JsonSerializer.Deserialize<JsonElement>("[\"a\",\"b\",\"c\"]");
        var arrayB = JsonSerializer.Deserialize<JsonElement>("[\"c\",\"a\",\"b\"]");
        var master = new RecordDetail("000001:Test.esp", "A.esp", 0, false, null,
            [SortedArrayField("scriptProperties", (object?)arrayA)], Origin: "Data");
        var override1 = new RecordDetail("000001:Test.esp", "B.esp", 1, true, null,
            [SortedArrayField("scriptProperties", (object?)arrayB)], Origin: "Data");
        var result = Classify([master, override1]);
        Assert.Equal(ConflictAll.NoConflict, result.ConflictAll);
    }

    [Fact]
    public void Classify_SortedArrayDifferentLengths_ReturnsOverride()
    {
        // Length check: [a] vs [a,b] differ in count → not equal → Override.
        var arrayA = JsonSerializer.Deserialize<JsonElement>("[\"a\"]");
        var arrayB = JsonSerializer.Deserialize<JsonElement>("[\"a\",\"b\"]");
        var master = new RecordDetail("000001:Test.esp", "A.esp", 0, false, null,
            [SortedArrayField("scriptProperties", (object?)arrayA)], Origin: "Data");
        var override1 = new RecordDetail("000001:Test.esp", "B.esp", 1, true, null,
            [SortedArrayField("scriptProperties", (object?)arrayB)], Origin: "Data");
        var result = Classify([master, override1]);
        Assert.Equal(ConflictAll.Override, result.ConflictAll);
    }

    [Fact]
    public void Classify_SortedArrayDifferentElements_ReturnsOverride()
    {
        var arrayA = JsonSerializer.Deserialize<JsonElement>("[\"a\",\"b\"]");
        var arrayB = JsonSerializer.Deserialize<JsonElement>("[\"a\",\"c\"]");
        var master = new RecordDetail("000001:Test.esp", "A.esp", 0, false, null,
            [SortedArrayField("scriptProperties", (object?)arrayA)], Origin: "Data");
        var override1 = new RecordDetail("000001:Test.esp", "B.esp", 1, true, null,
            [SortedArrayField("scriptProperties", (object?)arrayB)], Origin: "Data");
        var result = Classify([master, override1]);
        Assert.Equal(ConflictAll.Override, result.ConflictAll);
    }

    [Fact]
    public void Classify_UnsortedArraySameElementsDifferentOrder_ReturnsOverride()
    {
        // isSortedArray=false: [1,2] vs [2,1] differ by raw JSON text → Override, not NoConflict.
        // An || instead of && in ValuesEqual would sort-compare them and return NoConflict.
        var arrayA = JsonSerializer.Deserialize<JsonElement>("[1,2]");
        var arrayB = JsonSerializer.Deserialize<JsonElement>("[2,1]");
        var master = MakeOverride("A.esp", 0, false, ("Keywords", (object?)arrayA));
        var override1 = MakeOverride("B.esp", 1, true, ("Keywords", (object?)arrayB));
        var result = Classify([master, override1]);
        Assert.Equal(ConflictAll.Override, result.ConflictAll);
    }

    // --- CellStates per-field ---

    [Fact]
    public void Classify_TwoPlugins_NonMasterMatchesMaster_CellStateIsIdenticalToMaster()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var override1 = MakeOverride("B.esp", 1, true, ("Name", "Alice"));
        var result = Classify([master, override1]);
        var nameDiff = result.Diffs.First(d => d.FieldName == "Name");
        Assert.Equal(ConflictThis.IdenticalToMaster, nameDiff.CellStates["B.esp"]);
        Assert.False(nameDiff.CellStates.ContainsKey("A.esp")); // master omitted
    }

    [Fact]
    public void Classify_TwoPlugins_NonMasterChangesFieldUncontestedly_CellStateIsOverride()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var override1 = MakeOverride("B.esp", 1, true, ("Name", "Bob"));
        var result = Classify([master, override1]);
        var nameDiff = result.Diffs.First(d => d.FieldName == "Name");
        Assert.Equal(ConflictThis.Override, nameDiff.CellStates["B.esp"]);
        Assert.False(nameDiff.CellStates.ContainsKey("A.esp")); // master omitted
    }

    [Fact]
    public void Classify_ThreePlugins_TwoDisagreeOnField_WinnerGetsConflictWins_LoserGetsConflictLoses()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var loser = MakeOverride("B.esp", 1, false, ("Name", "Bob"));
        var winner = MakeOverride("C.esp", 2, true, ("Name", "Charlie"));
        var result = Classify([master, loser, winner]);
        var nameDiff = result.Diffs.First(d => d.FieldName == "Name");
        Assert.Equal(ConflictThis.ConflictWins, nameDiff.CellStates["C.esp"]);
        Assert.Equal(ConflictThis.ConflictLoses, nameDiff.CellStates["B.esp"]);
        Assert.False(nameDiff.CellStates.ContainsKey("A.esp")); // master omitted
    }

    [Fact]
    public void Classify_FieldWinnerDiffersFromRecordWinner_FieldWinnerGetsOverride()
    {
        // Record winner (C.esp) has null for "Name"; B.esp (mid-stack) set it → B is field winner for "Name".
        // No other non-master has a different non-null value → B gets Override (not ConflictLoses).
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var fieldWinner = MakeOverride("B.esp", 1, false, ("Name", "Bob"));
        var recordWinner = MakeOverride("C.esp", 2, true, ("Name", null));
        var result = Classify([master, fieldWinner, recordWinner]);
        var nameDiff = result.Diffs.First(d => d.FieldName == "Name");
        Assert.Equal(ConflictThis.Override, nameDiff.CellStates["B.esp"]);
        Assert.False(nameDiff.CellStates.ContainsKey("C.esp")); // null → omitted
    }

    [Fact]
    public void Classify_NonWinnerMatchesFieldWinner_CellStateIsOverride()
    {
        // B.esp and C.esp both set "Name" to "Bob". C.esp (load 2) is field winner.
        // B.esp is not the field winner; !ValuesEqual("Bob","Bob") = false → Override, not ConflictLoses.
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var nonWinner = MakeOverride("B.esp", 1, false, ("Name", "Bob"));
        var winner = MakeOverride("C.esp", 2, true, ("Name", "Bob"));
        var result = Classify([master, nonWinner, winner]);
        var nameDiff = result.Diffs.First(d => d.FieldName == "Name");
        Assert.Equal(ConflictThis.Override, nameDiff.CellStates["B.esp"]);
    }

    [Fact]
    public void Classify_NullValueInNonMaster_OmittedFromCellStates()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var partial = MakeOverride("B.esp", 1, false, ("Name", null));
        var winner = MakeOverride("C.esp", 2, true, ("Name", "Charlie"));
        var result = Classify([master, partial, winner]);
        var nameDiff = result.Diffs.First(d => d.FieldName == "Name");
        Assert.False(nameDiff.CellStates.ContainsKey("B.esp")); // null → omitted
        Assert.True(nameDiff.CellStates.ContainsKey("C.esp"));
    }

    // --- Per-node ConflictAll (bottom-up, scoped to one FieldDiff's own subtree — distinct
    // from ClassifyResult.ConflictAll, the record-wide value the Plugins-tree badge still uses) ---

    [Fact]
    public void Classify_LeafField_AllPluginsAgree_ConflictAllIsNoConflict()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var override1 = MakeOverride("B.esp", 1, true, ("Name", "Alice"));
        var result = Classify([master, override1]);
        var nameDiff = result.Diffs.First(d => d.FieldName == "Name");
        Assert.Equal(ConflictAll.NoConflict, nameDiff.ConflictAll);
    }

    [Fact]
    public void Classify_LeafField_UncontestedOverride_ConflictAllIsOverride()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var override1 = MakeOverride("B.esp", 1, true, ("Name", "Bob"));
        var result = Classify([master, override1]);
        var nameDiff = result.Diffs.First(d => d.FieldName == "Name");
        Assert.Equal(ConflictAll.Override, nameDiff.ConflictAll);
    }

    [Fact]
    public void Classify_LeafField_ContestedWinLose_ConflictAllIsConflict()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"));
        var loser = MakeOverride("B.esp", 1, false, ("Name", "Bob"));
        var winner = MakeOverride("C.esp", 2, true, ("Name", "Charlie"));
        var result = Classify([master, loser, winner]);
        var nameDiff = result.Diffs.First(d => d.FieldName == "Name");
        Assert.Equal(ConflictAll.Conflict, nameDiff.ConflictAll);
    }

    // The literal regression guard: a naive implementation that stamped the record-wide
    // ConflictAll onto every FieldDiff would make "Level" (which every plugin agrees on) read
    // Override, same as "Name" — this proves the two sibling rows carry independent values.
    [Fact]
    public void Classify_TwoSiblingFields_OnlyOneDiffers_OnlyThatFieldsConflictAllIsNonNoConflict()
    {
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"), ("Level", 5));
        var override1 = MakeOverride("B.esp", 1, true, ("Name", "Bob"), ("Level", 5));
        var result = Classify([master, override1]);

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

        var result = Classify([master, override1]);

        var boundsDiff = result.Diffs.First(d => d.FieldName == "Bounds");
        var xChild = boundsDiff.Children!.First(c => c.FieldName == "X");
        var yChild = boundsDiff.Children!.First(c => c.FieldName == "Y");

        Assert.Equal(ConflictAll.Override, xChild.ConflictAll);
        Assert.Equal(ConflictAll.NoConflict, yChild.ConflictAll);
        // The struct row itself aggregates the worst state found anywhere in its subtree.
        Assert.Equal(ConflictAll.Override, boundsDiff.ConflictAll);
    }

    [Fact]
    public void Classify_NestedStructInsideArrayElement_GrandchildConflictAggregatesTwoLevelsUp()
    {
        // Array field "Items" of struct elements, each struct carrying a sub-struct "Pos" with
        // field "X" — proves aggregation recurses through more than one level (array -> struct
        // element -> nested struct -> leaf), not just a single hop.
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

        var result = Classify([master, override1]);

        var itemsDiff = result.Diffs.First(d => d.FieldName == "Items");
        var elementDiff = itemsDiff.Children!.First(c => c.FieldName == "[0]");
        var posDiff = elementDiff.Children!.First(c => c.FieldName == "Pos");
        var xDiff = posDiff.Children!.First(c => c.FieldName == "X");

        Assert.Equal(ConflictAll.Override, xDiff.ConflictAll);
        Assert.Equal(ConflictAll.Override, posDiff.ConflictAll);
        Assert.Equal(ConflictAll.Override, elementDiff.ConflictAll);
        Assert.Equal(ConflictAll.Override, itemsDiff.ConflictAll);
    }

    [Fact]
    public void Classify_PerNodeConflictAll_DoesNotChangeRecordWideConflictAll()
    {
        // The record-wide ClassifyResult.ConflictAll (Plugins-tree badge) is a different,
        // legitimate use of the same concept at record scope and must stay untouched by this.
        var master = MakeOverride("A.esp", 0, false, ("Name", "Alice"), ("Level", 5));
        var override1 = MakeOverride("B.esp", 1, true, ("Name", "Bob"), ("Level", 5));
        var result = Classify([master, override1]);
        Assert.Equal(ConflictAll.Override, result.ConflictAll);
    }

    // --- Struct Children ---

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
        var result = Classify([master, override1]);
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

        var result = Classify([master, override1]);

        var boundsDiff = result.Diffs.First(d => d.FieldName == "Bounds");
        Assert.NotNull(boundsDiff.Children);

        var xChild = boundsDiff.Children!.FirstOrDefault(c => c.FieldName == "X");
        Assert.NotNull(xChild);
        Assert.True(xChild!.CellStates.ContainsKey("B.esp"));
        Assert.Equal(ConflictThis.Override, xChild.CellStates["B.esp"]);

        var yChild = boundsDiff.Children!.FirstOrDefault(c => c.FieldName == "Y");
        Assert.NotNull(yChild);
        Assert.True(yChild!.CellStates.ContainsKey("B.esp"));
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

        var result = Classify([master, override1]);

        var boundsDiff = result.Diffs.First(d => d.FieldName == "Bounds");
        Assert.NotNull(boundsDiff.Children);
        Assert.All(boundsDiff.Children!, child =>
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

        var result = Classify([master, loser, winner]);

        var posDiff = result.Diffs.First(d => d.FieldName == "Pos");
        Assert.NotNull(posDiff.Children);

        var xChild = posDiff.Children!.First(c => c.FieldName == "X");
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

        // C.esp is the winner but doesn't have "Pos" at all
        var master = MakeStructOverride("A.esp", 0, false, structMeta, masterVal);
        var override1 = MakeStructOverride("B.esp", 1, false, structMeta, overrideVal);
        var winnerWithoutField = new RecordDetail("000001:Test.esp", "C.esp", 2, true, null, [], Origin: "Data");

        var result = Classify([master, override1, winnerWithoutField]);

        var posDiff = result.Diffs.FirstOrDefault(d => d.FieldName == "Pos");
        Assert.NotNull(posDiff);
        Assert.NotNull(posDiff!.Children);
        Assert.Contains(posDiff.Children!, c => c.FieldName == "X");
    }

    [Fact]
    public void Classify_StructField_SubFieldAbsentInOnePlugin_ThatPluginOmittedFromChildCellStates()
    {
        var subX = Meta("X", "int");
        var subY = Meta("Y", "int");
        var structMeta = StructMeta("Bounds", subX, subY);

        // B.esp has no Y in its struct
        var masterVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 10, \"Y\": 20}");
        var overrideVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 15}");

        var master = MakeStructOverride("A.esp", 0, false, structMeta, masterVal);
        var override1 = MakeStructOverride("B.esp", 1, true, structMeta, overrideVal);

        var result = Classify([master, override1]);

        var boundsDiff = result.Diffs.First(d => d.FieldName == "Bounds");
        Assert.NotNull(boundsDiff.Children);

        var yChild = boundsDiff.Children!.FirstOrDefault(c => c.FieldName == "Y");
        Assert.NotNull(yChild);
        Assert.False(yChild!.CellStates.ContainsKey("B.esp")); // absent → omitted
    }

    [Fact]
    public void Classify_StructField_ArraySubFieldIncluded_ProducesChildRows()
    {
        // The depth guard is gone: array sub-fields inside structs are now recursed into.
        var subX = Meta("X", "int");
        var subYArray = new FieldMetadata("Y", "array", true, [], [],
            ElementType: new FieldMetadata("", "int", false, [], []));
        var structMeta = new FieldMetadata("Bounds", "struct", false, [], [], Fields: [subX, subYArray]);

        var masterVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 10, \"Y\": [1,2]}");
        var overrideVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 15, \"Y\": [3,4]}");

        var master = MakeStructOverride("A.esp", 0, false, structMeta, masterVal);
        var override1 = MakeStructOverride("B.esp", 1, true, structMeta, overrideVal);

        var result = Classify([master, override1]);

        var boundsDiff = result.Diffs.First(d => d.FieldName == "Bounds");
        Assert.NotNull(boundsDiff.Children);
        Assert.Contains(boundsDiff.Children!, c => c.FieldName == "X");

        // Y is now recursed into, not skipped — its elements become sub-children
        var yChild = boundsDiff.Children!.FirstOrDefault(c => c.FieldName == "Y");
        Assert.NotNull(yChild);
        Assert.NotNull(yChild!.Children);
        Assert.Equal(2, yChild.Children!.Count);
    }

    [Fact]
    public void Classify_StructField_SubFieldWinnerIsHighestLoadOrder()
    {
        // WinnerColumn must be the highest load-order plugin with a value (MaxBy, not MinBy).
        var subX = Meta("X", "int");
        var structMeta = StructMeta("Pos", subX);

        var masterVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 0}");
        var overrideVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 5}");

        var master = MakeStructOverride("A.esp", 0, false, structMeta, masterVal);
        var override1 = MakeStructOverride("B.esp", 1, true, structMeta, overrideVal);

        var result = Classify([master, override1]);

        var xChild = result.Diffs.First(d => d.FieldName == "Pos").Children!.First(c => c.FieldName == "X");
        Assert.Equal("B.esp", xChild.WinnerColumn);
        Assert.Equal(5, ((System.Text.Json.JsonElement)xChild.WinnerValue!).GetInt32());
    }

    [Fact]
    public void Classify_StructField_JsonNullSubField_TreatedAsAbsent()
    {
        // ExtractSubFieldValue: JSON null must map to null, not a JsonElement.
        var subX = Meta("X", "int");
        var subY = Meta("Y", "int");
        var structMeta = StructMeta("Bounds", subX, subY);

        var masterVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 10, \"Y\": 20}");
        var overrideVal = JsonSerializer.Deserialize<JsonElement>("{\"X\": 15, \"Y\": null}");

        var master = MakeStructOverride("A.esp", 0, false, structMeta, masterVal);
        var override1 = MakeStructOverride("B.esp", 1, true, structMeta, overrideVal);

        var result = Classify([master, override1]);

        var yChild = result.Diffs.First(d => d.FieldName == "Bounds").Children!.FirstOrDefault(c => c.FieldName == "Y");
        Assert.NotNull(yChild);
        Assert.False(yChild!.CellStates.ContainsKey("B.esp")); // JSON null → treated as absent
    }

    // --- Resolutions (ADR-0031) ---

    [Fact]
    public void Classify_ScalarFormKeyField_PopulatesResolutionPerPlugin()
    {
        var meta = new FieldMetadata("Race", "formKey", false, ["Race"], []);
        var master = new RecordDetail("000001:Test.esp", "A.esp", 0, false, null,
            [new FieldValue(meta, "000AAA:Test.esp")], Origin: "Data");
        var override1 = new RecordDetail("000001:Test.esp", "B.esp", 1, true, null,
            [new FieldValue(meta, "000BBB:Test.esp")], Origin: "Data");

        static MEditService.Core.Records.RecordLookupEntry? Resolve(string fk) =>
            fk == "000AAA:Test.esp" ? new MEditService.Core.Records.RecordLookupEntry("Race", "GoodRace") : null;

        var result = Classifier.Classify([master, override1], NoMasters, GameRelease.Fallout4, Resolve);

        var diff = result.Diffs.First(d => d.FieldName == "Race");
        Assert.NotNull(diff.Resolutions);
        Assert.Equal(MEditService.Core.Records.FormKeyResolutionState.ResolvedValidType, diff.Resolutions!["A.esp"].State);
        Assert.Equal("GoodRace", diff.Resolutions["A.esp"].EditorId);
        Assert.Equal(MEditService.Core.Records.FormKeyResolutionState.Unresolved, diff.Resolutions["B.esp"].State);
    }

    [Fact]
    public void Classify_SortedArrayOfFormKey_SiblingLeavesResolveIndependently_ParentCarriesNoResolutions()
    {
        // kw1 resolves, kw2 is dangling — the regression this replaces would let kw2's missing
        // resolution suppress kw1's (or vice versa) by aggregating to the array field's own state.
        var arrayA = JsonSerializer.Deserialize<JsonElement>("[\"000AAA:Test.esp\",\"000BBB:Test.esp\"]");
        var master = new RecordDetail("000001:Test.esp", "A.esp", 0, true, null,
            [SortedArrayField("Keywords", (object?)arrayA)], Origin: "Data");

        static MEditService.Core.Records.RecordLookupEntry? Resolve(string fk) =>
            fk == "000AAA:Test.esp" ? new MEditService.Core.Records.RecordLookupEntry("kywd", "GoodKeyword") : null;

        var result = Classifier.Classify([master], NoMasters, GameRelease.Fallout4, Resolve);

        var arrayDiff = result.Diffs.First(d => d.FieldName == "Keywords");
        Assert.Null(arrayDiff.Resolutions); // no aggregation onto the parent array field

        var kw1 = arrayDiff.Children!.First(c => c.WinnerValue is JsonElement je && je.GetString() == "000AAA:Test.esp");
        var kw2 = arrayDiff.Children!.First(c => c.WinnerValue is JsonElement je && je.GetString() == "000BBB:Test.esp");

        Assert.Equal(MEditService.Core.Records.FormKeyResolutionState.ResolvedValidType, kw1.Resolutions!["A.esp"].State);
        Assert.Equal(MEditService.Core.Records.FormKeyResolutionState.Unresolved, kw2.Resolutions!["A.esp"].State);
    }

    [Fact]
    public void Classify_StructFormKeySubField_ResolvesIndependentlyOfSiblingStructField()
    {
        var factionField = new FieldMetadata("Faction", "formKey", false, ["fact"], []);
        var rankField = Meta("Rank", "int");
        var structMeta = StructMeta("Factions", factionField, rankField);

        var val = JsonSerializer.Deserialize<JsonElement>("""{"Faction":"000FFF:Test.esp","Rank":1}""");
        var master = MakeStructOverride("A.esp", 0, true, structMeta, val);

        // dangling: every FormKey is unresolved
        var result = Classifier.Classify([master], NoMasters, GameRelease.Fallout4, _ => null);

        var factionChild = result.Diffs.First(d => d.FieldName == "Factions").Children!.First(c => c.FieldName == "Faction");
        var rankChild = result.Diffs.First(d => d.FieldName == "Factions").Children!.First(c => c.FieldName == "Rank");

        Assert.Equal(MEditService.Core.Records.FormKeyResolutionState.Unresolved, factionChild.Resolutions!["A.esp"].State);
        Assert.Null(rankChild.Resolutions); // non-formKey sibling never gets a Resolutions entry
    }

    [Fact]
    public void Classify_NoResolverPassed_ResolutionsStayNull()
    {
        var meta = new FieldMetadata("Race", "formKey", false, ["Race"], []);
        var master = new RecordDetail("000001:Test.esp", "A.esp", 0, true, null,
            [new FieldValue(meta, "000AAA:Test.esp")], Origin: "Data");

        var result = Classify([master]);

        Assert.Null(result.Diffs.First(d => d.FieldName == "Race").Resolutions);
    }
}
