using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Core.Edits;

namespace MEditService.Tests.Changes;

public sealed class PendingChangeServiceTests : IDisposable
{
    private readonly DuckDBConnection _conn;
    private readonly DuckDbPendingChangeService _svc;

    public PendingChangeServiceTests()
    {
        _conn = new DuckDBConnection("DataSource=:memory:");
        _conn.Open();
        _svc = new DuckDbPendingChangeService(_conn);
    }

    public void Dispose() => _conn.Dispose();

    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    [Fact]
    public void Upsert_NewField_CreatesChange()
    {
        var fields = new Dictionary<string, JsonElement> { ["name"] = J("\"NewName\"") };
        var old = new Dictionary<string, JsonElement> { ["name"] = J("\"OldName\"") };

        var changes = _svc.Upsert("ABC:000001:TestPlugin.esp", "TestPlugin.esp", "npc_", fields, "user", null, old);

        Assert.Single(changes);
        Assert.Equal("ABC:000001:TestPlugin.esp", changes[0].FormKey);
        Assert.Equal("TestPlugin.esp", changes[0].Plugin);
        Assert.Equal("npc_", changes[0].RecordType);
        Assert.Equal("name", changes[0].FieldPath);
        Assert.Equal("\"NewName\"", changes[0].NewValue.GetRawText());
        Assert.Equal("\"OldName\"", changes[0].OldValue.GetRawText());
    }

    [Fact]
    public void Upsert_SameFieldTwice_UpdatesNewValueKeepsOldValue()
    {
        var old = new Dictionary<string, JsonElement> { ["name"] = J("\"OldName\"") };
        _svc.Upsert("FK1", "P.esp", "npc_",
            new Dictionary<string, JsonElement> { ["name"] = J("\"First\"") }, "user", null, old);
        _svc.Upsert("FK1", "P.esp", "npc_",
            new Dictionary<string, JsonElement> { ["name"] = J("\"Second\"") }, "user", null, old);

        var changes = _svc.GetChanges();
        Assert.Single(changes);
        Assert.Equal("\"OldName\"", changes[0].OldValue.GetRawText());
        Assert.Equal("\"Second\"", changes[0].NewValue.GetRawText());
    }

    [Fact]
    public void Upsert_MissingOldValue_StoresNullOldValue()
    {
        var changes = _svc.Upsert("FK1", "P.esp", "npc_",
            new Dictionary<string, JsonElement> { ["name"] = J("\"New\"") }, "user", null,
            new Dictionary<string, JsonElement>());

        Assert.Equal(JsonValueKind.Null, changes[0].OldValue.ValueKind);
    }

    [Fact]
    public void GetChanges_FiltersByPlugin()
    {
        var old = new Dictionary<string, JsonElement> { ["name"] = J("\"Old\"") };
        _svc.Upsert("FK", "A.esp", "npc_", new Dictionary<string, JsonElement> { ["name"] = J("\"A\"") }, "user", null, old);
        _svc.Upsert("FK", "B.esp", "npc_", new Dictionary<string, JsonElement> { ["name"] = J("\"B\"") }, "user", null, old);

        var result = _svc.GetChanges(plugin: "A.esp");

        Assert.Single(result);
        Assert.Equal("A.esp", result[0].Plugin);
    }

    [Fact]
    public void GetChanges_FiltersByFormKey()
    {
        var old = new Dictionary<string, JsonElement> { ["name"] = J("\"Old\"") };
        _svc.Upsert("FK1", "P.esp", "npc_", new Dictionary<string, JsonElement> { ["name"] = J("\"A\"") }, "user", null, old);
        _svc.Upsert("FK2", "P.esp", "npc_", new Dictionary<string, JsonElement> { ["name"] = J("\"B\"") }, "user", null, old);

        var result = _svc.GetChanges(formKey: "FK1");

        Assert.Single(result);
        Assert.Equal("FK1", result[0].FormKey);
    }

    [Fact]
    public void Revert_ByChangeId_RemovesChange()
    {
        var old = new Dictionary<string, JsonElement> { ["name"] = J("\"Old\"") };
        var changes = _svc.Upsert("FK1", "P.esp", "npc_",
            new Dictionary<string, JsonElement> { ["name"] = J("\"New\"") }, "user", null, old);

        var removed = _svc.Revert(changes[0].Id);

        Assert.IsType<RevertChangeResult.Reverted>(removed);
        Assert.Empty(_svc.GetChanges());
    }

    [Fact]
    public void Revert_UnknownId_ReturnsFalse()
    {
        Assert.IsType<RevertChangeResult.NotFound>(_svc.Revert(Guid.NewGuid()));
    }

    [Fact]
    public void RevertBulk_ByFormKeyAndPlugin_RemovesMatchingChanges()
    {
        var old2 = new Dictionary<string, JsonElement>
        {
            ["name"] = J("\"Old\""),
            ["short_name"] = J("\"OldShort\""),
        };
        _svc.Upsert("FK1", "P.esp", "npc_",
            new Dictionary<string, JsonElement> { ["name"] = J("\"N\""), ["short_name"] = J("\"SN\"") }, "user", null, old2);
        _svc.Upsert("FK2", "P.esp", "npc_",
            new Dictionary<string, JsonElement> { ["name"] = J("\"N2\"") }, "user", null,
            new Dictionary<string, JsonElement> { ["name"] = J("\"Old2\"") });

        var removed = _svc.Revert(plugin: "P.esp", formKey: "FK1");

        Assert.Equal(2, removed);
        var remaining = _svc.GetChanges();
        Assert.Single(remaining);
        Assert.Equal("FK2", remaining[0].FormKey);
    }

    [Fact]
    public void RevertBulk_NullFilters_RemovesAll()
    {
        var old = new Dictionary<string, JsonElement> { ["name"] = J("\"Old\"") };
        _svc.Upsert("FK1", "A.esp", "npc_", new Dictionary<string, JsonElement> { ["name"] = J("\"A\"") }, "user", null, old);
        _svc.Upsert("FK2", "B.esp", "npc_", new Dictionary<string, JsonElement> { ["name"] = J("\"B\"") }, "user", null, old);

        var removed = _svc.Revert(plugin: null, formKey: null);

        Assert.Equal(2, removed);
        Assert.Empty(_svc.GetChanges());
    }

    [Fact]
    public void DrainForPlugin_ReturnsAndClearsPluginChanges()
    {
        var old = new Dictionary<string, JsonElement> { ["name"] = J("\"Old\"") };
        _svc.Upsert("FK1", "A.esp", "npc_", new Dictionary<string, JsonElement> { ["name"] = J("\"A\"") }, "user", null, old);
        _svc.Upsert("FK1", "B.esp", "npc_", new Dictionary<string, JsonElement> { ["name"] = J("\"B\"") }, "user", null, old);

        var drained = _svc.DrainForPlugin("A.esp");

        Assert.Single(drained.Changes);
        Assert.Equal("A.esp", drained.Changes[0].Plugin);
        Assert.Empty(_svc.GetChanges(plugin: "A.esp"));
        Assert.Single(_svc.GetChanges(plugin: "B.esp"));
    }

    [Fact]
    public void GetPendingFields_ReturnsCurrentNewValues()
    {
        var old = new Dictionary<string, JsonElement> { ["name"] = J("\"Old\"") };
        _svc.Upsert("FK1", "P.esp", "npc_",
            new Dictionary<string, JsonElement> { ["name"] = J("\"New\"") }, "user", null, old);

        var pending = _svc.GetPendingFields("FK1", "P.esp");

        Assert.NotNull(pending);
        Assert.True(pending.ContainsKey("name"));
        Assert.Equal("\"New\"", pending["name"].GetRawText());
    }

    [Fact]
    public void GetPendingFields_NoChanges_ReturnsNull()
    {
        Assert.Null(_svc.GetPendingFields("FK1", "P.esp"));
    }

    [Fact]
    public void Upsert_WithDescription_DescriptionRoundTrips()
    {
        _svc.Upsert("FK1", "P.esp", "npc_",
            new() { ["name"] = J("\"x\"") }, "user", "My description", new());
        var changes = _svc.GetChanges();
        Assert.Equal("My description", changes[0].Description);
    }

    [Fact]
    public void OnSessionUnloaded_DropsTable()
    {
        _svc.Upsert("FK1", "P.esp", "npc_",
            new() { ["name"] = J("\"x\"") }, "test", null, new());

        ((IPendingChangeLifecycle)_svc).OnSessionUnloaded();

        using var cmd = _conn.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'pending_changes'";
        Assert.Equal(0L, cmd.ExecuteScalar());
    }

    [Fact]
    public void GetChanges_BeforeSessionLoaded_ThrowsWithMessage()
    {
        var svc = new DuckDbPendingChangeService();
        var ex = Assert.Throws<InvalidOperationException>(() => svc.GetChanges());
        Assert.Equal("No session loaded.", ex.Message);
    }

    // --- GetStagedFormKeys ---

    [Fact]
    public void GetStagedFormKeys_ReturnsDistinctFormKeysWithRecordType()
    {
        var fields = new Dictionary<string, JsonElement> { ["name"] = J("\"X\""), ["level"] = J("1") };
        _svc.Upsert("FK1", "Override.esp", "npc_", fields, "user", null, new());
        _svc.Upsert("FK2", "Override.esp", "weap", new() { ["damage"] = J("10") }, "user", null, new());

        var result = _svc.GetStagedFormKeys("Override.esp");

        Assert.Equal(2, result.Count);
        Assert.Contains(result, r => r.FormKey == "FK1" && r.RecordType == "npc_");
        Assert.Contains(result, r => r.FormKey == "FK2" && r.RecordType == "weap");
    }

    [Fact]
    public void GetStagedFormKeys_DeduplicatesMultipleFieldsForSameRecord()
    {
        var fields = new Dictionary<string, JsonElement> { ["name"] = J("\"X\""), ["level"] = J("1") };
        _svc.Upsert("FK1", "Override.esp", "npc_", fields, "user", null, new());

        var result = _svc.GetStagedFormKeys("Override.esp");

        Assert.Single(result);
        Assert.Equal("FK1", result[0].FormKey);
    }

    [Fact]
    public void GetStagedFormKeys_FiltersByRecordType()
    {
        _svc.Upsert("FK1", "Override.esp", "npc_", new() { ["name"] = J("\"X\"") }, "user", null, new());
        _svc.Upsert("FK2", "Override.esp", "weap", new() { ["damage"] = J("10") }, "user", null, new());

        var result = _svc.GetStagedFormKeys("Override.esp", recordType: "npc_");

        Assert.Single(result);
        Assert.Equal("FK1", result[0].FormKey);
    }

    [Fact]
    public void GetStagedFormKeys_ExcludesOtherPlugins()
    {
        _svc.Upsert("FK1", "A.esp", "npc_", new() { ["name"] = J("\"X\"") }, "user", null, new());
        _svc.Upsert("FK2", "B.esp", "npc_", new() { ["name"] = J("\"Y\"") }, "user", null, new());

        var result = _svc.GetStagedFormKeys("A.esp");

        Assert.Single(result);
        Assert.Equal("FK1", result[0].FormKey);
    }

    [Fact]
    public void GetStagedFormKeys_NoChanges_ReturnsEmpty()
    {
        var result = _svc.GetStagedFormKeys("Override.esp");
        Assert.Empty(result);
    }

    [Fact]
    public void GetStagedFormKeys_NullRecordType_ReturnsAllFormKeys()
    {
        _svc.Upsert("FK1", "A.esp", "npc_", new() { ["name"] = J("\"X\"") }, "user", null, new());
        _svc.Upsert("FK2", "A.esp", "weap", new() { ["damage"] = J("10") }, "user", null, new());

        var result = _svc.GetStagedFormKeys("A.esp", recordType: null);

        Assert.Equal(2, result.Count);
        Assert.Contains(result, r => r.FormKey == "FK1");
        Assert.Contains(result, r => r.FormKey == "FK2");
    }

    // --- pending form refs ---

    private static readonly PendingFormRef RaceRef = new("race", "race", "000001:Fallout4.esm");

    [Fact]
    public void Revert_ByChangeId_ClearsPendingFormRefs()
    {
        var changes = _svc.Upsert("FK1", "A.esp", "npc_",
            new() { ["race"] = J("\"000001:Fallout4.esm\"") }, "user", null, new(),
            [RaceRef]);

        _svc.Revert(changes[0].Id);

        // Re-stage without form refs so DrainForPlugin has a change to return
        _svc.Upsert("FK1", "A.esp", "npc_", new() { ["name"] = J("\"Bob\"") }, "user", null, new());
        var drained = _svc.DrainForPlugin("A.esp");
        Assert.Empty(drained.FormRefsByFormKey["FK1"]);
    }

    [Fact]
    public void RevertBulk_ByPlugin_ClearsPendingFormRefsForThatPluginOnly()
    {
        _svc.Upsert("FK1", "A.esp", "npc_",
            new() { ["race"] = J("\"000001:Fallout4.esm\"") }, "user", null, new(), [RaceRef]);
        _svc.Upsert("FK2", "B.esp", "npc_",
            new() { ["race"] = J("\"000001:Fallout4.esm\"") }, "user", null, new(), [RaceRef]);

        _svc.Revert(plugin: "A.esp", formKey: null);

        // A.esp form refs gone — re-stage so drain has something
        _svc.Upsert("FK1", "A.esp", "npc_", new() { ["name"] = J("\"Bob\"") }, "user", null, new());
        var drainedA = _svc.DrainForPlugin("A.esp");
        Assert.Empty(drainedA.FormRefsByFormKey["FK1"]);

        // B.esp form refs intact
        var drainedB = _svc.DrainForPlugin("B.esp");
        var bRefs = drainedB.FormRefsByFormKey["FK2"].ToList();
        Assert.Single(bRefs);
        Assert.Equal("000001:Fallout4.esm", bRefs[0].TargetFormKey);
    }

    [Fact]
    public void RevertBulk_ByFormKey_CleansUpOnlyMatchingFormRefs()
    {
        _svc.Upsert("FK1", "P.esp", "npc_",
            new() { ["race"] = J("\"000001:Fallout4.esm\"") }, "user", null, new(), [RaceRef]);
        _svc.Upsert("FK2", "P.esp", "npc_",
            new() { ["race"] = J("\"000002:Fallout4.esm\"") }, "user", null, new(),
            [new PendingFormRef("race", "race", "000002:Fallout4.esm")]);

        _svc.Revert(plugin: "P.esp", formKey: "FK1");

        // Verify FK1 refs removed and FK2 refs untouched via direct DB query
        using var cmd = _conn.CreateCommand();
        cmd.CommandText = "SELECT source_form_key FROM pending_form_references ORDER BY source_form_key";
        using var reader = cmd.ExecuteReader();
        var remaining = new List<string>();
        while (reader.Read()) remaining.Add(reader.GetString(0));
        Assert.Equal(["FK2"], remaining);
    }

    [Fact]
    public void Upsert_ReupsertSameField_ReplacesFormRefs()
    {
        var ref1 = new PendingFormRef("race", "race", "000001:Fallout4.esm");
        var ref2 = new PendingFormRef("race", "race", "000002:Fallout4.esm");

        _svc.Upsert("FK1", "A.esp", "npc_", new() { ["race"] = J("\"000001:Fallout4.esm\"") }, "user", null, new(), [ref1]);
        _svc.Upsert("FK1", "A.esp", "npc_", new() { ["race"] = J("\"000002:Fallout4.esm\"") }, "user", null, new(), [ref2]);

        var drained = _svc.DrainForPlugin("A.esp");
        var refs = drained.FormRefsByFormKey["FK1"].ToList();
        Assert.Single(refs);
        Assert.Equal("000002:Fallout4.esm", refs[0].TargetFormKey);
    }

    [Fact]
    public void DrainForPlugin_ReturnsAndClearsFormRefs()
    {
        _svc.Upsert("FK1", "A.esp", "npc_",
            new() { ["race"] = J("\"000001:Fallout4.esm\"") }, "user", null, new(),
            [RaceRef]);

        var drained = _svc.DrainForPlugin("A.esp");

        var refs = drained.FormRefsByFormKey["FK1"].ToList();
        Assert.Single(refs);
        Assert.Equal("race", refs[0].StagedField);
        Assert.Equal("race", refs[0].FieldPath);
        Assert.Equal("000001:Fallout4.esm", refs[0].TargetFormKey);

        using var cmd = _conn.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM pending_form_references WHERE source_plugin = 'A.esp'";
        Assert.Equal(0L, cmd.ExecuteScalar());
    }

    // --- ChangeGroup ---

    private static GroupMember MakeMember(string formKey, string plugin, string fieldPath) =>
        new(formKey, plugin, "npc_", "create", fieldPath, J("null"), J("\"x\""));

    [Fact]
    public void GetChangeGroups_WhenNoGroups_ReturnsEmptyList()
    {
        var result = _svc.GetChangeGroups();
        Assert.Empty(result);
    }

    [Fact]
    public void StageGroup_ReturnsGroupAndAppearsInGetChangeGroups()
    {
        var members = new[] { MakeMember("FK1", "P.esp", "name"), MakeMember("FK1", "P.esp", "level"), MakeMember("FK2", "P.esp", "name") };

        var group = _svc.StageGroup("create", "test group", members);

        Assert.Equal("create", group.Operation);
        Assert.Equal("test group", group.Description);
        Assert.Equal(3, group.ChangeCount);

        var groups = _svc.GetChangeGroups();
        Assert.Single(groups);
        Assert.Equal("create", groups[0].Operation);
        Assert.Equal(3, groups[0].ChangeCount);
    }

    [Fact]
    public void GetChangeGroups_WithDescription_PreservesDescription()
    {
        _svc.StageGroup("rename", "my description", [MakeMember("FK1", "P.esp", "name")]);

        var groups = _svc.GetChangeGroups();

        Assert.Single(groups);
        Assert.Equal("my description", groups[0].Description);
    }

    [Fact]
    public void GetChanges_FilteredByGroupId_ReturnsOnlyGroupChanges()
    {
        var members = new[] { MakeMember("FK1", "P.esp", "name"), MakeMember("FK2", "P.esp", "name") };
        var group = _svc.StageGroup("create", null, members);
        // standalone change
        _svc.Upsert("FK3", "P.esp", "npc_", new() { ["level"] = J("5") }, "user", null, new());

        var grouped = _svc.GetChanges(groupId: group.Id);

        Assert.Equal(2, grouped.Count);
        Assert.All(grouped, c => Assert.Equal(group.Id, c.GroupId));
    }

    [Fact]
    public void RevertGroup_RemovesAllChangesAndGroup()
    {
        var members = new[] { MakeMember("FK1", "P.esp", "name"), MakeMember("FK2", "P.esp", "name") };
        var group = _svc.StageGroup("create", null, members);

        var result = _svc.RevertGroup(group.Id);

        Assert.True(result);
        Assert.Empty(_svc.GetChanges(groupId: group.Id));
        Assert.Empty(_svc.GetChangeGroups());
    }

    [Fact]
    public void RevertGroup_NotFound_ReturnsFalse()
    {
        Assert.False(_svc.RevertGroup(Guid.NewGuid()));
    }

    [Fact]
    public void Revert_GroupOwned_ReturnsGroupOwned()
    {
        var members = new[] { MakeMember("FK1", "P.esp", "name") };
        _svc.StageGroup("create", null, members);
        var changeId = _svc.GetChanges(formKey: "FK1")[0].Id;

        var result = _svc.Revert(changeId);

        var owned = Assert.IsType<RevertChangeResult.GroupOwned>(result);
        Assert.NotEqual(Guid.Empty, owned.GroupId);
    }

    [Fact]
    public void GetGroupIdForRecord_WhenGroupOwned_ReturnsGroupId()
    {
        var members = new[] { MakeMember("FK1", "P.esp", "name") };
        var group = _svc.StageGroup("create", null, members);

        var gid = _svc.GetGroupIdForRecord("FK1", "P.esp");

        Assert.Equal(group.Id, gid);
    }

    [Fact]
    public void GetGroupIdForRecord_WhenStandalone_ReturnsNull()
    {
        _svc.Upsert("FK1", "P.esp", "npc_", new() { ["name"] = J("\"x\"") }, "user", null, new());

        Assert.Null(_svc.GetGroupIdForRecord("FK1", "P.esp"));
    }

    // --- Finding 2: Upsert changeType ---

    [Fact]
    public void Upsert_ChangeType_DefaultIsFieldEditExplicitOverrides()
    {
        _svc.Upsert("FK1", "P.esp", "npc_", new() { ["name"] = J("\"x\"") }, "user", null, new());
        Assert.Equal("field_edit", _svc.GetChanges()[0].ChangeType);

        _svc.Upsert("FK1", "P.esp", "npc_", new() { ["name"] = J("\"y\"") }, "user", null, new(), changeType: "create");
        Assert.Equal("create", _svc.GetChanges()[0].ChangeType);
    }

    // --- Finding 3: StageGroup returns actual DB count ---

    [Fact]
    public void StageGroup_DuplicateMembers_ReturnsActualDbCount()
    {
        var members = new[]
        {
            MakeMember("FK1", "P.esp", "name"),
            MakeMember("FK1", "P.esp", "name"),  // duplicate PK — collapses to one row
        };

        var group = _svc.StageGroup("create", null, members);

        Assert.Equal(1, group.ChangeCount);
    }

    // --- Finding 4: StageGroup ON CONFLICT updates source and description ---

    [Fact]
    public void StageGroup_OnConflict_UpdatesSourceAndDescription()
    {
        // Manual edit on the field first
        _svc.Upsert("FK1", "P.esp", "npc_", new() { ["name"] = J("\"manual\"") }, "user", "user note", new());

        // Stage group on the same field
        var members = new[] { new GroupMember("FK1", "P.esp", "npc_", "field_edit", "name", J("null"), J("\"group\""), "system") };
        _svc.StageGroup("rename", "group note", members);

        var changes = _svc.GetChanges(formKey: "FK1");
        Assert.Single(changes);
        Assert.Equal("system", changes[0].Source);
        Assert.Equal("group note", changes[0].Description);
    }

    // --- Finding 5: RevertGroup cleans up pending_form_references ---

    [Fact]
    public void RevertGroup_ClearsPendingFormRefsForGroupOwnedChanges()
    {
        // Upsert with form refs (writes pending_form_references rows)
        _svc.Upsert("FK1", "A.esp", "npc_",
            new() { ["race"] = J("\"000001:Fallout4.esm\"") }, "user", null, new(), [RaceRef]);

        // StageGroup on same field — ON CONFLICT takes ownership (group_id set)
        var members = new[] { new GroupMember("FK1", "A.esp", "npc_", "field_edit", "race", J("null"), J("\"000002:Fallout4.esm\"")) };
        var group = _svc.StageGroup("rename", null, members);

        _svc.RevertGroup(group.Id);

        using var cmd = _conn.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM pending_form_references WHERE source_form_key = 'FK1'";
        Assert.Equal(0L, cmd.ExecuteScalar());
    }

    // --- Finding 8: StageGroup uses Source from GroupMember ---

    [Fact]
    public void StageGroup_UsesSourceFromGroupMember()
    {
        var members = new[] { new GroupMember("FK1", "P.esp", "npc_", "create", "name", J("null"), J("\"x\""), "agent") };
        _svc.StageGroup("create", null, members);

        var changes = _svc.GetChanges(formKey: "FK1");
        Assert.Single(changes);
        Assert.Equal("agent", changes[0].Source);
    }

    // --- Phase 16.2.2: placement columns ---

    [Fact]
    public void Upsert_WithPlacement_RoundTripsParentCellAndGroup()
    {
        _svc.Upsert("FK1", "P.esp", "refr",
            new() { ["$create"] = J("null") }, "user", null, new(),
            changeType: "create",
            parentCell: "001234:Fallout4.esm", placementGroup: "temporary");

        var change = _svc.GetChanges(formKey: "FK1")[0];
        Assert.Equal("001234:Fallout4.esm", change.ParentCell);
        Assert.Equal("temporary", change.PlacementGroup);
    }

    [Fact]
    public void Upsert_WithoutPlacement_DefaultsBothNull()
    {
        _svc.Upsert("FK1", "P.esp", "npc_", new() { ["name"] = J("\"x\"") }, "user", null, new());

        var change = _svc.GetChanges(formKey: "FK1")[0];
        Assert.Null(change.ParentCell);
        Assert.Null(change.PlacementGroup);
    }

    [Fact]
    public void DrainForPlugin_PreservesPlacement()
    {
        _svc.Upsert("FK1", "A.esp", "refr",
            new() { ["$create"] = J("null") }, "user", null, new(),
            changeType: "create",
            parentCell: "001234:Fallout4.esm", placementGroup: "persistent");

        var drained = _svc.DrainForPlugin("A.esp");

        Assert.Single(drained.Changes);
        Assert.Equal("001234:Fallout4.esm", drained.Changes[0].ParentCell);
        Assert.Equal("persistent", drained.Changes[0].PlacementGroup);
    }

    [Fact]
    public void StageGroup_MemberWithPlacement_RoundTripsThroughGroupRead()
    {
        var members = new[]
        {
            new GroupMember("FK1", "P.esp", "refr", "delete", "$delete", J("null"), J("null"),
                "user", "001234:Fallout4.esm", "temporary"),
        };
        var group = _svc.StageGroup("delete", null, members);

        var change = _svc.GetChanges(groupId: group.Id)[0];
        Assert.Equal("001234:Fallout4.esm", change.ParentCell);
        Assert.Equal("temporary", change.PlacementGroup);
    }

    // --- Semaphore lifecycle ---

    [Fact]
    public void GetStagedFormKeys_ReleasesLockBetweenCalls()
    {
        var first = _svc.GetStagedFormKeys("A.esp");
        var second = _svc.GetStagedFormKeys("A.esp"); // deadlocks if semaphore not released
        Assert.NotNull(first);
        Assert.NotNull(second);
    }
}
