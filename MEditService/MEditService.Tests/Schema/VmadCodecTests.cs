using System.Text.Json;
using MEditService.Core.Schema;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Schema;

public class VmadCodecTests
{
    private static readonly FormKey Target = FormKey.Factory("000800:Test.esp");

    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    // ---- Taxonomy ----

    [Theory]
    [InlineData("ArrayOfBool", "Bool")]
    [InlineData("ArrayOfInt", "Int")]
    [InlineData("ArrayOfFloat", "Float")]
    [InlineData("ArrayOfString", "String")]
    [InlineData("ArrayOfObject", "Object")]
    public void ElementType_ArrayOfScalar_ReturnsElementType(string arrayType, string expected) =>
        Assert.Equal(expected, VmadCodec.ElementType(arrayType));

    // ArrayOfStruct's elements live in struct_json, not in list-item rows, so it is not
    // an element-bearing array type as far as the taxonomy is concerned.
    [Theory]
    [InlineData("Bool")]
    [InlineData("Object")]
    [InlineData("Struct")]
    [InlineData("ArrayOfStruct")]
    [InlineData("ArrayOfVariable")]
    [InlineData("Nonsense")]
    public void ElementType_NonElementBearingType_ReturnsNull(string type) =>
        Assert.Null(VmadCodec.ElementType(type));

    // ---- Editability ----

    [Theory]
    [InlineData("Bool")]
    [InlineData("Int")]
    [InlineData("Float")]
    [InlineData("String")]
    [InlineData("Object")]
    [InlineData("ArrayOfBool")]
    [InlineData("ArrayOfInt")]
    [InlineData("ArrayOfFloat")]
    [InlineData("ArrayOfString")]
    [InlineData("ArrayOfObject")]
    public void IsEditable_ValueTypes_ReturnsTrue(string type) =>
        Assert.True(VmadCodec.IsEditable(type));

    // Struct/ArrayOfStruct are edited through struct ops, not plain field edits;
    // Variable types are not editable at all.
    [Theory]
    [InlineData("Struct")]
    [InlineData("ArrayOfStruct")]
    [InlineData("Variable")]
    [InlineData("ArrayOfVariable")]
    [InlineData("Nonsense")]
    public void IsEditable_NonValueTypes_ReturnsFalse(string type) =>
        Assert.False(VmadCodec.IsEditable(type));

    // ---- Default properties ----

    [Theory]
    [InlineData("Bool", typeof(ScriptBoolProperty))]
    [InlineData("Int", typeof(ScriptIntProperty))]
    [InlineData("Float", typeof(ScriptFloatProperty))]
    [InlineData("String", typeof(ScriptStringProperty))]
    [InlineData("Object", typeof(ScriptObjectProperty))]
    [InlineData("ArrayOfBool", typeof(ScriptBoolListProperty))]
    [InlineData("ArrayOfInt", typeof(ScriptIntListProperty))]
    [InlineData("ArrayOfFloat", typeof(ScriptFloatListProperty))]
    [InlineData("ArrayOfString", typeof(ScriptStringListProperty))]
    [InlineData("ArrayOfObject", typeof(ScriptObjectListProperty))]
    [InlineData("Struct", typeof(ScriptStructProperty))]
    [InlineData("ArrayOfStruct", typeof(ScriptStructListProperty))]
    public void CreateDefault_EditableType_ReturnsPropertyOfThatType(string type, Type expected) =>
        Assert.IsType(expected, VmadCodec.CreateDefault(type));

    // A new Object property points at nothing with xEdit's "no alias" sentinel.
    [Fact]
    public void CreateDefault_Object_HasNullFormLinkAndNoAlias()
    {
        var prop = Assert.IsType<ScriptObjectProperty>(VmadCodec.CreateDefault("Object"));
        Assert.True(prop.Object.IsNull);
        Assert.Equal(-1, prop.Alias);
    }

    [Theory]
    [InlineData("Variable")]
    [InlineData("ArrayOfVariable")]
    [InlineData("Nonsense")]
    public void CreateDefault_UnconstructableType_ReturnsNull(string type) =>
        Assert.Null(VmadCodec.CreateDefault(type));

    // ---- ApplyValue: scalars ----

    [Fact]
    public void ApplyValue_Bool_SetsData()
    {
        var prop = new ScriptBoolProperty();
        Assert.Equal(VmadApplyResult.Applied, VmadCodec.ApplyValue(prop, J("true")));
        Assert.True(prop.Data);
    }

    [Fact]
    public void ApplyValue_Int_SetsData()
    {
        var prop = new ScriptIntProperty();
        Assert.Equal(VmadApplyResult.Applied, VmadCodec.ApplyValue(prop, J("42")));
        Assert.Equal(42, prop.Data);
    }

    [Fact]
    public void ApplyValue_Float_SetsData()
    {
        var prop = new ScriptFloatProperty();
        Assert.Equal(VmadApplyResult.Applied, VmadCodec.ApplyValue(prop, J("1.5")));
        Assert.Equal(1.5f, prop.Data);
    }

    [Fact]
    public void ApplyValue_String_SetsData()
    {
        var prop = new ScriptStringProperty();
        Assert.Equal(VmadApplyResult.Applied, VmadCodec.ApplyValue(prop, J("\"hello\"")));
        Assert.Equal("hello", prop.Data);
    }

    // ---- ApplyValue: Object and arrays ----

    [Fact]
    public void ApplyValue_Object_SetsFormKeyAndAlias()
    {
        var prop = new ScriptObjectProperty();
        Assert.Equal(VmadApplyResult.Applied, VmadCodec.ApplyValue(prop, J($"{{\"formKey\":\"{Target}\",\"alias\":5}}")));
        Assert.Equal(Target, prop.Object.FormKey);
        Assert.Equal(5, prop.Alias);
    }

    [Theory]
    [InlineData("{\"formKey\":\"BADKEY\",\"alias\":0}")]
    [InlineData("{\"formKey\":\"000800:Test.esp\",\"alias\":null}")]
    [InlineData("{\"alias\":0}")]
    public void ApplyValue_MalformedObject_ReturnsNotFound(string json) =>
        Assert.Equal(VmadApplyResult.NotFound, VmadCodec.ApplyValue(new ScriptObjectProperty(), J(json)));

    [Fact]
    public void ApplyValue_ArrayOfInt_ReplacesElements()
    {
        var prop = new ScriptIntListProperty();
        prop.Data.Add(99);
        Assert.Equal(VmadApplyResult.Applied, VmadCodec.ApplyValue(prop, J("[1,2,3]")));
        Assert.Equal([1, 2, 3], prop.Data);
    }

    [Fact]
    public void ApplyValue_ArrayOfObject_ReplacesElements()
    {
        var prop = new ScriptObjectListProperty();
        Assert.Equal(
            VmadApplyResult.Applied,
            VmadCodec.ApplyValue(prop, J($"[{{\"formKey\":\"{Target}\",\"alias\":1}}]")));
        var obj = Assert.Single(prop.Objects);
        Assert.Equal(Target, obj.Object.FormKey);
        Assert.Equal(1, obj.Alias);
    }

    [Fact]
    public void ApplyValue_ArrayOfObject_MalformedElement_LeavesPropertyUntouched()
    {
        var prop = new ScriptObjectListProperty();
        Assert.Equal(VmadApplyResult.NotFound, VmadCodec.ApplyValue(prop, J("[{\"formKey\":\"BADKEY\",\"alias\":1}]")));
        Assert.Empty(prop.Objects);
    }

    // ---- ApplyValue: structs ----

    // Struct members arrive in the VmadPropertyNode wire shape and land inside a single
    // unnamed ScriptEntry wrapper, which is how the binary format nests them.
    [Fact]
    public void ApplyValue_Struct_BuildsMembersInsideWrapper()
    {
        var prop = new ScriptStructProperty();
        var json = J($$"""
            [
              {"name":"Flag","type":"Bool","boolValue":true},
              {"name":"Ref","type":"Object","formKeyValue":"{{Target}}","aliasValue":2},
              {"name":"Nested","type":"Struct","members":[{"name":"Count","type":"Int","intValue":7}]}
            ]
            """);

        Assert.Equal(VmadApplyResult.Applied, VmadCodec.ApplyValue(prop, json));

        var wrapper = Assert.Single(prop.Members);
        Assert.Equal(["Flag", "Ref", "Nested"], wrapper.Properties.Select(p => p.Name));
        Assert.True(Assert.IsType<ScriptBoolProperty>(wrapper.Properties[0]).Data);
        Assert.Equal(Target, Assert.IsType<ScriptObjectProperty>(wrapper.Properties[1]).Object.FormKey);
        var nested = Assert.IsType<ScriptStructProperty>(wrapper.Properties[2]);
        Assert.Equal(7, Assert.IsType<ScriptIntProperty>(Assert.Single(nested.Members).Properties[0]).Data);
    }

    // A struct member Object property reads as a null formKeyValue (the
    // previous test above), so apply must accept that shape back and build a null Object
    // member, not fail the whole struct the way a malformed value does.
    [Fact]
    public void ApplyValue_Struct_NullObjectMember_BuildsNullObject()
    {
        var prop = new ScriptStructProperty();
        var json = J("""[{"name":"Ref","type":"Object","formKeyValue":null,"aliasValue":-1}]""");

        Assert.Equal(VmadApplyResult.Applied, VmadCodec.ApplyValue(prop, json));

        var wrapper = Assert.Single(prop.Members);
        var rebuilt = Assert.IsType<ScriptObjectProperty>(Assert.Single(wrapper.Properties));
        Assert.True(rebuilt.Object.IsNull);
        Assert.Equal((short)-1, rebuilt.Alias);
    }

    [Fact]
    public void ApplyValue_ArrayOfStruct_BuildsOneEntryPerInstance()
    {
        var prop = new ScriptStructListProperty();
        var json = J("""
            [
              [{"name":"Count","type":"Int","intValue":1}],
              [{"name":"Count","type":"Int","intValue":2}]
            ]
            """);

        Assert.Equal(VmadApplyResult.Applied, VmadCodec.ApplyValue(prop, json));
        Assert.Equal(
            [1, 2],
            prop.Structs.Select(s => ((ScriptIntProperty)s.Members[0]).Data));
    }

    // A member whose value key doesn't match its declared type is rejected wholesale.
    [Fact]
    public void ApplyValue_StructMemberMissingValue_ReturnsNotFound()
    {
        var prop = new ScriptStructProperty();
        Assert.Equal(
            VmadApplyResult.NotFound,
            VmadCodec.ApplyValue(prop, J("[{\"name\":\"Flag\",\"type\":\"Bool\"}]")));
        Assert.Empty(prop.Members);
    }

    // ---- ApplyValue: non-editable ----

    [Fact]
    public void ApplyValue_VariableProperty_ReturnsReadOnly() =>
        Assert.Equal(VmadApplyResult.ReadOnly, VmadCodec.ApplyValue(new ScriptVariableProperty(), J("1")));

    // ---- Field values by name ----

    [Fact]
    public void ApplyFieldValue_ExistingProperty_SetsValue()
    {
        var npc = NpcWithScript("DefaultScript", new ScriptIntProperty { Name = "Counter", Data = 1 });

        Assert.Equal(
            VmadApplyResult.Applied,
            VmadCodec.ApplyFieldValue(npc, "defaultscript", "counter", J("42")));
        Assert.Equal(42, ((ScriptIntProperty)npc.VirtualMachineAdapter!.Scripts[0].Properties[0]).Data);
    }

    [Theory]
    [InlineData("Missing", "Counter")]
    [InlineData("DefaultScript", "Missing")]
    public void ApplyFieldValue_UnknownScriptOrProperty_ReturnsNotFound(string script, string prop)
    {
        var npc = NpcWithScript("DefaultScript", new ScriptIntProperty { Name = "Counter", Data = 1 });
        Assert.Equal(VmadApplyResult.NotFound, VmadCodec.ApplyFieldValue(npc, script, prop, J("42")));
    }

    [Fact]
    public void ApplyFieldValue_RecordWithoutAdapter_ReturnsNotFound() =>
        Assert.Equal(VmadApplyResult.NotFound, VmadCodec.ApplyFieldValue(NewNpc(), "DefaultScript", "Counter", J("42")));

    // ---- Script-level ops ----

    // A record with no adapter at all gets one attached, so add_script is the entry point
    // for scripting a previously unscripted record.
    [Fact]
    public void ApplyScriptOp_AddScript_AttachesAdapterAndAddsEmptyScript()
    {
        var npc = NewNpc();

        Assert.Equal(
            VmadApplyResult.Applied,
            VmadCodec.ApplyScriptOp(npc, "NewScript", "add_script", J("{\"op\":\"add_script\"}")));

        var script = Assert.Single(npc.VirtualMachineAdapter!.Scripts);
        Assert.Equal("NewScript", script.Name);
        Assert.Equal(ScriptEntry.Flag.Local, script.Flags);
        Assert.Empty(script.Properties);
    }

    [Fact]
    public void ApplyScriptOp_AddScript_ReplacesSameNameAndKeepsScriptsSorted()
    {
        var npc = NpcWithScript("Middle", new ScriptIntProperty { Name = "Counter" });
        npc.VirtualMachineAdapter!.Scripts.Add(new ScriptEntry { Name = "Zebra" });

        VmadCodec.ApplyScriptOp(npc, "middle", "add_script", J("{\"op\":\"add_script\",\"flags\":\"Inherited\"}"));
        VmadCodec.ApplyScriptOp(npc, "Alpha", "add_script", J("{\"op\":\"add_script\"}"));

        Assert.Equal(["Alpha", "middle", "Zebra"], npc.VirtualMachineAdapter.Scripts.Select(s => s.Name));
        var replaced = npc.VirtualMachineAdapter.Scripts[1];
        Assert.Equal(ScriptEntry.Flag.Inherited, replaced.Flags);
        Assert.Empty(replaced.Properties);
    }

    // Removing the last script leaves an empty adapter (matches xEdit) rather than nulling it.
    [Fact]
    public void ApplyScriptOp_RemoveScript_LeavesEmptyAdapter()
    {
        var npc = NpcWithScript("DefaultScript", new ScriptIntProperty { Name = "Counter" });

        Assert.Equal(
            VmadApplyResult.Applied,
            VmadCodec.ApplyScriptOp(npc, "defaultscript", "remove_script", J("{\"op\":\"remove_script\"}")));
        Assert.NotNull(npc.VirtualMachineAdapter);
        Assert.Empty(npc.VirtualMachineAdapter.Scripts);
    }

    [Fact]
    public void ApplyScriptOp_SetFlags_SetsScriptFlags()
    {
        var npc = NpcWithScript("DefaultScript", new ScriptIntProperty { Name = "Counter" });

        Assert.Equal(
            VmadApplyResult.Applied,
            VmadCodec.ApplyScriptOp(npc, "DefaultScript", "set_flags", J("{\"op\":\"set_flags\",\"flags\":\"Inherited\"}")));
        Assert.Equal(ScriptEntry.Flag.Inherited, npc.VirtualMachineAdapter!.Scripts[0].Flags);
    }

    [Theory]
    [InlineData("remove_script")]
    [InlineData("set_flags")]
    [InlineData("nonsense_op")]
    public void ApplyScriptOp_UnknownScriptOrOp_ReturnsNotFound(string opName)
    {
        var npc = NpcWithScript("DefaultScript", new ScriptIntProperty { Name = "Counter" });
        Assert.Equal(
            VmadApplyResult.NotFound,
            VmadCodec.ApplyScriptOp(npc, "Missing", opName, J($"{{\"op\":\"{opName}\"}}")));
    }

    // ---- Property-level ops ----

    [Fact]
    public void ApplyPropertyOp_AddProperty_AddsWithValueAndKeepsPropertiesSorted()
    {
        var npc = NpcWithScript("DefaultScript", new ScriptIntProperty { Name = "Zebra" });
        var op = J("{\"op\":\"add_property\",\"name\":\"Alpha\",\"type\":\"Int\",\"value\":7}");

        Assert.Equal(
            VmadApplyResult.Applied,
            VmadCodec.ApplyPropertyOp(npc, "DefaultScript", "Alpha", "add_property", op));

        var props = npc.VirtualMachineAdapter!.Scripts[0].Properties;
        Assert.Equal(["Alpha", "Zebra"], props.Select(p => p.Name));
        var added = Assert.IsType<ScriptIntProperty>(props[0]);
        Assert.Equal(7, added.Data);
        Assert.Equal(ScriptProperty.Flag.Edited, added.Flags);
    }

    [Fact]
    public void ApplyPropertyOp_RemoveProperty_RemovesIt()
    {
        var npc = NpcWithScript("DefaultScript", new ScriptIntProperty { Name = "Counter" });

        Assert.Equal(
            VmadApplyResult.Applied,
            VmadCodec.ApplyPropertyOp(npc, "DefaultScript", "counter", "remove_property", J("{\"op\":\"remove_property\"}")));
        Assert.Empty(npc.VirtualMachineAdapter!.Scripts[0].Properties);
    }

    // Retyping resets the value but keeps name and flags (mirrors xEdit's wbScriptPropertyTypeAfterSet).
    [Fact]
    public void ApplyPropertyOp_SetType_ReplacesPropertyPreservingNameAndFlags()
    {
        var npc = NpcWithScript(
            "DefaultScript",
            new ScriptIntProperty { Name = "Counter", Data = 42, Flags = ScriptProperty.Flag.Edited });

        Assert.Equal(
            VmadApplyResult.Applied,
            VmadCodec.ApplyPropertyOp(npc, "DefaultScript", "Counter", "set_type", J("{\"op\":\"set_type\",\"type\":\"String\"}")));

        var prop = Assert.IsType<ScriptStringProperty>(npc.VirtualMachineAdapter!.Scripts[0].Properties[0]);
        Assert.Equal("Counter", prop.Name);
        Assert.Equal(ScriptProperty.Flag.Edited, prop.Flags);
        Assert.Equal("", prop.Data);
    }

    [Fact]
    public void ApplyPropertyOp_SetFlags_SetsPropertyFlags()
    {
        var npc = NpcWithScript("DefaultScript", new ScriptIntProperty { Name = "Counter" });

        Assert.Equal(
            VmadApplyResult.Applied,
            VmadCodec.ApplyPropertyOp(npc, "DefaultScript", "Counter", "set_flags", J("{\"op\":\"set_flags\",\"flags\":\"Removed\"}")));
        Assert.Equal(ScriptProperty.Flag.Removed, npc.VirtualMachineAdapter!.Scripts[0].Properties[0].Flags);
    }

    [Fact]
    public void ApplyPropertyOp_UnknownScript_ReturnsNotFound()
    {
        var npc = NpcWithScript("DefaultScript", new ScriptIntProperty { Name = "Counter" });
        Assert.Equal(
            VmadApplyResult.NotFound,
            VmadCodec.ApplyPropertyOp(npc, "Missing", "Counter", "remove_property", J("{\"op\":\"remove_property\"}")));
    }

    [Fact]
    public void ApplyPropertyOp_AddPropertyOfUnconstructableType_ReturnsNotFound()
    {
        var npc = NpcWithScript("DefaultScript", new ScriptIntProperty { Name = "Counter" });
        var op = J("{\"op\":\"add_property\",\"name\":\"Var\",\"type\":\"Variable\"}");

        Assert.Equal(VmadApplyResult.NotFound, VmadCodec.ApplyPropertyOp(npc, "DefaultScript", "Var", "add_property", op));
        Assert.Single(npc.VirtualMachineAdapter!.Scripts[0].Properties);
    }

    // ---- Parse: leaves ----

    [Fact]
    public void Parse_BoolProperty_ReturnsTypeFlagsAndValue()
    {
        var parsed = VmadCodec.Parse(new ScriptBoolProperty { Name = "Flag", Flags = ScriptProperty.Flag.Edited, Data = true });

        Assert.NotNull(parsed);
        Assert.Equal("Bool", parsed.Type);
        Assert.Equal("Edited", parsed.Flags);
        Assert.True(parsed.Value.BoolValue);
        Assert.Null(parsed.Items);
        Assert.Null(parsed.StructJson);
        Assert.Empty(parsed.Refs);
    }

    // Flags of 0 render as an empty string, not "None".
    [Fact]
    public void Parse_UnflaggedProperty_ReturnsEmptyFlags() =>
        Assert.Equal("", VmadCodec.Parse(new ScriptIntProperty { Name = "Counter", Data = 3, Flags = 0 })!.Flags);

    [Fact]
    public void Parse_ObjectProperty_ReturnsFormKeyAliasAndSelfRef()
    {
        var prop = new ScriptObjectProperty { Name = "Target", Alias = 4 };
        prop.Object.SetTo(Target);

        var parsed = VmadCodec.Parse(prop)!;

        Assert.Equal("Object", parsed.Type);
        Assert.Equal(Target.ToString(), parsed.Value.FormKeyValue);
        Assert.Equal((short?)4, parsed.Value.AliasValue);
        var reference = Assert.Single(parsed.Refs);
        Assert.Equal("", reference.RelativePath);
        Assert.Equal(Target.ToString(), reference.FormKey);
    }

    [Fact]
    public void Parse_NullObjectProperty_ReturnsNoValueAndNoRefs()
    {
        var parsed = VmadCodec.Parse(new ScriptObjectProperty { Name = "Target", Alias = -1 })!;

        Assert.Equal("Object", parsed.Type);
        Assert.Null(parsed.Value.FormKeyValue);
        Assert.Empty(parsed.Refs);
    }

    // Variable properties are indexed by nobody: the walk skips them (and logs), so parse declines.
    [Theory]
    [InlineData(typeof(ScriptVariableProperty))]
    [InlineData(typeof(ScriptVariableListProperty))]
    public void Parse_VariableProperty_ReturnsNull(Type propertyType) =>
        Assert.Null(VmadCodec.Parse((ScriptProperty)System.Activator.CreateInstance(propertyType)!));

    // ---- Parse: arrays ----

    [Fact]
    public void Parse_ArrayOfInt_ReturnsOneItemPerElement()
    {
        var prop = new ScriptIntListProperty { Name = "Counts" };
        prop.Data.Add(1);
        prop.Data.Add(2);

        var parsed = VmadCodec.Parse(prop)!;

        Assert.Equal("ArrayOfInt", parsed.Type);
        Assert.Equal([1, 2], parsed.Items!.Select(i => i.IntValue));
    }

    // Null elements still occupy a row (list position is meaningful) but contribute no reference.
    [Fact]
    public void Parse_ArrayOfObject_ReturnsItemsAndIndexedRefsForNonNullElements()
    {
        var prop = new ScriptObjectListProperty { Name = "Targets" };
        prop.Objects.Add(new ScriptObjectProperty { Alias = -1 });
        var second = new ScriptObjectProperty { Alias = 3 };
        second.Object.SetTo(Target);
        prop.Objects.Add(second);

        var parsed = VmadCodec.Parse(prop)!;

        Assert.Equal(2, parsed.Items!.Count);
        Assert.Null(parsed.Items[0].FormKeyValue);
        Assert.Equal(Target.ToString(), parsed.Items[1].FormKeyValue);
        Assert.Equal((short?)3, parsed.Items[1].AliasValue);
        var reference = Assert.Single(parsed.Refs);
        Assert.Equal("[1]", reference.RelativePath);
    }

    // ---- Parse: structs ----

    [Fact]
    public void Parse_Struct_SerializesMembersAndCollectsMemberRefs()
    {
        var parsed = VmadCodec.Parse(StructProperty("Config", MemberObject("Ref"), new ScriptIntProperty { Name = "Count", Data = 7 }))!;

        Assert.Equal("Struct", parsed.Type);
        Assert.Null(parsed.Items);
        var members = VmadCodec.StructMembers(parsed.StructJson!);
        Assert.Equal(["Ref", "Count"], members.Select(m => m.Name));
        Assert.Equal(7, members[1].IntValue);
        var reference = Assert.Single(parsed.Refs);
        Assert.Equal(@"\Ref", reference.RelativePath);
    }

    // A null Object member must read back with no FormKey, the same as a
    // top-level null Object property (Parse_NullObjectProperty_ReturnsNoValueAndNoRefs) —
    // not the stringified "000000:Null" sentinel a naive unconditional ToString() produces.
    [Fact]
    public void Parse_Struct_NullObjectMember_ReturnsNullFormKeyValue()
    {
        var parsed = VmadCodec.Parse(StructProperty("Config", NullMemberObject("Ref")))!;

        var members = VmadCodec.StructMembers(parsed.StructJson!);
        var refMember = Assert.Single(members);
        Assert.Equal("Object", refMember.Type);
        Assert.Null(refMember.FormKeyValue);
        Assert.Empty(parsed.Refs);
    }

    [Fact]
    public void Parse_ArrayOfStruct_SerializesInstancesAndCollectsIndexedMemberRefs()
    {
        var prop = new ScriptStructListProperty { Name = "Entries" };
        foreach (var name in new[] { "First", "Second" })
        {
            var entry = new ScriptEntryStructs();
            entry.Members.Add(new ScriptStringProperty { Name = "Label", Data = name });
            entry.Members.Add(MemberObject("Ref"));
            prop.Structs.Add(entry);
        }

        var parsed = VmadCodec.Parse(prop)!;

        Assert.Equal("ArrayOfStruct", parsed.Type);
        var instances = VmadJson.DeserializeStructList(parsed.StructJson!);
        Assert.Equal(["First", "Second"], instances.Select(i => i.Members[0].StringValue));
        Assert.Equal([@"[0]\Ref", @"[1]\Ref"], parsed.Refs.Select(r => r.RelativePath));
    }

    // The round trip the codec exists to keep honest: Mutagen → model → Mutagen.
    [Fact]
    public void Parse_ThenApplyValue_RoundTripsAStruct()
    {
        var original = StructProperty(
            "Config",
            new ScriptBoolProperty { Name = "Flag", Data = true },
            new ScriptFloatProperty { Name = "Weight", Data = 1.5f },
            MemberObject("Ref"),
            StructProperty("Nested", new ScriptIntProperty { Name = "Count", Data = 7 }));

        var json = VmadCodec.Parse(original)!.StructJson!;
        var wire = JsonSerializer.SerializeToElement(VmadCodec.StructMembers(json), Wire);

        var rebuilt = new ScriptStructProperty { Name = "Config" };
        Assert.Equal(VmadApplyResult.Applied, VmadCodec.ApplyValue(rebuilt, wire));

        Assert.Equal(json, VmadCodec.Parse(rebuilt)!.StructJson);
    }

    // The same round trip, but the Object member is null — writing a value on a
    // property that reads as null must not be misread as "delete this property".
    [Fact]
    public void Parse_ThenApplyValue_RoundTripsAStructWithNullObjectMember()
    {
        var original = StructProperty("Config", NullMemberObject("Ref"));

        var json = VmadCodec.Parse(original)!.StructJson!;
        var wire = JsonSerializer.SerializeToElement(VmadCodec.StructMembers(json), Wire);

        var rebuilt = new ScriptStructProperty { Name = "Config" };
        Assert.Equal(VmadApplyResult.Applied, VmadCodec.ApplyValue(rebuilt, wire));

        Assert.True(Assert.IsType<ScriptObjectProperty>(Assert.Single(rebuilt.Members).Properties[0]).Object.IsNull);
        Assert.Equal(json, VmadCodec.Parse(rebuilt)!.StructJson);
    }

    // ---- FormKeys in VMAD values ----

    [Fact]
    public void ValueFormKeys_ObjectValue_ReturnsItsFormKey() =>
        Assert.Equal(
            [Target.ToString()],
            VmadCodec.ValueFormKeys(J($"{{\"formKey\":\"{Target}\",\"alias\":1}}")));

    [Fact]
    public void ValueFormKeys_ArrayOfObjectValue_ReturnsEachFormKey() =>
        Assert.Equal(
            [Target.ToString(), "000900:Test.esp"],
            VmadCodec.ValueFormKeys(J($"[{{\"formKey\":\"{Target}\",\"alias\":1}},{{\"formKey\":\"000900:Test.esp\",\"alias\":2}}]")));

    [Theory]
    [InlineData("42")]
    [InlineData("\"text\"")]
    [InlineData("[1,2,3]")]
    [InlineData("{\"alias\":1}")]
    [InlineData("{\"formKey\":null,\"alias\":1}")]
    public void ValueFormKeys_ValueWithoutFormKeys_ReturnsNone(string json) =>
        Assert.Empty(VmadCodec.ValueFormKeys(J(json)));

    // A Struct's value is a bare array of member-node objects (the same shape
    // ApplyStructProperty/TryBuildMemberProperty consume), not a { "members": [...] } wrapper.
    [Fact]
    public void ValueFormKeys_StructValue_ReturnsMemberFormKey() =>
        Assert.Equal(
            [Target.ToString()],
            VmadCodec.ValueFormKeys(J($$"""[{"name":"Target","type":"Object","flags":"","formKeyValue":"{{Target}}","aliasValue":0}]""")));

    [Fact]
    public void ValueFormKeysWithPaths_StructValue_PathIsBackslashMemberName() =>
        Assert.Equal(
            [(@"\Target", Target.ToString())],
            VmadCodec.ValueFormKeysWithPaths(J($$"""[{"name":"Target","type":"Object","flags":"","formKeyValue":"{{Target}}","aliasValue":0}]""")));

    [Fact]
    public void ValueFormKeysWithPaths_StructValueWithNullObjectMember_ReturnsNone() =>
        Assert.Empty(VmadCodec.ValueFormKeysWithPaths(
            J("""[{"name":"Target","type":"Object","flags":"","formKeyValue":null,"aliasValue":-1}]""")));

    [Fact]
    public void ValueFormKeysWithPaths_StructValueWithOnlyScalarMembers_ReturnsNone() =>
        Assert.Empty(VmadCodec.ValueFormKeysWithPaths(
            J("""[{"name":"Count","type":"Int","flags":"","intValue":3}]""")));

    // Nested Struct member (a Struct member that is itself a Struct) recurses arbitrarily deep,
    // mirroring VmadConflictClassifier.CollectMemberRefs' read-side walk.
    [Fact]
    public void ValueFormKeysWithPaths_NestedStructMember_PathIsNestedBackslashPath() =>
        Assert.Equal(
            [(@"\Outer\Inner", Target.ToString())],
            VmadCodec.ValueFormKeysWithPaths(J($$"""
                [{"name":"Outer","type":"Struct","flags":"","members":
                    [{"name":"Inner","type":"Object","flags":"","formKeyValue":"{{Target}}","aliasValue":0}]}]
                """)));

    // ArrayOfStruct: each instance is its own member-node array, walked with an "[i]" prefix so
    // instances resolve independently — no aggregation across sibling instances.
    [Fact]
    public void ValueFormKeysWithPaths_ArrayOfStructValue_PathIsIndexBackslashMemberNamePerInstance() =>
        Assert.Equal(
            [(@"[0]\Target", Target.ToString()), (@"[1]\Target", "000900:Test.esp")],
            VmadCodec.ValueFormKeysWithPaths(J($$"""
                [
                    [{"name":"Target","type":"Object","flags":"","formKeyValue":"{{Target}}","aliasValue":0}],
                    [{"name":"Target","type":"Object","flags":"","formKeyValue":"000900:Test.esp","aliasValue":1}]
                ]
                """)));

    // ---- Helpers ----

    // The API serializes per-plugin subtrees camelCase, which is the shape apply reads back.
    private static readonly JsonSerializerOptions Wire = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private static ScriptObjectProperty MemberObject(string name)
    {
        var obj = new ScriptObjectProperty { Name = name, Alias = 0 };
        obj.Object.SetTo(Target);
        return obj;
    }

    private static ScriptObjectProperty NullMemberObject(string name) =>
        new() { Name = name, Alias = -1 };

    // A Struct's fields live inside a single unnamed ScriptEntry wrapper in the binary format.
    private static ScriptStructProperty StructProperty(string name, params ScriptProperty[] members)
    {
        var wrapper = new ScriptEntry();
        foreach (var m in members) wrapper.Properties.Add(m);
        var prop = new ScriptStructProperty { Name = name };
        prop.Members.Add(wrapper);
        return prop;
    }

    private static Npc NewNpc() => new(FormKey.Factory("000123:Test.esp"), Fallout4Release.Fallout4);

    private static Npc NpcWithScript(string scriptName, params ScriptProperty[] properties)
    {
        var npc = NewNpc();
        var script = new ScriptEntry { Name = scriptName, Flags = ScriptEntry.Flag.Local };
        foreach (var p in properties) script.Properties.Add(p);
        npc.VirtualMachineAdapter = new VirtualMachineAdapter();
        npc.VirtualMachineAdapter.Scripts.Add(script);
        return npc;
    }
}
