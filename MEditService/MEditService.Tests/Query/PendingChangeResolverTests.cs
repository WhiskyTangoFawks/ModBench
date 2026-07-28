using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;

namespace MEditService.Tests.Query;

public class PendingChangeResolverTests
{
    private static JsonElement J(string json) => JsonSerializer.Deserialize<JsonElement>(json);

    private static PendingChange MakeChange(string fieldPath, string recordType, JsonElement newValue) =>
        new(Guid.NewGuid(), "000001:Test.esp", "Test.esp", fieldPath, recordType,
            J("null"), newValue, "user", null, DateTime.UtcNow, "field_edit");

    private static ColumnSpec FormKeyColumn(string name, params string[] validTypes) =>
        new(name, name, "VARCHAR", _ => null, "formKey", validTypes, [], null);

    private static ColumnSpec ArrayOfFormKeyColumn(string name, params string[] validTypes)
    {
        var elemMeta = new FieldMetadata("", "formKey", false, validTypes, [], AllowsNull: true);
        return new ColumnSpec(name, name, "VARCHAR", _ => null, "array", [], [], null, IsArray: true, ElementType: elemMeta);
    }

    private static IReadOnlyDictionary<string, RecordTableSchema> Schemas(string tableName, params ColumnSpec[] columns) =>
        Schemas(tableName, tableName, columns);

    private static IReadOnlyDictionary<string, RecordTableSchema> Schemas(
        string tableName, string displayName, params ColumnSpec[] columns) =>
        new Dictionary<string, RecordTableSchema>
        {
            [tableName] = new() { TableName = tableName, DisplayName = displayName, RecordType = typeof(object), RecordColumns = columns, HasVmad = false },
        };

    [Fact]
    public void Resolve_ScalarFormKeyField_PopulatesResolutionAtRootPath()
    {
        var change = MakeChange("race", "npc_", J("\"000AAA:Test.esp\""));
        var schemas = Schemas("npc_", FormKeyColumn("race", "race"));

        static RecordLookupEntry? Resolve(string fk) =>
            fk == "000AAA:Test.esp" ? new RecordLookupEntry("race", "GoodRace") : null;

        var resolved = PendingChangeResolver.Resolve(change, schemas, Resolve);

        Assert.NotNull(resolved.Resolutions);
        Assert.Equal(FormKeyResolutionState.ResolvedValidType, resolved.Resolutions![""].State);
        Assert.Equal("GoodRace", resolved.Resolutions[""].EditorId);
    }

    [Fact]
    public void Resolve_DanglingFormKey_ReturnsUnresolved()
    {
        var change = MakeChange("race", "npc_", J("\"000FFF:Test.esp\""));
        var schemas = Schemas("npc_", FormKeyColumn("race", "race"));

        var resolved = PendingChangeResolver.Resolve(change, schemas, _ => null);

        Assert.Equal(FormKeyResolutionState.Unresolved, resolved.Resolutions![""].State);
    }

    [Fact]
    public void Resolve_ArrayOfFormKey_SiblingElementsResolveIndependently()
    {
        var change = MakeChange("keywords", "npc_", J("""["000AAA:Test.esp","000FFF:Test.esp"]"""));
        var schemas = Schemas("npc_", ArrayOfFormKeyColumn("keywords", "kywd"));

        static RecordLookupEntry? Resolve(string fk) =>
            fk == "000AAA:Test.esp" ? new RecordLookupEntry("kywd", "GoodKeyword") : null;

        var resolved = PendingChangeResolver.Resolve(change, schemas, Resolve);

        Assert.Equal(FormKeyResolutionState.ResolvedValidType, resolved.Resolutions!["[0]"].State);
        Assert.Equal(FormKeyResolutionState.Unresolved, resolved.Resolutions["[1]"].State);
    }

    [Fact]
    public void Resolve_NonFormKeyField_ResolutionsStaysNull()
    {
        var change = MakeChange("height", "npc_", J("1.5"));
        var schemas = Schemas("npc_", new ColumnSpec("height", "height", "FLOAT", _ => null, "float", [], [], null));

        var resolved = PendingChangeResolver.Resolve(change, schemas, _ => null);

        Assert.Null(resolved.Resolutions);
    }

    [Fact]
    public void Resolve_VmadObjectProperty_PopulatesResolutionAtRootPath()
    {
        var change = MakeChange(
            VmadPath.Build("MyScript", "MyProperty"), "npc_", J("""{"formKey":"000AAA:Test.esp","alias":1}"""));
        var schemas = Schemas("npc_", FormKeyColumn("race", "race"));

        static RecordLookupEntry? Resolve(string fk) =>
            fk == "000AAA:Test.esp" ? new RecordLookupEntry("kywd", "GoodKeyword") : null;

        var resolved = PendingChangeResolver.Resolve(change, schemas, Resolve);

        Assert.NotNull(resolved.Resolutions);
        // No expected-type list at this layer (no Papyrus-declared type) — always ResolvedValidType
        // when resolved, mirroring VmadConflictClassifier's slice-5 treatment.
        Assert.Equal(FormKeyResolutionState.ResolvedValidType, resolved.Resolutions![""].State);
        Assert.Equal("GoodKeyword", resolved.Resolutions[""].EditorId);
    }

    [Fact]
    public void Resolve_VmadArrayOfObjectProperty_SiblingElementsResolveIndependently()
    {
        var change = MakeChange(
            VmadPath.Build("MyScript", "MyProperty"), "npc_",
            J("""[{"formKey":"000AAA:Test.esp","alias":1},{"formKey":"000FFF:Test.esp","alias":2}]"""));
        var schemas = Schemas("npc_", FormKeyColumn("race", "race"));

        static RecordLookupEntry? Resolve(string fk) =>
            fk == "000AAA:Test.esp" ? new RecordLookupEntry("kywd", "Good") : null;

        var resolved = PendingChangeResolver.Resolve(change, schemas, Resolve);

        Assert.Equal(FormKeyResolutionState.ResolvedValidType, resolved.Resolutions!["[0]"].State);
        Assert.Equal(FormKeyResolutionState.Unresolved, resolved.Resolutions["[1]"].State);
    }

    [Fact]
    public void Resolve_VmadStructProperty_PassesThroughUnresolved()
    {
        // Pre-existing scope cut: VmadCodec.ValueFormKeysWithPaths doesn't walk into Struct-shaped
        // values (same gap ExtractVmadValueRefs/form_references already has), so a Struct property's
        // FormKey members aren't reachable here. Tracked separately, not a regression of this change.
        var change = MakeChange(
            VmadPath.Build("MyScript", "MyProperty"), "npc_",
            J("""{"members":[{"name":"Target","type":"Object","formKey":"000AAA:Test.esp"}]}"""));
        var schemas = Schemas("npc_", FormKeyColumn("race", "race"));

        var resolved = PendingChangeResolver.Resolve(change, schemas, _ => new RecordLookupEntry("race", "X"));

        Assert.Null(resolved.Resolutions);
    }

    [Fact]
    public void Resolve_RecordFormKeyResolves_PopulatesRecordResolution()
    {
        var change = MakeChange("race", "npc_", J("\"000AAA:Test.esp\""));
        var schemas = Schemas("npc_", FormKeyColumn("race", "race"));

        static RecordLookupEntry? Resolve(string fk) => fk switch
        {
            "000001:Test.esp" => new RecordLookupEntry("npc_", "MyNpc"),
            "000AAA:Test.esp" => new RecordLookupEntry("race", "GoodRace"),
            _ => null,
        };

        var resolved = PendingChangeResolver.Resolve(change, schemas, Resolve);

        Assert.NotNull(resolved.RecordResolution);
        Assert.Equal(FormKeyResolutionState.ResolvedValidType, resolved.RecordResolution!.State);
        Assert.Equal("MyNpc", resolved.RecordResolution.EditorId);
        Assert.Equal("npc_", resolved.RecordResolution.RecordType);
    }

    [Fact]
    public void Resolve_PopulatesRecordTypeDisplayName_FromSchema()
    {
        // Issue #110: the Pending Changes tree's `{RecordType} / {EditorID}` leaf label should
        // read an xEdit-parity display name, not the raw signature.
        var change = MakeChange("race", "npc_", J("\"000AAA:Test.esp\""));
        var schemas = Schemas("npc_", "Non-Player Character", FormKeyColumn("race", "race"));

        var resolved = PendingChangeResolver.Resolve(change, schemas, _ => null);

        Assert.Equal("Non-Player Character", resolved.RecordTypeDisplayName);
    }

    [Fact]
    public void Resolve_RecordFormKeyDangling_RecordResolutionIsUnresolved()
    {
        var change = MakeChange("race", "npc_", J("\"000AAA:Test.esp\""));
        var schemas = Schemas("npc_", FormKeyColumn("race", "race"));

        var resolved = PendingChangeResolver.Resolve(change, schemas, _ => null);

        Assert.Equal(FormKeyResolutionState.Unresolved, resolved.RecordResolution!.State);
    }

    [Fact]
    public void ResolveAll_MapsEveryChange()
    {
        var a = MakeChange("race", "npc_", J("\"000AAA:Test.esp\""));
        var b = MakeChange("race", "npc_", J("\"000BBB:Test.esp\""));
        var schemas = Schemas("npc_", FormKeyColumn("race", "race"));

        var resolved = PendingChangeResolver.ResolveAll([a, b], schemas, _ => null);

        Assert.All(resolved, c => Assert.Equal(FormKeyResolutionState.Unresolved, c.Resolutions![""].State));
    }
}
