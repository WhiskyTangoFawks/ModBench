using System.Text.Json;
using MEditService.Core.Edits;

namespace MEditService.Tests.Changes;

public sealed class PendingChangeServiceTests
{
    private readonly PendingChangeService _svc = new();

    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    [Fact]
    public void Upsert_NewField_CreatesChange()
    {
        var fields = new Dictionary<string, JsonElement> { ["name"] = J("\"NewName\"") };
        var old    = new Dictionary<string, JsonElement> { ["name"] = J("\"OldName\"") };

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

        Assert.Single(drained);
        Assert.Equal("A.esp", drained[0].Plugin);
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
}
