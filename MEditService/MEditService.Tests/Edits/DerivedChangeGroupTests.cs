using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Core.Edits;

namespace MEditService.Tests.Edits;

/// <summary>
/// Change groups are derived dependency closures, not stored batches (ADR-0028): a group is a
/// connected component of the pending-change dependency graph, and a change nothing depends on
/// is a group of one. These observe grouping only through <see cref="IPendingChangeService"/> —
/// never through the stored <c>group_id</c>, which is still written but no longer read.
/// </summary>
public sealed class DerivedChangeGroupTests : IDisposable
{
    private readonly DuckDBConnection _conn;
    private readonly DuckDbPendingChangeService _svc;

    public DerivedChangeGroupTests()
    {
        _conn = new DuckDBConnection("DataSource=:memory:");
        _conn.Open();
        _svc = new DuckDbPendingChangeService(_conn);
    }

    public void Dispose() => _conn.Dispose();

    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private void StageEdit(string formKey, string plugin, string field, string newValue = "\"new\"") =>
        _svc.Upsert(new PendingChangeUpsert(
            formKey, plugin, "npc_",
            new Dictionary<string, JsonElement> { [field] = J(newValue) },
            "user", null,
            new Dictionary<string, JsonElement> { [field] = J("\"old\"") }));

    // Issue #112: an ordinary field edit stages with group_id = NULL, so under the stored model it
    // had no change_groups row and was unreachable — invisible in the tree and impossible to save.
    [Fact]
    public void OneFieldEdit_IsAGroupOfOne()
    {
        StageEdit("000001:A.esp", "A.esp", "name");

        var group = Assert.Single(_svc.GetChangeGroups());

        Assert.Equal(1, group.ChangeCount);
        Assert.Equal(1, group.PluginCount);
        Assert.Equal("field_edit", group.Operation);
    }

    // Nodes are changes, not records. Grouping by (form_key, plugin) would pass the test above and
    // still be wrong: two edits to one record depend on nothing of each other's, and reverting the
    // name cannot invalidate the level.
    [Fact]
    public void TwoEditsToDifferentFieldsOfOneRecord_AreIndependentGroups()
    {
        StageEdit("000001:A.esp", "A.esp", "name");
        StageEdit("000001:A.esp", "A.esp", "level");

        var groups = _svc.GetChangeGroups();

        Assert.Equal(2, groups.Count);
        Assert.All(groups, g => Assert.Equal(1, g.ChangeCount));

        // Reverting one leaves the other staged.
        Assert.True(_svc.RevertGroup(groups[0].Id));
        var survivor = Assert.Single(_svc.GetChanges());
        Assert.Single(_svc.GetChangeGroups());
        Assert.Equal(survivor.Id, _svc.GetChangeGroups()[0].Id);
    }

    [Fact]
    public void RevertingAGroupOfOne_LeavesNothingStaged()
    {
        StageEdit("000001:A.esp", "A.esp", "name");
        var group = Assert.Single(_svc.GetChangeGroups());

        Assert.True(_svc.RevertGroup(group.Id));

        Assert.Empty(_svc.GetChanges());
        Assert.Empty(_svc.GetChangeGroups());
    }

    // Re-editing a field updates the row in place rather than staging a second change (ADR-0017 §3),
    // so it stays one group — and the old value stays the original on-disk one, which is what revert
    // restores. Deriving groups must not disturb either.
    [Fact]
    public void ReEditingTheSameField_StaysOneGroupAndKeepsTheOriginalOldValue()
    {
        StageEdit("000001:A.esp", "A.esp", "name", "\"first\"");
        StageEdit("000001:A.esp", "A.esp", "name", "\"second\"");

        var group = Assert.Single(_svc.GetChangeGroups());
        Assert.Equal(1, group.ChangeCount);

        var change = Assert.Single(_svc.GetChanges());
        Assert.Equal("second", change.NewValue.GetString());
        Assert.Equal("old", change.OldValue.GetString());
    }

    // A group's id is a member change id, and any member names the whole component — groups have no
    // identity of their own (ADR-0028).
    [Fact]
    public void AnyMemberChangeId_NamesTheWholeGroup()
    {
        // A create plus an edit on the record it creates: one component of two (edge rule 2).
        _svc.Upsert(new PendingChangeUpsert(
            "000001:A.esp", "A.esp", "npc_",
            new Dictionary<string, JsonElement> { ["$create"] = J("null") },
            "user", null, [], FormRefs: null, ChangeType: "create"));
        StageEdit("000001:A.esp", "A.esp", "name");

        var group = Assert.Single(_svc.GetChangeGroups());
        Assert.Equal(2, group.ChangeCount);
        Assert.Equal("create", group.Operation);

        foreach (var member in _svc.GetChanges())
            Assert.Equal(2, _svc.GetChanges(memberChangeId: member.Id).Count);
    }
}
