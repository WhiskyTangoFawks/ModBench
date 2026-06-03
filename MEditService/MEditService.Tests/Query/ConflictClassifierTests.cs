using MEditService.Core.Queries;

namespace MEditService.Tests.Query;

public class ConflictClassifierTests
{
    private readonly IConflictClassifier _svc = new ConflictClassifier();

    private static FieldMetadata Meta(string name, string type = "string") =>
        new(name, type, false, [], []);

    private static RecordDetail MakeOverride(string plugin, int loadOrder, bool isWinner,
        params (string name, object? value)[] fields) =>
        new("000001:Test.esp", plugin, loadOrder, isWinner, null,
            fields.Select(f => new FieldValue(Meta(f.name), f.value)).ToList());

    // --- OnlyOne ---

    [Fact]
    public void Classify_EmptyList_ReturnsOnlyOne()
    {
        var result = _svc.Classify([]);
        Assert.Equal(ConflictAll.OnlyOne, result.ConflictAll);
    }

    [Fact]
    public void Classify_SinglePlugin_ReturnsOnlyOne()
    {
        var o = MakeOverride("A.esp", 0, true, ("name", "Alice"));
        var result = _svc.Classify([o]);
        Assert.Equal(ConflictAll.OnlyOne, result.ConflictAll);
        Assert.Equal(ConflictThis.OnlyOne, result.PluginStates["A.esp"]);
    }

    [Fact]
    public void Classify_MultiplePlugins_NoWinnerMarked_Throws()
    {
        var a = MakeOverride("A.esp", 0, false, ("name", "Alice"));
        var b = MakeOverride("B.esp", 1, false, ("name", "Bob"));
        Assert.Throws<InvalidOperationException>(() => _svc.Classify([a, b]));
    }

    // --- NoConflict / Override / Conflict ---

    [Fact]
    public void Classify_TwoPlugins_AllFieldsSame_ReturnsNoConflict()
    {
        var master = MakeOverride("A.esp", 0, false, ("name", "Alice"));
        var override1 = MakeOverride("B.esp", 1, true, ("name", "Alice"));
        var result = _svc.Classify([master, override1]);
        Assert.Equal(ConflictAll.NoConflict, result.ConflictAll);
        Assert.Equal(ConflictThis.Master, result.PluginStates["A.esp"]);
        Assert.Equal(ConflictThis.IdenticalToMaster, result.PluginStates["B.esp"]);
    }

    [Fact]
    public void Classify_FourPlugins_OneITM_TwoDisagree_ReturnsConflict()
    {
        // hasAnyChange: Any()=true (B,D change), All()=false (C is ITM) — mutant returns NoConflict.
        var master = MakeOverride("A.esp", 0, false, ("name", "Alice"));
        var loser = MakeOverride("B.esp", 1, false, ("name", "Bob"));
        var itm = MakeOverride("C.esp", 2, false, ("name", "Alice"));
        var winner = MakeOverride("D.esp", 3, true, ("name", "Charlie"));
        var result = _svc.Classify([master, loser, itm, winner]);
        Assert.Equal(ConflictAll.Conflict, result.ConflictAll);
    }

    [Fact]
    public void Classify_TwoPlugins_OneChangesUniqueField_ReturnsOverride()
    {
        var master = MakeOverride("A.esp", 0, false, ("name", "Alice"), ("level", 1));
        var override1 = MakeOverride("B.esp", 1, true, ("name", "Alice"), ("level", 5));
        var result = _svc.Classify([master, override1]);
        Assert.Equal(ConflictAll.Override, result.ConflictAll);
        Assert.Equal(ConflictThis.Master, result.PluginStates["A.esp"]);
        Assert.Equal(ConflictThis.Override, result.PluginStates["B.esp"]);
    }

    [Fact]
    public void Classify_TwoPlugins_DifferentValues_ReturnsOverride()
    {
        // Only one non-master plugin changes the field — uncontested → Override, not Conflict
        var master = MakeOverride("A.esp", 0, false, ("name", "Alice"));
        var override1 = MakeOverride("B.esp", 1, true, ("name", "Bob"));
        var result = _svc.Classify([master, override1]);
        Assert.Equal(ConflictAll.Override, result.ConflictAll);
        Assert.Equal(ConflictThis.Master, result.PluginStates["A.esp"]);
        Assert.Equal(ConflictThis.Override, result.PluginStates["B.esp"]);
    }

    [Fact]
    public void Classify_ThreePlugins_TwoNonMastersDisagree_ReturnsConflict()
    {
        var master = MakeOverride("A.esp", 0, false, ("name", "Alice"));
        var loser = MakeOverride("B.esp", 1, false, ("name", "Bob"));
        var winner = MakeOverride("C.esp", 2, true, ("name", "Charlie"));
        var result = _svc.Classify([master, loser, winner]);
        Assert.Equal(ConflictAll.Conflict, result.ConflictAll);
        Assert.Equal(ConflictThis.ConflictLoses, result.PluginStates["B.esp"]);
        Assert.Equal(ConflictThis.ConflictWins, result.PluginStates["C.esp"]);
    }

    [Fact]
    public void Classify_ThreePlugins_OneFieldConflicts_OtherAgreesOnChange_ReturnsConflict()
    {
        // B and C agree on "name" but disagree on "level". hasConflict: Any()=true, All()=false.
        var master = MakeOverride("A.esp", 0, false, ("name", "Alice"), ("level", 1));
        var loser = MakeOverride("B.esp", 1, false, ("name", "Bob"), ("level", 5));
        var winner = MakeOverride("C.esp", 2, true, ("name", "Bob"), ("level", 10));
        var result = _svc.Classify([master, loser, winner]);
        Assert.Equal(ConflictAll.Conflict, result.ConflictAll);
    }

    // --- Winner ConflictThis ---

    [Fact]
    public void Classify_WinnerChangesField_OnlyOneContesterAmongMultiple_GetsConflictWins()
    {
        // D=winner changes "name". B contests (B.name≠D.name). C doesn't contest (C.name=null absent).
        // contested: Any()=true (B contests), All()=false (C doesn't).
        var master = MakeOverride("A.esp", 0, false, ("name", "Alice"), ("level", 1));
        var contester = MakeOverride("B.esp", 1, false, ("name", "Bob"), ("level", 1));
        var nonContester = MakeOverride("C.esp", 2, false, ("name", null), ("level", 5));
        var winner = MakeOverride("D.esp", 3, true, ("name", "Dave"), ("level", 5));
        var result = _svc.Classify([master, contester, nonContester, winner]);
        Assert.Equal(ConflictThis.ConflictWins, result.PluginStates["D.esp"]);
    }

    [Fact]
    public void Classify_WinnerChangesLevel_OtherChangesName_WinnerGetsOverride()
    {
        // C (winner) changes only "level". B changes "name" (not in C's changedFields).
        // B.level=5=C.level → B doesn't contest level. B.name not in C's changedFields.
        // With && original: not contested → Override. With || mutant: B.name non-null → contested.
        var master = MakeOverride("A.esp", 0, false, ("name", "Alice"), ("level", 1));
        var other = MakeOverride("B.esp", 1, false, ("name", "Bob"), ("level", 5));
        var winner = MakeOverride("C.esp", 2, true, ("name", "Alice"), ("level", 5));
        var result = _svc.Classify([master, other, winner]);
        Assert.Equal(ConflictThis.Override, result.PluginStates["C.esp"]);
    }

    // --- Loser ConflictThis ---

    [Fact]
    public void Classify_LoserChangesMultipleFields_OnlyOneLost_GetsConflictLoses()
    {
        // B changes "name" and "level". C changes "name" differently, "level" same as B.
        // B loses "name" but not "level". lost: Any()=true, All()=false.
        var master = MakeOverride("A.esp", 0, false, ("name", "Alice"), ("level", 1));
        var loser = MakeOverride("B.esp", 1, false, ("name", "Bob"), ("level", 5));
        var winner = MakeOverride("C.esp", 2, true, ("name", "Charlie"), ("level", 5));
        var result = _svc.Classify([master, loser, winner]);
        Assert.Equal(ConflictThis.ConflictLoses, result.PluginStates["B.esp"]);
    }

    // --- PartialForm null rule ---

    [Fact]
    public void Classify_NullFieldInNonMaster_TreatedAsAbsent_NotConflictLoses()
    {
        // B.esp has "name" absent (null) — a PartialForm that doesn't override "name".
        // C.esp sets "name" to "Charlie". B.esp should not get ConflictLoses for "name".
        var master = MakeOverride("A.esp", 0, false, ("name", "Alice"), ("level", 1));
        var partial = MakeOverride("B.esp", 1, false, ("name", null), ("level", 5));
        var winner = MakeOverride("C.esp", 2, true, ("name", "Charlie"), ("level", 5));
        var result = _svc.Classify([master, partial, winner]);
        Assert.NotEqual(ConflictThis.ConflictLoses, result.PluginStates["B.esp"]);
        // Diff for "name" is included even though B has null (master & C are non-null)
        Assert.Contains(result.Diffs, d => d.FieldName == "name");
    }

    [Fact]
    public void Classify_NullFieldInNonMaster_DoesNotCountAsConflict()
    {
        // B.esp absent on "name", C.esp sets "name" = same as master — no non-master disagreement
        var master = MakeOverride("A.esp", 0, false, ("name", "Alice"));
        var partial = MakeOverride("B.esp", 1, false, ("name", null));
        var winner = MakeOverride("C.esp", 2, true, ("name", "Alice"));
        var result = _svc.Classify([master, partial, winner]);
        Assert.NotEqual(ConflictAll.Conflict, result.ConflictAll);
    }

    [Fact]
    public void Classify_PluginMissingFieldEntirely_TreatedAsNull()
    {
        // B.esp's Fields list doesn't include "name" at all (not just null — absent from list).
        var master = new RecordDetail("000001:Test.esp", "A.esp", 0, false, null,
            [new FieldValue(Meta("name"), "Alice"), new FieldValue(Meta("level"), 1)]);
        var partial = new RecordDetail("000001:Test.esp", "B.esp", 1, true, null,
            [new FieldValue(Meta("level"), 5)]);
        var result = _svc.Classify([master, partial]);
        Assert.Equal(ConflictAll.Override, result.ConflictAll);
        Assert.Equal(ConflictThis.Override, result.PluginStates["B.esp"]);
    }
}
