using System.Text.Json;
using MEditService.Core.Commands;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Tests.TestSupport.Envelopes;

namespace MEditService.Tests.Edits;

/// <summary>A complex field (array or struct) is written as one atomic value; a payload shaped
/// like a single element of one is refused rather than silently dropped.</summary>
public sealed class ComplexFieldElementEditTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private EditRecordHandler Service() => _mod.EditHandler;

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private string NpcBody() => _mod.Document(_mod.Npc.ToString())!.Body;

    // ── per-element payloads are refused, not silently dropped ────────────────

    [Fact]
    public void KeywordsArray_PerElementPayload_IsRefusedAndWritesNothing()
    {
        var seed = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "Keywords", Json($"[\"{_mod.Keyword}\"]"));
        Assert.True(seed.Applied, seed.Message);
        var before = NpcBody();

        var result = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "Keywords", Json($"\"{_mod.Keyword}\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecRejected, result.Refusal);
        Assert.Contains("Keywords", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, NpcBody());
    }

    [Fact]
    public void WeightStruct_PerMemberPayload_IsRefusedAndWritesNothing()
    {
        var before = NpcBody();

        var result = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "Weight", Json("0.5"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecRejected, result.Refusal);
        Assert.Contains("Weight", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, NpcBody());
    }

    [Fact]
    public void OmodPropertiesArray_PerSubFieldPayload_IsRefusedAndWritesNothing()
    {
        using var omod = OmodMod(out var armorMod);
        var before = omod.Body(armorMod);

        var result = omod.EditHandler.Set(omod.Plugin, armorMod.ToString(), "Properties", Json("99"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecRejected, result.Refusal);
        Assert.Contains("Properties", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, omod.Body(armorMod));
    }

    // ── the whole-value write the webview now sends does land ─────────────────

    [Fact]
    public void KeywordsArray_WholeArrayWrite_LandsInTheSourceDocument()
    {
        var result = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "Keywords", Json($"[\"{_mod.Keyword}\"]"));

        Assert.True(result.Applied, result.Message);
        Assert.Contains(_mod.Keyword.ToString(), NpcBody(), StringComparison.Ordinal);
    }

    [Fact]
    public void WeightStruct_WholeObjectWrite_LandsInTheSourceDocument()
    {
        var result = Service().Set(
            _mod.Plugin, _mod.Npc.ToString(), "Weight", Json("""{"Thin":0.5,"Fat":0.25,"Muscular":0.75}"""));

        Assert.True(result.Applied, result.Message);
        var body = NpcBody();
        Assert.Contains("0.5", body, StringComparison.Ordinal);
        Assert.Contains("0.25", body, StringComparison.Ordinal);
    }

    [Fact]
    public void FactionsStructArray_WholeArrayWriteWithAChangedSubField_LandsInTheSourceDocument()
    {
        // A real, resolvable Faction to point at: an element's FormLink sub-field is validated like any
        // other, so a null or invented one would refuse for an unrelated reason.
        var faction = _mod.CreateHandler.CreateRecord(_mod.Plugin, "fact", "FixtureFaction");
        Assert.True(faction.Applied, faction.Message);

        var seed = Service().Set(
            _mod.Plugin, _mod.Npc.ToString(), "Factions",
            Json($"[{{\"Faction\":\"{faction.NewFormKey}\",\"Rank\":1}}]"));
        Assert.True(seed.Applied, seed.Message);

        var result = Service().Set(
            _mod.Plugin, _mod.Npc.ToString(), "Factions",
            Json($"[{{\"Faction\":\"{faction.NewFormKey}\",\"Rank\":9}}]"));

        Assert.True(result.Applied, result.Message);
        Assert.Contains("\"Rank\": 9", NpcBody(), StringComparison.Ordinal);
    }

    // ── write-side polymorphism — OMOD properties' element type is abstract ──────────────────

    [Fact]
    public void OmodPropertiesArray_MissingDiscriminator_IsRefusedAndWritesNothing()
    {
        using var omod = OmodMod(out var armorMod);
        var before = omod.Body(armorMod);

        var result = omod.EditHandler.Set(omod.Plugin, armorMod.ToString(), "Properties",
            Json("""[{"Property":"BodyPart","Step":1.0,"Value":5,"Value2":6,"FunctionType":"Set"}]"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.DiscriminatorInvalid, result.Refusal);
        Assert.Contains("Properties", result.Message, StringComparison.Ordinal);
        Assert.Contains("MutagenObjectType", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, omod.Body(armorMod));
    }

    [Fact]
    public void OmodPropertiesArray_UnrecognizedDiscriminator_IsRefusedAndWritesNothing()
    {
        using var omod = OmodMod(out var armorMod);
        var before = omod.Body(armorMod);

        var result = omod.EditHandler.Set(omod.Plugin, armorMod.ToString(), "Properties",
            Json("""[{"MutagenObjectType":"NotARealLeaf","Property":"BodyPart","Step":1.0,"Value":5}]"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.DiscriminatorInvalid, result.Refusal);
        Assert.Contains("Properties", result.Message, StringComparison.Ordinal);
        Assert.Contains("MutagenObjectType", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, omod.Body(armorMod));
    }

    [Fact]
    public void OmodPropertiesArray_WholeArrayWriteWithIntProperty_LandsWithConcreteTypeAndValuePreserved()
    {
        using var omod = OmodMod(out var armorMod);

        var result = omod.EditHandler.Set(omod.Plugin, armorMod.ToString(), "Properties",
            Json("""[{"MutagenObjectType":"ObjectModIntProperty<Armor+Property>","Property":"BodyPart","Step":1.0,"Value":42,"Value2":7,"FunctionType":"Set"}]"""));

        Assert.True(result.Applied, result.Message);
        var body = omod.Body(armorMod);
        Assert.Contains("ObjectModIntProperty", body, StringComparison.Ordinal);
        Assert.Contains("\"Value\": 42", body, StringComparison.Ordinal);
        Assert.Contains("\"Value2\": 7", body, StringComparison.Ordinal);
    }

    [Fact]
    public void OmodPropertiesArray_WholeArrayWriteWithFloatProperty_RoundTripsAsFloatNotHardcodedInt()
    {
        using var omod = OmodMod(out var armorMod);

        var result = omod.EditHandler.Set(omod.Plugin, armorMod.ToString(), "Properties",
            Json("""[{"MutagenObjectType":"ObjectModFloatProperty<Armor+Property>","Property":"Weight","Step":2.0,"Value":1.5,"Value2":2.5,"FunctionType":"Set"}]"""));

        Assert.True(result.Applied, result.Message);
        var body = omod.Body(armorMod);
        Assert.Contains("ObjectModFloatProperty", body, StringComparison.Ordinal);
        Assert.DoesNotContain("ObjectModIntProperty", body, StringComparison.Ordinal);
        Assert.Contains("\"Value\": 1.5", body, StringComparison.Ordinal);
    }

    [Fact]
    public void OmodPropertiesArray_ArrayAdd_AppendsOneElementOfTheFirstLeafTheSchemaLists()
    {
        using var omod = OmodMod(out var armorMod);

        var result = omod.EditHandler.Edit(omod.Plugin, armorMod.ToString(), AddAt(Member("Properties")));

        Assert.Equal(RecordEditRefusal.None, result.Refusal);
        Assert.True(result.Applied, result.Message);

        var properties = JsonDocument.Parse(omod.Body(armorMod)).RootElement.GetProperty("Properties");
        Assert.Equal(2, properties.GetArrayLength());
        // The discriminator's own first value is the codec's spelling of the leaf class.
        Assert.Equal(
            SharedSchemaReflector.FirstArrayElementLeaf("omod", "Properties", "MutagenObjectType"),
            properties[1].GetProperty("MutagenObjectType").GetString());
    }

    [Fact]
    public void OmodPropertiesArray_WholeArrayWriteReordered_PreservesEachElementsOwnConcreteType()
    {
        using var omod = OmodMod(out var armorMod);
        var seed = omod.EditHandler.Set(omod.Plugin, armorMod.ToString(), "Properties", Json("""
            [
                {"MutagenObjectType":"ObjectModIntProperty<Armor+Property>","Property":"BodyPart","Step":1.0,"Value":5,"Value2":6,"FunctionType":"Set"},
                {"MutagenObjectType":"ObjectModFloatProperty<Armor+Property>","Property":"Weight","Step":2.0,"Value":1.5,"Value2":2.5,"FunctionType":"Set"}
            ]
            """));
        Assert.True(seed.Applied, seed.Message);

        // Move Up on the second element == the whole array resent with the same two elements swapped.
        var result = omod.EditHandler.Set(omod.Plugin, armorMod.ToString(), "Properties", Json("""
            [
                {"MutagenObjectType":"ObjectModFloatProperty<Armor+Property>","Property":"Weight","Step":2.0,"Value":1.5,"Value2":2.5,"FunctionType":"Set"},
                {"MutagenObjectType":"ObjectModIntProperty<Armor+Property>","Property":"BodyPart","Step":1.0,"Value":5,"Value2":6,"FunctionType":"Set"}
            ]
            """));

        Assert.True(result.Applied, result.Message);
        var body = omod.Body(armorMod);
        var floatIdx = body.IndexOf("ObjectModFloatProperty", StringComparison.Ordinal);
        var intIdx = body.IndexOf("ObjectModIntProperty", StringComparison.Ordinal);
        Assert.True(floatIdx >= 0, body);
        Assert.True(intIdx >= 0, body);
        Assert.True(floatIdx < intIdx, $"Float element should now precede Int in:\n{body}");
    }

    [Fact]
    public void OmodPropertiesArray_WholeArrayWriteAddingANewElement_LandsAlongsideTheExisting()
    {
        using var omod = OmodMod(out var armorMod);

        var result = omod.EditHandler.Set(omod.Plugin, armorMod.ToString(), "Properties", Json("""
            [
                {"MutagenObjectType":"ObjectModIntProperty<Armor+Property>","Property":"BodyPart","Step":1.0,"Value":5,"Value2":6,"FunctionType":"Set"},
                {"MutagenObjectType":"ObjectModBoolProperty<Armor+Property>","Property":"Value","Step":3.0,"Value":true,"FunctionType":"Set"}
            ]
            """));

        Assert.True(result.Applied, result.Message);
        var body = omod.Body(armorMod);
        Assert.Contains("ObjectModIntProperty", body, StringComparison.Ordinal);
        Assert.Contains("ObjectModBoolProperty", body, StringComparison.Ordinal);
    }

    [Fact]
    public void OmodPropertiesArray_RemoveShapedWholeArrayWrite_PreservesSurvivorsValue()
    {
        using var omod = OmodMod(out var armorMod);
        var seed = omod.EditHandler.Set(omod.Plugin, armorMod.ToString(), "Properties", Json("""
            [
                {"MutagenObjectType":"ObjectModIntProperty<Armor+Property>","Property":"BodyPart","Step":1.0,"Value":5,"Value2":6,"FunctionType":"Set"},
                {"MutagenObjectType":"ObjectModFloatProperty<Armor+Property>","Property":"Weight","Step":2.0,"Value":1.5,"Value2":2.5,"FunctionType":"Set"}
            ]
            """));
        Assert.True(seed.Applied, seed.Message);

        // Remove on the second element == the whole array resent holding only the survivor, verbatim.
        var result = omod.EditHandler.Set(omod.Plugin, armorMod.ToString(), "Properties",
            Json("""[{"MutagenObjectType":"ObjectModIntProperty<Armor+Property>","Property":"BodyPart","Step":1.0,"Value":5,"Value2":6,"FunctionType":"Set"}]"""));

        Assert.True(result.Applied, result.Message);
        var body = omod.Body(armorMod);
        Assert.Contains("\"Value\": 5", body, StringComparison.Ordinal);
        Assert.Contains("\"Value2\": 6", body, StringComparison.Ordinal);
        Assert.DoesNotContain("ObjectModFloatProperty", body, StringComparison.Ordinal);
    }

    // FunctionType is an enum on every OMOD property leaf, over that leaf's own domain: MultAndAdd
    // is a float function the bool leaf has no member for, so the switch drops it.
    [Fact]
    public void SwitchingAnOmodPropertyLeaf_DropsAMemberWhoseDomainTheIncomingLeafLacks()
    {
        using var omod = OmodMod(out var armorMod);
        var seed = omod.EditHandler.Set(omod.Plugin, armorMod.ToString(), "Properties", Json("""
            [{"MutagenObjectType":"ObjectModFloatProperty<Armor+Property>","Property":"Weight","Step":2.0,"Value":1.5,"Value2":2.5,"FunctionType":"MultAndAdd"}]
            """));
        Assert.True(seed.Applied, seed.Message);

        var result = omod.EditHandler.Edit(omod.Plugin, armorMod.ToString(),
            SetAt(Json("\"ObjectModBoolProperty<Armor+Property>\""), Member("Properties"), At(0), Member("MutagenObjectType")));

        Assert.True(result.Applied, result.Message);
        var element = JsonDocument.Parse(omod.Body(armorMod)).RootElement.GetProperty("Properties")[0];
        Assert.Equal("ObjectModBoolProperty<Armor+Property>", element.GetProperty("MutagenObjectType").GetString());
        Assert.False(element.TryGetProperty("FunctionType", out _), "MultAndAdd is not a bool function");
    }

    // ── a declined member fails the whole struct/array write, not just that member ───────────

    [Fact]
    public void WeightStruct_OneMemberValueDeclined_RefusesTheWholeStructWrite()
    {
        var before = NpcBody();

        var result = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "Weight",
            Json("""{"Thin":"not-a-number","Fat":0.5,"Muscular":0.3}"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecRejected, result.Refusal);
        Assert.Contains("Weight", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, NpcBody());
    }

    // An OMOD carries a struct-element array with an abstract element type, which the shared
    // fixture's NPC shape has no equivalent of.
    private static SourceModFixture OmodMod(out FormKey armorMod)
    {
        var formKey = FormKey.Null;
        var fixture = SourceModFixture.Tracked("Omod503.esp", "Omod503Mod", mod =>
        {
            var armor = new ArmorModification(mod.GetNextFormKey("ArmorMod503"), Fallout4Release.Fallout4)
            {
                EditorID = "ArmorMod503",
            };
            armor.Properties.Add(new ObjectModIntProperty<Armor.Property> { Property = Armor.Property.BodyPart, Step = 1f });
            mod.ObjectModifications.Add(armor);
            formKey = armor.FormKey;
        });
        armorMod = formKey;
        return fixture;
    }
}
