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

        Assert.True(removed);
        Assert.Empty(_svc.GetChanges());
    }

    [Fact]
    public void Revert_UnknownId_ReturnsFalse()
    {
        Assert.False(_svc.Revert(Guid.NewGuid()));
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
    public void DrainForPlugin_FormRefsIncludedInResult()
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
    }
}
