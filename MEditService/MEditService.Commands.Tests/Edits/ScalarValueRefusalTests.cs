using System.Text.Json;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>A value the column's own converter declines is refused before anything is written: the
/// edit door is a shape gate, and a scalar of the wrong shape never reaches the tree.</summary>
public sealed class ScalarValueRefusalTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private EditRecordHandler Service() => _mod.EditHandler;

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private string NpcBody() => _mod.Document(_mod.Npc.ToString()).Require().Body;

    // ── converter-declined scalar values ───────────────────────────────────────

    [Fact]
    public void HeightMaxFloatColumn_NonNumericString_IsRefusedAndWritesNothing()
    {
        var before = NpcBody();

        var result = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("\"tall\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecRejected, result.Refusal);
        Assert.Contains("HeightMax", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, NpcBody());
    }

    [Fact]
    public void FlagsColumn_ArbitraryString_IsRefusedAndWritesNothing()
    {
        var before = NpcBody();

        var result = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "Flags", Json("\"NotANumber\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecRejected, result.Refusal);
        Assert.Contains("Flags", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, NpcBody());
    }

    [Fact]
    public void AggressionEnumColumn_UnrecognisedMemberName_IsRefusedAndWritesNothing()
    {
        var before = NpcBody();

        var result = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "Aggression", Json("\"NotARealAggressionLevel\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecRejected, result.Refusal);
        Assert.Contains("Aggression", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, NpcBody());
    }

    [Fact]
    public void EnergyLevelByteColumn_OutOfRangeValue_IsRefusedAndWritesNothing()
    {
        var before = NpcBody();

        var result = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "EnergyLevel", Json("4096"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecRejected, result.Refusal);
        Assert.Contains("EnergyLevel", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, NpcBody());
    }

    [Fact]
    public void HeightMaxFloatColumn_ValidValue_StillReportsApplied()
    {
        var result = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.True(result.Applied, result.Message);
        Assert.Contains("0.75", NpcBody(), StringComparison.Ordinal);
    }

    // ── missing property on this record's own runtime type ────────────────────

    [Fact]
    public void OutputCharColumn_OnGlobalShortInstance_IsRefusedAsFieldNotFound()
    {
        using var glob = GlobMod(out var globalShort, out var globalFloat);
        var before = glob.Body(globalShort);

        var result = glob.EditHandler.Set(glob.Plugin, globalShort.ToString(), "OutputChar", Json("true"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
        Assert.Equal(before, glob.Body(globalShort));
    }

    [Fact]
    public void OutputCharColumn_OnGlobalFloatInstance_StillReportsApplied()
    {
        using var glob = GlobMod(out var globalShort, out var globalFloat);

        var result = glob.EditHandler.Set(glob.Plugin, globalFloat.ToString(), "OutputChar", Json("true"));

        Assert.True(result.Applied, result.Message);
    }

    // ── FormLink column: malformed / wrongly-shaped value ──────────────────────

    // Shape, not resolution: a string that is not a FormKey is not a FormLink at all, and the codec
    // is what says so.
    [Fact]
    public void RaceFormLinkColumn_MalformedString_IsRefusedByTheCodec()
    {
        var result = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "Race", Json("\"not-a-formkey\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecRejected, result.Refusal);
    }

    [Fact]
    public void VoiceFormLinkColumn_NonStringJsonValue_IsRefusedAndWritesNothing()
    {
        var result = Service().Set(_mod.Plugin, _mod.Npc.ToString(), "Voice", Json("42"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecRejected, result.Refusal);
        Assert.Contains("Voice", result.Message, StringComparison.Ordinal);
    }

    // ── An OMOD carrying one property, for the sub-field-decline slice below ──

    [Fact]
    public void OmodPropertiesArray_ValueItsLeafCannotHold_RefusesTheWholeArrayWrite()
    {
        using var omod = OmodMod(out var armorMod);
        var before = omod.Body(armorMod);

        var result = omod.EditHandler.Set(omod.Plugin, armorMod.ToString(), "Properties",
            Json("""[{"MutagenObjectType":"ObjectModIntProperty<Armor+Property>","Property":"BodyPart","Step":1.0,"Value":"not-a-number","Value2":7,"FunctionType":"Set"}]"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecRejected, result.Refusal);
        Assert.Contains("Properties", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, omod.Body(armorMod));
    }

    // The record-level union's "column on the schema, not on this class" shape, which no NPC has.
    // GlobalShort rather than GlobalBool: Mutagen's GlobalBool writes FLTV as one byte and reads
    // back expecting four.
    private static SourceModFixture GlobMod(out FormKey globalShort, out FormKey globalFloat)
    {
        var (shortKey, floatKey) = (FormKey.Null, FormKey.Null);
        var fixture = SourceModFixture.Tracked("Glob532.esp", "Glob532Mod", mod =>
        {
            var shortGlob = new GlobalShort(mod.GetNextFormKey("GlobShort532"), Fallout4Release.Fallout4)
            {
                EditorID = "GlobShort532",
                Data = 5,
            };
            var floatGlob = new GlobalFloat(mod.GetNextFormKey("GlobFloat532"), Fallout4Release.Fallout4)
            {
                EditorID = "GlobFloat532",
                Data = 1.25f,
            };
            mod.Globals.Add(shortGlob);
            mod.Globals.Add(floatGlob);
            (shortKey, floatKey) = (shortGlob.FormKey, floatGlob.FormKey);
        });
        (globalShort, globalFloat) = (shortKey, floatKey);
        return fixture;
    }

    private static SourceModFixture OmodMod(out FormKey armorMod)
    {
        var formKey = FormKey.Null;
        var fixture = SourceModFixture.Tracked("Omod532.esp", "Omod532Mod", mod =>
        {
            var armor = new ArmorModification(mod.GetNextFormKey("ArmorMod532"), Fallout4Release.Fallout4)
            {
                EditorID = "ArmorMod532",
            };
            armor.Properties.Add(new ObjectModIntProperty<Armor.Property> { Property = Armor.Property.BodyPart, Step = 1f });
            mod.ObjectModifications.Add(armor);
            formKey = armor.FormKey;
        });
        armorMod = formKey;
        return fixture;
    }
}
