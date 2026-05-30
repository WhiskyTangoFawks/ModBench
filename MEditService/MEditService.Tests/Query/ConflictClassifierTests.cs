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

    // --- empty / single override ---

    [Fact]
    public void ComputeDiffs_EmptyList_ReturnsEmpty()
    {
        var result = _svc.ComputeDiffs([]);
        Assert.Empty(result);
    }

    [Fact]
    public void ComputeDiffs_SingleOverride_NoDiffs()
    {
        var o = MakeOverride("Plugin.esp", 0, true, ("name", "Alice"));
        var result = _svc.ComputeDiffs([o]);
        Assert.DoesNotContain(result, d => d.IsConflict);
    }

    [Fact]
    public void ComputeDiffs_SingleOverride_FieldPresentInValues()
    {
        var o = MakeOverride("Plugin.esp", 0, true, ("name", "Alice"));
        var result = _svc.ComputeDiffs([o]);
        var diff = Assert.Single(result, d => d.FieldName == "name");
        Assert.Equal("Alice", diff.Values["Plugin.esp"]);
    }

    // --- no-conflict cases ---

    [Fact]
    public void ComputeDiffs_TwoOverrides_SameValues_NoConflict()
    {
        var a = MakeOverride("A.esp", 0, false, ("name", "Alice"));
        var b = MakeOverride("B.esp", 1, true,  ("name", "Alice"));
        var result = _svc.ComputeDiffs([a, b]);
        Assert.DoesNotContain(result, d => d.IsConflict);
    }

    // --- conflict detection ---

    [Fact]
    public void ComputeDiffs_TwoOverrides_DifferentValues_IsConflict()
    {
        var a = MakeOverride("A.esp", 0, false, ("name", "Alice"));
        var b = MakeOverride("B.esp", 1, true,  ("name", "Bob"));
        var result = _svc.ComputeDiffs([a, b]);
        var diff = Assert.Single(result, d => d.FieldName == "name");
        Assert.True(diff.IsConflict);
    }

    [Fact]
    public void ComputeDiffs_PartialConflict_OnlyConflictingFieldMarked()
    {
        var a = MakeOverride("A.esp", 0, false, ("name", "Alice"), ("level", 5));
        var b = MakeOverride("B.esp", 1, true,  ("name", "Bob"),   ("level", 5));
        var result = _svc.ComputeDiffs([a, b]);
        Assert.True(result.Single(d => d.FieldName == "name").IsConflict);
        Assert.False(result.Single(d => d.FieldName == "level").IsConflict);
    }

    // --- winner ---

    [Fact]
    public void ComputeDiffs_WinnerPlugin_MatchesIsWinnerOverride()
    {
        var a = MakeOverride("A.esp", 0, false, ("name", "Alice"));
        var b = MakeOverride("B.esp", 1, true,  ("name", "Bob"));
        var result = _svc.ComputeDiffs([a, b]);
        var diff = result.Single(d => d.FieldName == "name");
        Assert.Equal("B.esp", diff.WinnerPlugin);
        Assert.Equal("Bob", diff.WinnerValue);
    }

    // --- null filtering ---

    [Fact]
    public void ComputeDiffs_AllNullField_Excluded()
    {
        var a = MakeOverride("A.esp", 0, false, ("name", null));
        var b = MakeOverride("B.esp", 1, true,  ("name", null));
        var result = _svc.ComputeDiffs([a, b]);
        Assert.DoesNotContain(result, d => d.FieldName == "name");
    }

    [Fact]
    public void ComputeDiffs_OneNullOneValue_IncludedAsConflict()
    {
        var a = MakeOverride("A.esp", 0, false, ("name", null));
        var b = MakeOverride("B.esp", 1, true,  ("name", "Bob"));
        var result = _svc.ComputeDiffs([a, b]);
        var diff = Assert.Single(result, d => d.FieldName == "name");
        Assert.True(diff.IsConflict);
    }

    // --- Values dictionary ---

    [Fact]
    public void ComputeDiffs_ValuesDict_ContainsAllPlugins()
    {
        var a = MakeOverride("A.esp", 0, false, ("name", "Alice"));
        var b = MakeOverride("B.esp", 1, true,  ("name", "Bob"));
        var diff = _svc.ComputeDiffs([a, b]).Single(d => d.FieldName == "name");
        Assert.Equal("Alice", diff.Values["A.esp"]);
        Assert.Equal("Bob",   diff.Values["B.esp"]);
    }
}
